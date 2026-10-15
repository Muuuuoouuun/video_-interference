import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import sharp from 'sharp';
import { ffmpegPath, ingest, probe, renderVideo, run } from '../apps/worker/engine.mjs';
import { projectDrawings } from '../packages/core/drawing-anchors.mjs';
import { createDrawingHistoryStore, drawingsEqual } from '../packages/core/drawing-history.mjs';
import { translateDrawing } from '../packages/core/overlay-geometry.mjs';

// Optional real-media check: node scripts/verify-drawing-scenes.mjs SOURCE.mp4 [OUTPUT_DIRECTORY]
// Uses new QA outputs only; it does not import into or modify the active project.
assert.ok(process.argv[2], 'Provide a local video at least 12 seconds long.');
const sourcePath = resolve(process.argv[2]);
const directory = resolve(process.argv[3] || 'storage/qa/drawing-scenes');
await mkdir(directory, { recursive: true });
assert.ok(!(await realpath(sourcePath)).startsWith(`${await realpath(directory)}${sep}`), 'Choose a QA output directory separate from the source video.');
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const sourceHash = await hash(sourcePath);
const checkedModules = ['apps/worker/engine.mjs', 'apps/worker/drawings.mjs', 'packages/core/drawing-anchors.mjs', 'packages/core/comment-projection.mjs', 'packages/core/drawing-history.mjs', 'packages/core/overlay-geometry.mjs'];
const codeHashes = Object.fromEntries(await Promise.all(checkedModules.map(async path => [path, await hash(new URL(`../${path}`, import.meta.url))])));
const previewPath = join(directory, 'canonical.mp4');
const asset = await ingest(sourcePath, previewPath, join(directory, 'thumbnail.jpg'));
assert.ok(asset.durationFrames >= 360, 'This check needs at least 12 seconds.');
const initialDrawings = [
  { id: 'early', kind: 'rect', frame: 75, color: '#ff0000', fill: '#ff0000', points: [{ x: .08, y: .08 }, { x: .2, y: .2 }] },
  { id: 'deleted', kind: 'arrow', frame: 135, color: '#ffff00', points: [{ x: .3, y: .3 }, { x: .5, y: .5 }] },
  { id: 'later', kind: 'ellipse', frame: 285, color: '#0000ff', fill: '#0000ff', points: [{ x: .7, y: .7 }, { x: .82, y: .82 }] },
];
const historyStore = createDrawingHistoryStore({ maxContexts: 1 });
const history = historyStore.activate('real-media:v1:draft-1', initialDrawings, 75);
const initialSnapshot = history.present;
history.commit(history.present.map(drawing => drawing.id === 'early' ? { ...drawing, color: '#00ff00', fill: '#00ff00' } : drawing));
history.beginGroup();
for (let step = 0; step < 70; step++) history.updateGroup(history.present.map(drawing => drawing.id === 'early' ? translateDrawing(drawing, 1 / asset.width, 0) : drawing));
history.endGroup();
assert.equal(history.past.length, 2, 'A held arrow key consumes one step after the style edit.');
const restored = historyStore.activate('real-media:v1:draft-1', structuredClone(history.present), 75);
assert.equal(restored, history, 'Returning to the same draft restores its history.');
assert.equal(history.undo().find(drawing => drawing.id === 'early').points[0].x, initialSnapshot[0].points[0].x);
assert.ok(history.redo());
assert.ok(history.undo());
assert.ok(drawingsEqual(history.undo(), initialSnapshot, 75), 'Undo restores the geometry and style used by the native output.');
const drawings = history.present;
const historyChecks = { groupedMoves: 70, groupedMoveSteps: 1, draftRestore: true, undoRedoRoundTrip: true, restoredGeometryAndStyle: true };
const comment = { versionId: 'v1', frameIn: 60, frameOut: 300, contextFrame: 75, drawings, sourceRanges: [{ frameIn: 60, frameOut: 300 }] };
const original = { id: 'v1', assetId: 'real-media', durationFrames: asset.durationFrames, timelineMap: [{ sourceIn: 0, sourceOut: asset.durationFrames, outputIn: 0, outputOut: asset.durationFrames, speed: 1, volume: 1 }] };
const ops = [
  { id: 'trim', type: 'trim', sourceRanges: [{ frameIn: 0, frameOut: 360 }], params: {} },
  { id: 'cut', type: 'cut', sourceRanges: [{ frameIn: 120, frameOut: 150 }], params: {} },
  { id: 'speed', type: 'speed', sourceRanges: [{ frameIn: 180, frameOut: 240 }], params: { factor: 2 } },
  // Separate explicit insertion requests, one drawing scene per static overlay.
  { id: 'insert-early', type: 'overlay', sourceRanges: [{ frameIn: 60, frameOut: 90 }], params: { kind: 'drawing', drawings: [drawings[0]] } },
  { id: 'insert-later', type: 'overlay', sourceRanges: [{ frameIn: 270, frameOut: 300 }], params: { kind: 'drawing', drawings: [drawings[2]] } },
].map(op => ({ ...op, status: 'approved' }));
const outputPath = join(directory, 'edited.mp4');
const rendered = await renderVideo({ asset, sourcePath, ops, outputPath, workingDirectory: join(directory, 'job') });
const target = { id: 'v2', assetId: original.assetId, durationFrames: rendered.durationFrames, timelineMap: rendered.timelineMap };
const projected = projectDrawings(comment, original, target);
assert.deepEqual(projected.map(item => [item.drawing.id, item.frame, item.status]), [['early', 75, 'present'], ['deleted', null, 'deleted'], ['later', 225, 'present']]);
assert.equal(rendered.durationFrames, 300);
const outputInfo = await probe(outputPath);
assert.equal(Number(outputInfo.streams.find(stream => stream.codec_type === 'video').nb_frames), 300);
const still = async (path, frame, name) => {
  const file = join(directory, name);
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', file]);
  return file;
};
const sceneChecks = [];
for (const [sourceFrame, outputFrame, name, point, expectedChannel] of [[75, 75, 'early', .14, 0], [285, 225, 'later', .76, 2]]) {
  const sourceStill = await still(previewPath, sourceFrame, `${name}-source.png`);
  const outputStill = await still(outputPath, outputFrame, `${name}-output.png`);
  const crop = { left: Math.floor(asset.width * .3), top: Math.floor(asset.height * .3), width: Math.floor(asset.width * .35), height: Math.floor(asset.height * .35) };
  const pixels = async path => sharp(path).extract(crop).resize(64, 36).removeAlpha().raw().toBuffer();
  const [before, after] = await Promise.all([pixels(sourceStill), pixels(outputStill)]);
  const meanAbsoluteError = before.reduce((sum, value, index) => sum + Math.abs(value - after[index]), 0) / before.length;
  assert.ok(meanAbsoluteError < 12, `Same scene at ${sourceFrame}→${outputFrame}: MAE ${meanAbsoluteError}`);
  const rgb = [...await sharp(outputStill).extract({ left: Math.floor(asset.width * point), top: Math.floor(asset.height * point), width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  assert.ok(rgb[expectedChannel] > 200 && rgb.filter((_, index) => index !== expectedChannel).every(value => value < 40), `Expected insertion color at ${outputFrame}: ${rgb}`);
  sceneChecks.push({ sourceFrame, outputFrame, meanAbsoluteError, overlayRgb: rgb });
}
assert.equal(await hash(sourcePath), sourceHash, 'Original source remains unchanged.');
for (const path of checkedModules) assert.equal(await hash(new URL(`../${path}`, import.meta.url)), codeHashes[path], `Checked module changed while rendering: ${path}`);
const report = { checkedAt: new Date().toISOString(), codeHashes, sourcePath, sourceHash, sourcePreserved: true, asset, outputPath, outputFrames: rendered.durationFrames, projected: projected.map(({ drawing, authoredFrame, frame, status }) => ({ drawingId: drawing.id, authoredFrame, frame, status })), historyChecks, sceneChecks, diagnostics: rendered.diagnostics, scope: 'Real local media, canonical 30fps annotation mapping, history-restored drawing geometry and native static insertion. No browser interaction or real AI call.' };
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ outputPath, outputFrames: report.outputFrames, projected: report.projected, sceneChecks, sourcePreserved: true }, null, 2));
