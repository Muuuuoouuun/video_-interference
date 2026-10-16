import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ffmpegPath, run } from '../apps/worker/engine.mjs';
import { measureFilmstrip, verifyFilmstripPixels } from '../scripts/verify-filmstrip.mjs';

test('native filmstrip advertises exact frames, keeps distinct scenes and starts no FFmpeg on disk cache reuse', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-interference-filmstrip-native-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=320x180:r=30:d=6', '-vf', "geq=r='mod(N*7,256)':g='mod(N*13,256)':b='mod(N*19,256)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath]);
  const result = await measureFilmstrip({ versionId: 'frame-colors', videoPath: sourcePath, durationFrames: 180, directory: join(directory, 'measured') });
  assert.deepEqual(result.cold.result.frames, [7, 22, 37, 52, 67, 82, 97, 112, 127, 142, 157, 172]);
  const checks = await verifyFilmstripPixels({ strip: result.cold.result, videoPath: sourcePath, directory: join(directory, 'reference') });
  const colors = new Set();
  for (const cell of checks) colors.add((await sharp(cell.referencePath).extract({ left: 80, top: 45, width: 1, height: 1 }).raw().toBuffer()).toString('hex'));
  assert.equal(colors.size, 12, 'The fixture must distinguish all sampled frames; one repeated poster cannot pass.');
  assert.equal(result.cold.nativeCalls.length, 1); assert.equal(result.warm.nativeCalls.length, 0);
});

test('long filmstrip skips its unused prefix while matching every original frame', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vi-long-filmstrip-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=60', '-c:v', 'libx264', '-g', '47', '-pix_fmt', 'yuv420p', sourcePath]);
  const result = await measureFilmstrip({ versionId: 'long', videoPath: sourcePath, durationFrames: 1800, directory: join(directory, 'measured') });
  assert.equal(result.cold.result.frames[0], 75, 'first sample permits a whole-second prefix seek');
  const checks = await verifyFilmstripPixels({ strip: result.cold.result, videoPath: sourcePath, directory: join(directory, 'reference') });
  assert.equal(checks.length, 12);
  assert.equal(result.cold.nativeCalls.length, 1); assert.equal(result.warm.nativeCalls.length, 0);
});

test('native portrait filmstrip preserves aspect and black padding for every advertised sample', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-interference-filmstrip-portrait-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'portrait.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=magenta:s=180x320:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath]);
  const result = await measureFilmstrip({ versionId: 'portrait', videoPath: sourcePath, durationFrames: 30, directory: join(directory, 'measured') });
  const checks = await verifyFilmstripPixels({ strip: result.cold.result, videoPath: sourcePath, directory: join(directory, 'reference') });
  const left = [...await sharp(checks[0].referencePath).extract({ left: 10, top: 45, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  const center = [...await sharp(checks[0].referencePath).extract({ left: 80, top: 45, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  assert.deepEqual(left, [0, 0, 0]); assert.ok(center[0] > 200 && center[1] < 30 && center[2] > 200);
});
