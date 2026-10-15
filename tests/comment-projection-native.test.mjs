import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ffmpegPath, run, renderVideo } from '../apps/worker/engine.mjs';
import { projectComment, mapFrameBetweenVersions } from '../packages/core/comment-projection.mjs';

test('projected cut-and-speed context lands on the same actual decoded scene', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-interference-projection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.mp4'), outputPath = join(directory, 'edited.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=6', '-vf', "drawbox=x=0:y=0:w=60:h=60:color=red:t=fill:enable='gte(t,2.4)*lt(t,2.7)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', sourcePath]);
  const asset = { durationFrames: 180, fps: 30, width: 320, height: 180, hasAudio: false };
  const result = await renderVideo({ asset, sourcePath, outputPath, workingDirectory: join(directory, 'job'), ops: [
    { id: 'cut', type: 'cut', params: {}, sourceRanges: [{ frameIn: 0, frameOut: 15 }], status: 'approved' },
    { id: 'speed', type: 'speed', params: { factor: 2 }, sourceRanges: [{ frameIn: 36, frameOut: 54 }], status: 'approved' }
  ] });
  const from = { id: 'original', assetId: 'asset', durationFrames: 180, timelineMap: [{ sourceIn: 0, sourceOut: 180, outputIn: 0, outputOut: 180, speed: 1, volume: 1 }] };
  const to = { id: 'edited', assetId: 'asset', durationFrames: result.durationFrames, timelineMap: result.timelineMap };
  const projection = projectComment({ versionId: from.id, frameIn: 72, frameOut: 81, contextFrame: 75, sourceRanges: [{ frameIn: 72, frameOut: 81 }] }, from, to);
  assert.equal(result.durationFrames, 156); assert.deepEqual(projection.ranges, [{ frameIn: 48, frameOut: 57, sourceIn: 72, sourceOut: 81 }]); assert.equal(projection.contextFrame, 51); assert.equal(mapFrameBetweenVersions(to, from, 51), 75);
  for (const [frame, expected] of [[45, 'blue'], [projection.contextFrame, 'red'], [57, 'blue']]) {
    const still = join(directory, `frame-${frame}.png`);
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', outputPath, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', still]);
    const pixels = await sharp(still).removeAlpha().raw().toBuffer(), index = (20 * 320 + 20) * 3, rgb = [...pixels.subarray(index, index + 3)];
    assert.ok(expected === 'red' ? rgb[0] > 180 && rgb[2] < 30 : rgb[2] > 180 && rgb[0] < 30, `${expected} marker at projected frame ${frame}: ${rgb}`);
  }
  assert.equal(mapFrameBetweenVersions(from, to, 7), null, 'deleted context must not land on the first surviving frame');
});
