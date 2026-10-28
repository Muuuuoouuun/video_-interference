import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCanonicalFrames, planCanonicalFrameRuns } from '../apps/worker/canonical-frames.mjs';
import { ffmpegPath, run } from '../apps/worker/engine.mjs';
import { mapLimit } from '../apps/worker/parallel.mjs';

test('decode runs split only where a fresh seek is cheaper than decoding the gap', () => {
  assert.deepEqual(planCanonicalFrameRuns([0, 1, 121, 242, 400]), [[0, 1, 121], [242], [400]]);
  assert.deepEqual(planCanonicalFrameRuns([5, 600, 601], { gapFrames: 30 }), [[5], [600, 601]]);
  assert.deepEqual(planCanonicalFrameRuns([0, 1, 2, 3], { maxFrames: 2 }), [[0, 1], [2, 3]], 'one run never grows without bound');
  for (const frames of [[], [2, 1], [1, 1], [-1]]) assert.throws(() => planCanonicalFrameRuns(frames));
});

test('mapLimit keeps input order, bounds concurrency and stops siblings after the first failure', async () => {
  let active = 0, peak = 0;
  const results = await mapLimit([30, 5, 20, 1, 10], 2, async (delay, index) => {
    active++; peak = Math.max(peak, active);
    await new Promise(done => setTimeout(done, delay)); active--; return index * 10;
  });
  assert.deepEqual(results, [0, 10, 20, 30, 40]); assert.equal(peak, 2);
  const settled = [];
  await assert.rejects(mapLimit([0, 1, 2], 3, async (item, index, signal) => {
    if (index === 0) throw new Error('first failed');
    await new Promise(done => { const timer = setTimeout(done, 1000); signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true }); });
    settled.push(index);
  }), /first failed/);
  assert.deepEqual(settled.sort(), [1, 2], 'started siblings settle before the failure is reported');
  const outer = new AbortController(); outer.abort(new Error('canceled'));
  await assert.rejects(mapLimit([1], 1, async (item, index, signal) => { signal.throwIfAborted(); }, outer.signal), /canceled/);
});

test('multi-run native extraction returns the exact frames of a decode from frame zero', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vi-frame-runs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'canonical.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=20', '-c:v', 'libx264', '-g', '47', '-keyint_min', '47', '-sc_threshold', '0', '-bf', '3', '-pix_fmt', 'yuv420p', source]);
  const frames = [0, 29, 30, 200, 201, 389, 390, 451, 599];
  assert.ok(planCanonicalFrameRuns(frames).length >= 3, 'the fixture exercises several seeks');
  await mkdir(join(directory, 'reference')); await mkdir(join(directory, 'runs'));
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', source, '-map', '0:v:0', '-vf', `select=${frames.map(frame => `eq(n\\,${frame})`).join('+')}`, '-fps_mode', 'vfr', '-frames:v', String(frames.length), '-start_number', '0', join(directory, 'reference', '%03d.png')]);
  const extracted = await extractCanonicalFrames({ videoPath: source, frames, directory: join(directory, 'runs'), extension: 'png', concurrency: 3 });
  assert.equal(extracted.paths.length, frames.length);
  for (let index = 0; index < frames.length; index++) assert.deepEqual(await readFile(extracted.paths[index]), await readFile(join(directory, 'reference', `${String(index).padStart(3, '0')}.png`)), `exact pixels at canonical frame ${frames[index]}`);
  const beyond = await extractCanonicalFrames({ videoPath: source, frames: [10, 900], directory: join(directory, 'runs'), extension: 'png' });
  assert.ok(beyond.paths[0], 'a valid run still returns its frame'); assert.equal(beyond.paths[1], null, 'a frame past EOF is reported missing instead of shifted');
  assert.ok((await readdir(join(directory, 'runs'))).every(name => /^[0-9a-f]{8}-run\d{4}-\d{6}\.png$/.test(name)));
});
