import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegPath, ingest, run } from '../apps/worker/engine.mjs';
import { prepareVersionOverview, storeSceneCuts } from '../apps/worker/overview.mjs';

test('import-time scene cuts are reused by the overview and match a separate decode of the proxy', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vi-overview-cuts-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.mp4'), proxy = join(directory, 'proxy.mp4'), scoresPath = join(directory, 'scores dir, it\'s [odd]; ok', 'scene:scores.txt');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=2', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=25:d=1.5', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  await mkdir(join(directory, 'scores dir, it\'s [odd]; ok')); // filtergraph-special characters in the score path
  const progress = [];
  const info = await ingest(source, proxy, join(directory, 'thumb.jpg'), { sceneScoresPath: scoresPath, onProgress: value => progress.push(value) });
  assert.ok(Math.abs(info.durationFrames - 165) <= 1, 'about 5.5 s at 30 fps'); assert.ok(progress.length > 1 && progress.every(value => value >= 0 && value <= 1), 'normalization keeps reporting bounded progress while scoring scenes');
  const stored = await storeSceneCuts({ videoPath: proxy, durationFrames: info.durationFrames, scores: await readFile(scoresPath, 'utf8'), directory: join(directory, 'overviews'), source: 'import-normalization' });
  assert.deepEqual(stored, [60, 120], 'red→blue and blue→green cuts on the canonical 30 fps timeline');

  const reused = await prepareVersionOverview({ versionId: 'v1', videoPath: proxy, durationFrames: info.durationFrames, directory: join(directory, 'overviews') });
  assert.equal(reused.shots.source, 'import-normalization'); assert.equal(reused.diagnostics.sceneCutRuns, 0, 'no second full decode');
  assert.deepEqual(reused.shots.list.map(shot => [shot.frameIn, shot.frameOut]), [[0, 60], [60, 120], [120, info.durationFrames]]);
  assert.equal(reused.grid.cells.length, 12);

  const decoded = await prepareVersionOverview({ versionId: 'v1', videoPath: proxy, durationFrames: info.durationFrames, directory: join(directory, 'no-precomputed') });
  assert.equal(decoded.shots.source, 'version-decode'); assert.equal(decoded.diagnostics.sceneCutRuns, 1);
  assert.deepEqual(decoded.shots.cuts, reused.shots.cuts, 'the fallback decode estimates the same cuts');

  // A changed version file invalidates both the overview and the stored cuts.
  await utimes(proxy, new Date(), new Date(Date.now() + 5000));
  const changed = await prepareVersionOverview({ versionId: 'v1', videoPath: proxy, durationFrames: info.durationFrames, directory: join(directory, 'overviews') });
  assert.equal(changed.cacheHit, false); assert.equal(changed.shots.source, 'version-decode');
});
