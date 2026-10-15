import test from 'node:test';
import assert from 'node:assert/strict';
import { changedDrawingFrames, createDrawingHistoryStore, drawingEqual, drawingsEqual } from '../packages/core/drawing-history.mjs';

const pen = (id = 'a', frame = 30) => ({ id, kind: 'pen', color: '#ffffff', frame, points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }] });
const recolor = (session, color, id = 'a') => session.present.map(drawing => drawing.id === id ? { ...drawing, color } : drawing);

test('draft undo and redo survive saved-card review and equal external echoes', () => {
  const store = createDrawingHistoryStore();
  const session = store.activate('project:version:draft-1', [], 30);
  session.commit([pen()]);
  session.commit(recolor(session, '#ff0000'));
  const viewedDraft = session.present;
  // Viewing a saved request does not activate or mutate the editable draft history.
  assert.equal(store.activate('project:version:draft-1', structuredClone(viewedDraft), 30), session);
  assert.equal(session.past.length, 2);
  assert.equal(session.undo()[0].color, '#ffffff');
  assert.equal(session.undo().length, 0);
  assert.equal(session.redo()[0].color, '#ffffff');
  assert.equal(session.redo()[0].color, '#ff0000');
});

test('version and draft generation keys isolate history; discarded contexts cannot leak edits', () => {
  const store = createDrawingHistoryStore();
  const first = store.activate('p:v1:g1', [], 30);
  first.commit([pen()]);
  const second = store.activate('p:v2:g1', [], 60);
  second.commit([pen('b', 60)]);
  assert.equal(store.activate('p:v1:g1', first.present, 30), first);
  assert.equal(first.undo().length, 0);
  assert.equal(second.present[0].id, 'b');
  const freshDraft = store.activate('p:v1:g2', [], 30);
  assert.equal(freshDraft.canUndo, false);
  assert.equal(freshDraft.canRedo, false);
  assert.equal(store.delete('p:v1:g1'), true);
  assert.equal(store.get('p:v1:g1'), undefined);
  store.clear();
  assert.equal(store.size, 0);
});

test('external geometry or legacy anchor replacement resets history without mutating source', () => {
  const source = [pen()];
  delete source[0].frame;
  const store = createDrawingHistoryStore();
  const session = store.activate('draft', source, 30);
  session.commit(recolor(session, '#ff0000'));
  const replacement = [pen('new', 90)];
  assert.equal(session.sync(replacement), true);
  assert.equal(session.canUndo, false);
  assert.equal(session.canRedo, false);
  replacement[0].points[0].x = 0.9;
  assert.equal(session.present[0].points[0].x, 0.1);
  assert.equal(source[0].frame, undefined);
  session.sync(source, 60);
  assert.equal(session.present[0].frame, 60);
  assert.equal(session.canUndo, false);
  // An explicit frame stays anchored when only the UI fallback changes.
  session.commit(recolor(session, '#00ff00'));
  assert.equal(session.sync(session.present, 90), false);
  assert.equal(session.past.length, 1);
  assert.equal(session.present[0].frame, 60);
});

test('the source may mutate in place, but reactivation detects and isolates its new contents', () => {
  const source = [pen()];
  const store = createDrawingHistoryStore();
  const session = store.activate('draft', source, 30);
  session.commit(recolor(session, '#ff0000'));
  source[0].color = '#00ff00';
  source[0].points[0].x = 0.8;
  store.activate('draft', source, 30);
  assert.equal(session.present[0].color, '#00ff00');
  assert.equal(session.present[0].points[0].x, 0.8);
  assert.equal(session.canUndo, false);
});

test('equal normalized legacy data and no-op commits preserve redo', () => {
  const initial = [pen()];
  delete initial[0].frame;
  const session = createDrawingHistoryStore().activate('draft', initial, 30);
  session.commit(recolor(session, '#ff0000'));
  session.undo();
  assert.equal(session.sync(structuredClone(initial)), false);
  assert.equal(session.commit(structuredClone(initial)), false);
  assert.equal(session.canRedo, true);
  assert.equal(session.redo()[0].color, '#ff0000');
  assert.equal(drawingsEqual(session.present, structuredClone(session.present)), true);
  assert.equal(drawingEqual(session.present[0], { ...session.present[0], opacity: 0 }), false);
});

test('many grouped style or keyboard updates undo once; a new edit invalidates redo', () => {
  const session = createDrawingHistoryStore().activate('draft', [pen()], 30);
  session.beginGroup();
  for (const opacity of [0.9, 0.8, 0.7, 0.6]) session.updateGroup(session.present.map(drawing => ({ ...drawing, opacity })));
  assert.equal(session.canUndo, true);
  assert.equal(session.past.length, 0);
  assert.equal(session.endGroup(), true);
  assert.equal(session.past.length, 1);
  assert.equal(session.undo()[0].opacity, 1);
  assert.equal(session.canRedo, true);
  session.commit(recolor(session, '#00ff00'));
  assert.equal(session.canRedo, false);
  assert.equal(session.redo(), null);
});

test('group changes returned to their origin create no history and retain redo', () => {
  const session = createDrawingHistoryStore().activate('draft', [pen()], 30);
  session.commit(recolor(session, '#ff0000'));
  session.undo();
  const before = session.present;
  session.beginGroup();
  session.updateGroup(recolor(session, '#0000ff'));
  session.updateGroup(structuredClone(before));
  assert.equal(session.endGroup(), false);
  assert.equal(session.present, before);
  assert.equal(session.canRedo, true);
  session.beginGroup();
  session.updateGroup(recolor(session, '#0000ff'));
  session.updateGroup(structuredClone(before));
  assert.equal(session.commit(session.present), false);
  assert.equal(session.canRedo, true);
  assert.equal(session.past.length, 0);
});

