import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sampleFilmstripFrames, prepareFilmstrip, readFilmstripCache } from '../apps/worker/filmstrip.mjs';
import { ffmpegPath, run } from '../apps/worker/engine.mjs';

test('filmstrip samples every short frame or the midpoint of twelve equal timeline bins', () => {
  assert.deepEqual(sampleFilmstripFrames(1), [0]); assert.deepEqual(sampleFilmstripFrames(3), [0, 1, 2]);
  assert.deepEqual(sampleFilmstripFrames(12), Array.from({ length: 12 }, (_, index) => index));
  assert.deepEqual(sampleFilmstripFrames(120), Array.from({ length: 12 }, (_, index) => index * 10 + 5));
  for (const duration of [13, 31, 107, 18_000, 72_000]) { const frames = sampleFilmstripFrames(duration); assert.equal(frames.length, 12); assert.equal(new Set(frames).size, 12); assert.ok(frames.every((frame, index) => frame === Math.floor((index + 0.5) * duration / 12) && frame >= 0 && frame < duration)); }
  for (const duration of [0, -1, 1.1, NaN, Infinity, 72_001, '30']) assert.throws(() => sampleFilmstripFrames(duration), /유효하지/);
});

test('filmstrip cache ignores incomplete files and rejects mismatched or absent source media', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'filmstrip-unit-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const videoPath = join(directory, 'source.mp4'), cache = join(directory, 'cache');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=90x160:r=30:d=0.1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath]);
  const options = { versionId: 'version_short', videoPath, durationFrames: 3, directory: cache };
  assert.equal(await readFilmstripCache(options), null);
  const result = await prepareFilmstrip(options); assert.equal(result.cacheHit, false); assert.equal(result.frames.length, 3);
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  await writeFile(result.manifestPath, JSON.stringify({ ...manifest, frames: [2, 1, 0] })); assert.equal(await readFilmstripCache(options), null);
  await writeFile(result.manifestPath, JSON.stringify(manifest)); await writeFile(result.imagePath, 'truncated'); assert.equal(await readFilmstripCache(options), null);
  const repaired = await prepareFilmstrip(options); assert.equal(repaired.cacheHit, false); assert.equal((await readFilmstripCache(options)).cacheHit, true);
  await assert.rejects(prepareFilmstrip({ ...options, versionId: 'version_wrong', durationFrames: 90 }), /프레임이 맞지/);
  assert.ok((await readdir(cache)).every(name => !name.startsWith('.filmstrip-')), 'failed extraction cleans its staging files');
  await assert.rejects(prepareFilmstrip({ ...options, videoPath: join(directory, 'missing.mp4') }), error => error.status === 404);
  const controller = new AbortController(); controller.abort(); await assert.rejects(prepareFilmstrip({ ...options, signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal((await readFilmstripCache(options)).cacheHit, true, 'cancellation does not erase a completed cache');
});
