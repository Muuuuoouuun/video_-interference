import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { verifyLayerRevisions } from '../scripts/verify-layer-revisions.mjs';
import { ffmpegPath, renderVideo, run } from '../apps/worker/engine.mjs';
import { resolveLayerSnapshot } from '../packages/core/layer-snapshot.mjs';

test('native layer replacement, removal and an older branch preserve timing, stack order and source/version bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-interference-layers-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x303030:s=320x180:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath]);
  const report = await verifyLayerRevisions({ sourcePath, directory: join(directory, 'outputs'), durationFrames: 90 });
  assert.equal(report.checks.length, 14);
  assert.ok(report.sourcePreserved && report.previousVersionFilesPreserved && report.parentSnapshotsPreserved);
});

test('native subtitle replacement changes text color without leaving the former color or changing the old version', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-interference-subtitle-layer-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x303030:s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath]);
  const asset = { durationFrames: 90, width: 640, height: 360, fps: 30, hasAudio: false };
  const before = [{ id: 'original-subtitle', type: 'subtitle', params: { kind: 'text', text: 'MOON', color: '#ff0000' }, region: { x: .1, y: .6, w: .8, h: .3 }, sourceRanges: [{ frameIn: 15, frameOut: 75 }], status: 'approved' }];
  const beforeJson = JSON.stringify(before);
  const after = resolveLayerSnapshot(before, [{ ...structuredClone(before[0]), id: 'green-subtitle', params: { ...before[0].params, color: '#00ff00' }, layerId: 'original-subtitle', layerChange: { action: 'replace', targetLayerId: 'original-subtitle', targetOpId: 'original-subtitle' } }]);
  const oldPath = join(directory, 'old.mp4'), newPath = join(directory, 'new.mp4');
  await renderVideo({ asset, sourcePath, ops: before, outputPath: oldPath, workingDirectory: join(directory, 'old-job') });
  const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
  const oldHash = await hash(oldPath);
  await renderVideo({ asset, sourcePath, ops: after, outputPath: newPath, workingDirectory: join(directory, 'new-job') });
  const counts = [];
  for (const [name, path] of [['old', oldPath], ['new', newPath]]) {
    const png = join(directory, `${name}.png`);
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path, '-vf', 'select=eq(n\\,45)', '-frames:v', '1', png]);
    const pixels = await sharp(png).removeAlpha().raw().toBuffer();
    let red = 0, green = 0;
    for (let index = 0; index < pixels.length; index += 3) {
      const [r, g, b] = pixels.subarray(index, index + 3);
      if (r > 80 && r > g * 2 && r > b * 2) red++;
      if (g > 80 && g > r * 2 && g > b * 2) green++;
    }
    counts.push({ name, red, green });
  }
  assert.ok(counts[0].red > 50 && counts[0].green < 5, JSON.stringify(counts));
  assert.ok(counts[1].green > 50 && counts[1].red < 5, JSON.stringify(counts));
  assert.equal(await hash(oldPath), oldHash);
  assert.equal(JSON.stringify(before), beforeJson);
});