test('context switching and undo close an in-flight group without dropping the edit', () => {
  const store = createDrawingHistoryStore();
  const session = store.activate('v1', [pen()], 30);
  session.beginGroup();
  session.updateGroup(recolor(session, '#ff0000'));
  store.activate('v2', [], 60);
  assert.equal(session.grouping, false);
  assert.equal(session.past.length, 1);
  session.beginGroup();
  session.updateGroup(recolor(session, '#00ff00'));
  assert.equal(session.undo()[0].color, '#ff0000');
  assert.equal(session.undo()[0].color, '#ffffff');
});

test('history retains at most 50 steps and evicts least recently activated contexts', () => {
  const store = createDrawingHistoryStore({ maxContexts: 2 });
  const first = store.activate('a', [pen()], 30);
  for (let index = 0; index < 70; index++) first.commit(recolor(first, `#${index.toString(16).padStart(6, '0')}`));
  assert.equal(first.past.length, 50);
  for (let index = 0; index < 50; index++) assert.ok(first.undo());
  assert.equal(first.undo(), null);
  assert.equal(first.present[0].color, '#000013');
  for (let index = 0; index < 50; index++) assert.ok(first.redo());
  assert.equal(first.redo(), null);
  assert.equal(first.past.length, 50);
  store.activate('b', [], 30);
  store.activate('a', first.present, 30);
  store.activate('c', [], 30);
  assert.equal(store.size, 2);
  assert.equal(store.get('b'), undefined);
  assert.equal(store.get('a'), first);
  assert.throws(() => createDrawingHistoryStore({ limit: 51 }), RangeError);
  assert.throws(() => createDrawingHistoryStore({ limit: 0 }), RangeError);
  assert.throws(() => createDrawingHistoryStore({ maxContexts: 0 }), RangeError);
});

test('snapshots are isolated and deeply frozen, while unchanged shapes and geometry are shared', () => {
  const source = [pen(), pen('b', 60)];
  const session = createDrawingHistoryStore().activate('draft', source, 30);
  const before = session.present;
  source[0].points[0].x = 0.9;
  assert.equal(before[0].points[0].x, 0.1);
  assert.throws(() => before.push(pen('c')), TypeError);
  assert.throws(() => { before[0].color = '#ff0000'; }, TypeError);
  assert.throws(() => { before[0].points[0].x = 0.8; }, TypeError);
  session.commit(recolor(session, '#ff0000'));
  assert.notEqual(session.present[0], before[0]);
  assert.equal(session.present[0].points, before[0].points);
  assert.equal(session.present[1], before[1]);
  const rect = { id: 'r', kind: 'rect', color: '#fff', points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] };
  session.commit([...session.present, rect]);
  assert.throws(() => { session.present[2].region.x = 0.8; }, TypeError);
});

test('frame change hints describe only changed scenes, including same-scene stacking changes', () => {
  const first = pen('a', 30), second = pen('b', 60), third = pen('c', 30);
  assert.deepEqual(changedDrawingFrames([first, second], [second], 0), [30]);
  assert.deepEqual(changedDrawingFrames([first, second], [second, first], 0), []);
  assert.deepEqual(changedDrawingFrames([first, second, third], [third, second, first], 0), [30]);
  assert.deepEqual(changedDrawingFrames([first, second], [{ ...first, frame: 90 }, second], 0), [30, 90]);
  assert.deepEqual(changedDrawingFrames([first], [{ ...first, points: [{ x: 0.5, y: 0.5 }] }], 0), [30]);
  assert.deepEqual(changedDrawingFrames([first], structuredClone([first]), 0), []);
});

test('invalid metadata or duplicate IDs do not corrupt a valid session', () => {
  const store = createDrawingHistoryStore();
  const session = store.activate('draft', [pen()], 30);
  const before = session.present;
  assert.throws(() => session.commit([pen('b', -1)]), RangeError);
  assert.throws(() => session.sync([pen('b'), pen('b')]), RangeError);
  assert.equal(session.present, before);
  assert.equal(session.canUndo, false);
  assert.throws(() => store.activate('', [], 0), TypeError);
});

test('maximum pen load keeps 50 histories with shared geometry and never serializes drawings', t => {
  const drawings = Array.from({ length: 30 }, (_, shape) => ({
    ...pen(`pen-${shape}`, shape * 30),
    points: Array.from({ length: 2000 }, (_, index) => ({ x: index / 2000, y: (Math.sin(index / 15) + 1) / 2 })),
    toJSON() { throw new Error('Drawing history must not serialize pen geometry.'); },
  }));
  const session = createDrawingHistoryStore().activate('draft', drawings, 0);
  const start = performance.now();
  for (let index = 0; index < 70; index++) session.commit(recolor(session, `#${index.toString(16).padStart(6, '0')}`, 'pen-0'));
  const elapsed = performance.now() - start;
  const snapshots = [...session.past, session.present];
  const allShapes = snapshots.flat();
  const geometries = new Set(allShapes.map(drawing => drawing.points));
  const shapes = new Set(allShapes);
  assert.equal(snapshots.length, 51);
  assert.equal(shapes.size, 80);
  assert.equal(geometries.size, 30);
  assert.equal([...geometries].reduce((sum, points) => sum + points.length, 0), 60_000);
  assert.equal(changedDrawingFrames(session.past.at(-1), session.present, 0).length, 1);
  t.diagnostic(`30 pens × 2,000 points; 70 commits ${elapsed.toFixed(2)}ms; retained 51 snapshots / ${shapes.size} drawing objects / ${geometries.size} geometry arrays / 60,000 points. Pure-state measurement, not browser latency.`);
});
