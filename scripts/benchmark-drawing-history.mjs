import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve, join } from 'node:path';
import { createDrawingHistoryStore, drawingsEqual } from '../packages/core/drawing-history.mjs';
import { drawingFrame } from '../packages/core/drawing-anchors.mjs';
import { normalizeDrawing, translateDrawing } from '../packages/core/overlay-geometry.mjs';

// node scripts/benchmark-drawing-history.mjs [OUTPUT_DIRECTORY]
// Reproduces the previous OverlayEditor keyboard state path. This is not an old
// application build, browser event/paint measurement, RAF/FPS test, or heap profiler.
const configuration = { pens: 30, pointsPerPen: 2000, keydownsPerHold: 70, viewportWidth: 960, warmupRounds: 2, measuredRounds: 5, historyLimit: 50 };
const directory = resolve(process.argv[2] || 'storage/qa/drawing-history');
const checkedModules = ['scripts/benchmark-drawing-history.mjs', 'packages/core/drawing-history.mjs', 'packages/core/drawing-anchors.mjs', 'packages/core/overlay-geometry.mjs'];
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const codeHashes = Object.fromEntries(await Promise.all(checkedModules.map(async path => [path, await hash(new URL(`../${path}`, import.meta.url))])));
const selectedId = 'pen-0', currentFrame = 90, fallbackFrame = 90;

function initialDrawings() {
  return Array.from({ length: configuration.pens }, (_, index) => normalizeDrawing({
    id: `pen-${index}`, kind: 'pen', color: '#ffffff', frame: currentFrame, fill: 'none', strokeWidth: 3, opacity: 1,
    points: Array.from({ length: configuration.pointsPerPen }, (_, point) => ({
      x: 0.1 + point / configuration.pointsPerPen * 0.1,
      y: 0.15 + index / 100 + Math.sin(point / 15) * 0.02,
    })),
  }));
}

const nudge = drawings => drawings.map(drawing => drawing.id === selectedId && drawingFrame(drawing, fallbackFrame) === currentFrame ?
  translateDrawing(drawing, 1 / configuration.viewportWidth, 0) : drawing);

function retainedValues(snapshots) {
  const drawingObjects = new Set(), pointArrays = new Set(), pointObjects = new Set();
  for (const snapshot of snapshots) for (const drawing of snapshot) {
    drawingObjects.add(drawing);
    pointArrays.add(drawing.points);
  }
  for (const points of pointArrays) for (const point of points) pointObjects.add(point);
  return { snapshots: snapshots.length, drawingObjects: drawingObjects.size, pointArrays: pointArrays.size, pointObjects: pointObjects.size };
}

function runPreviousPath() {
  let present = initialDrawings();
  const initial = present, past = [], future = [], eventMs = [];
  const started = performance.now();
  for (let index = 0; index < configuration.keydownsPerHold; index++) {
    const eventStarted = performance.now();
    const next = nudge(present);
    // The old keyboard handler calls commit() per keydown: a full-array JSON
    // comparison, then one complete-array history entry (capped at 50).
    if (JSON.stringify(present) !== JSON.stringify(next)) {
      past.push(present);
      if (past.length > configuration.historyLimit) past.shift();
      future.length = 0;
      present = next;
    }
    eventMs.push(performance.now() - eventStarted);
  }
  const elapsedMs = performance.now() - started;
  const final = present, retained = retainedValues([...past, present]);
  let undoSteps = 0;
  while (past.length) { future.push(present); present = past.pop(); undoSteps++; }
  const restoredInitial = drawingsEqual(present, initial, fallbackFrame);
  // Seventy separately recorded keydowns exceed the previous 50-step history.
  assert.equal(undoSteps, configuration.historyLimit);
  assert.equal(restoredInitial, false);
  const firstPoint = present[0].points[0];
  assert.ok(Math.abs(firstPoint.x - (initial[0].points[0].x + (configuration.keydownsPerHold - configuration.historyLimit) / configuration.viewportWidth)) < 1e-10);
  return { eventMs, elapsedMs, final, retained, undo: { steps: undoSteps, restoredInitial, firstPointAfterUndo: firstPoint } };
}

function runGroupedPath() {
  const session = createDrawingHistoryStore().activate('benchmark:version-1:draft-1', initialDrawings(), fallbackFrame);
  const initial = session.present, eventMs = [];
  session.beginGroup();
  const started = performance.now();
  for (let index = 0; index < configuration.keydownsPerHold; index++) {
    const eventStarted = performance.now();
    session.updateGroup(nudge(session.present));
    eventMs.push(performance.now() - eventStarted);
  }
  // Keyboard keyup closes the hold; include its bookkeeping in total round time.
  const keyupStarted = performance.now();
  session.endGroup();
  const keyupMs = performance.now() - keyupStarted, elapsedMs = performance.now() - started;
  const final = session.present, retained = retainedValues([...session.past, session.present]);
  assert.equal(session.past.length, 1);
  const restored = session.undo();
  assert.equal(drawingsEqual(restored, initial, fallbackFrame), true);
  assert.equal(session.undo(), null);
  assert.equal(drawingsEqual(session.redo(), final, fallbackFrame), true);
  return { eventMs, elapsedMs, keyupMs, final, retained, undo: { steps: 1, restoredInitial: true, redoRestoredFinal: true, firstPointAfterUndo: restored[0].points[0] } };
}

const previous = [], grouped = [];
for (let round = 0; round < configuration.warmupRounds + configuration.measuredRounds; round++) {
  // Alternate order to avoid measuring one path only before the other warms up.
  let before, after;
  if (round % 2) { after = runGroupedPath(); before = runPreviousPath(); }
  else { before = runPreviousPath(); after = runGroupedPath(); }
  assert.equal(drawingsEqual(before.final, after.final, fallbackFrame), true, `Equivalent final drawing coordinates in round ${round}.`);
  if (round >= configuration.warmupRounds) { previous.push(before); grouped.push(after); }
}

const percentile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
const stats = values => ({ count: values.length, medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95), totalMs: values.reduce((sum, value) => sum + value, 0) });
const summarize = rounds => ({
  keydownStateProcessing: stats(rounds.flatMap(round => round.eventMs)),
  completeHold: stats(rounds.map(round => round.elapsedMs)),
  ...(rounds[0].keyupMs !== undefined ? { keyupGrouping: stats(rounds.map(round => round.keyupMs)) } : {}),
  retainedValuesAfterHold: rounds[0].retained,
  undo: rounds[0].undo,
});
for (const path of checkedModules) assert.equal(await hash(new URL(`../${path}`, import.meta.url)), codeHashes[path], `Checked code changed during benchmark: ${path}`);
const report = {
  checkedAt: new Date().toISOString(),
  scope: 'Pure JavaScript drawing-state CPU measurements. No browser interaction, event delivery, paint, RAF/FPS, or heap-byte profiling. Baseline reproduces the previous OverlayEditor keyboard implementation; it is not a benchmark of two complete app builds.',
  environment: { node: process.version, platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model },
  configuration, codeHashes,
  baseline: { description: 'map + translateDrawing, JSON.stringify(previous/next), one history entry per keydown, maximum 50 entries.', ...summarize(previous) },
  current: { description: 'map + the same translateDrawing, session.updateGroup per keydown, session.endGroup on keyup; one undo restores the start of the entire hold.', ...summarize(grouped) },
  assertions: { equivalentFinalCoordinatesInEveryRound: true, groupedUndoRestoresInitialCoordinates: true, groupedRedoRestoresFinalCoordinates: true, originalInputIsolationCoveredSeparatelyByUnitTests: true },
  retainedValueCounting: 'Counts unique reachable drawing objects, point arrays and point objects in retained history snapshots; these counts are not allocated bytes or peak heap usage.',
};
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ reportPath: join(directory, 'report.json'), baseline: report.baseline, current: report.current, scope: report.scope }, null, 2));
