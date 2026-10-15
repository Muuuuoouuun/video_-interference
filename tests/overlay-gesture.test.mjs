import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayGesture } from '../packages/core/overlay-gesture.mjs';
import { MAX_PEN_POINTS, createDrawing, decimatePoints, drawingBounds, normalizeDrawing, resizeDrawing, translateDrawing } from '../packages/core/overlay-geometry.mjs';
import { createDrawingHistoryStore } from '../packages/core/drawing-history.mjs';

const style = { color: '#bcf7de', strokeWidth: 3, opacity: 1, fill: 'none' };
const start = { x: 0.1, y: 0.5 };
const finePen = () => normalizeDrawing({
  ...style, id: 'fine-pen', kind: 'pen', frame: 30,
  points: decimatePoints(Array.from({ length: 401 }, (_, i) => ({ x: 0.1 + i * 0.8 / 400, y: 0.5 + 0.002 * Math.sin(i * Math.PI / 2) })), 1000, 562.5),
});
const gestureFor = (original, extra = {}) => createOverlayGesture({ kind: 'move', original, start, width: 500, height: 281.25, ...extra });
const newPen = () => ({ ...style, id: 'new-pen', kind: 'pen', frame: 45, points: [{ ...start }] });

test('selecting an existing fine pen at a smaller viewport preserves its object and every point', () => {
  const original = finePen();
  assert.equal(original.points.length, 202);
  assert.equal(decimatePoints(original.points, 500, 281.25).length, 2, 'fixture exposes the old finish-path data loss');
  for (const extra of [{}, { kind: 'resize', handle: 'se' }]) {
    const gesture = gestureFor(original, extra);
    gesture.update(start);
    assert.equal(gesture.flush(), original);
    assert.equal(gesture.finish(), original);
  }
  const history = createDrawingHistoryStore().activate('draft', [original], 30);
  const selection = gestureFor(history.present[0]);
  selection.update(start);
  assert.equal(history.commit([selection.finish()]), false);
  assert.equal(history.canUndo, false);
});

test('moving and resizing an existing pen keep all original vertices at the smaller viewport', () => {
  const original = finePen(), snapshot = structuredClone(original);
  const move = gestureFor(original);
  move.update({ x: 0.13, y: 0.52 });
  const moved = move.finish();
  assert.equal(moved.points.length, original.points.length);
  assert.deepEqual(moved, translateDrawing(original, 0.13 - start.x, 0.52 - start.y));
  const bounds = drawingBounds(original);
  const resize = gestureFor(original, { kind: 'resize', handle: 'se', start: { x: bounds.x + bounds.w, y: bounds.y + bounds.h } });
  resize.update({ x: 0.5, y: 0.502 });
  const resized = resize.finish();
  assert.equal(resized.points.length, original.points.length);
  assert.deepEqual(resized, resizeDrawing(original, 'se', { x: 0.5, y: 0.502 }, { w: 3 / 500, h: 3 / 281.25 }));
  assert.deepEqual(original, snapshot);
});

test('corner and edge resize preserves the grab offset and centered handles follow the pointer', () => {
  const anchors = { nw: [0.25, 0.25], n: [0.5, 0.25], ne: [0.75, 0.25], e: [0.75, 0.5], se: [0.75, 0.75], s: [0.5, 0.75], sw: [0.25, 0.75], w: [0.25, 0.5] };
  // Binary-exact coordinates: at 512px, grab 8px from the center and move 1px right / 2px down.
  const dx = 1 / 512, dy = 2 / 512;
  for (const kind of ['rect', 'ellipse']) for (const [handle, [x, y]] of Object.entries(anchors)) for (const offset of [0, -8 / 512, 8 / 512]) {
    const original = createDrawing(kind, { x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }, style, 'box');
    const grab = { x: x + offset, y: y + offset };
    const gesture = gestureFor(original, { kind: 'resize', handle, start: grab, width: 512, height: 512 });
    gesture.update({ x: grab.x + dx, y: grab.y + dy });
    const resized = gesture.finish();
    const left = 0.25 + (handle.includes('w') ? dx : 0), right = 0.75 + (handle.includes('e') ? dx : 0);
    const top = 0.25 + (handle.includes('n') ? dy : 0), bottom = 0.75 + (handle.includes('s') ? dy : 0);
    assert.deepEqual(resized.region, { x: left, y: top, w: right - left, h: bottom - top }, `${kind} ${handle} offset ${offset}`);
    assert.deepEqual(original.region, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  }
});

test('line and arrow endpoint resize uses pointer displacement without moving the opposite end', () => {
  for (const kind of ['line', 'arrow']) for (const handle of ['start', 'end']) for (const offset of [0, 8 / 512]) {
    const original = createDrawing(kind, { x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }, style, 'line');
    const index = handle === 'start' ? 0 : 1, anchor = original.points[index];
    const grab = { x: anchor.x - offset, y: anchor.y + offset };
    const gesture = gestureFor(original, { kind: 'resize', handle, start: grab, width: 512, height: 512 });
    gesture.update({ x: grab.x + 1 / 512, y: grab.y - 2 / 512 });
    const resized = gesture.finish();
    assert.deepEqual(resized.points[index], { x: anchor.x + 1 / 512, y: anchor.y - 2 / 512 });
    assert.deepEqual(resized.points[1 - index], original.points[1 - index]);
  }
});

test('offset pen resize retains every vertex and returning to the grab point preserves redo', () => {
  const source = finePen(), snapshot = structuredClone(source);
  const session = createDrawingHistoryStore().activate('resize-draft', [source], 30);
  session.commit([{ ...session.present[0], color: '#ff0000' }]);
  session.undo();
  const original = session.present[0], bounds = drawingBounds(original);
  const anchor = { x: bounds.x + bounds.w, y: bounds.y + bounds.h };
  const grab = { x: anchor.x - 8 / 500, y: anchor.y + 8 / 281.25 };
  const gesture = gestureFor(original, { kind: 'resize', handle: 'se', start: grab });
  gesture.update({ x: grab.x - 0.1, y: grab.y + 0.05 });
  const resized = gesture.flush();
  const expected = resizeDrawing(original, 'se', { x: anchor.x - 0.1, y: anchor.y + 0.05 }, { w: 3 / 500, h: 3 / 281.25 });
  assert.equal(resized.points.length, 202);
  for (let index = 0; index < resized.points.length; index++) {
    assert.ok(Math.abs(resized.points[index].x - expected.points[index].x) < 1e-12);
    assert.ok(Math.abs(resized.points[index].y - expected.points[index].y) < 1e-12);
  }
  gesture.update(grab);
  assert.equal(gesture.finish(), original, 'a round trip is an exact no-op, not a normalized replacement');
  assert.equal(session.commit([gesture.finish()]), false);
  assert.equal(session.canRedo, true);
  assert.deepEqual(source, snapshot);
});

test('offset resize still clamps minimum size and the canvas boundary', () => {
  const original = createDrawing('rect', { x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }, style, 'box');
  const minimum = 3 / 512;
  const shrink = gestureFor(original, { kind: 'resize', handle: 'nw', start: { x: 0.25 + 8 / 512, y: 0.25 + 8 / 512 }, width: 512, height: 512 });
  shrink.update({ x: 0.99, y: 0.99 });
  assert.deepEqual(shrink.finish().region, { x: 0.75 - minimum, y: 0.75 - minimum, w: minimum, h: minimum });
  const expand = gestureFor(original, { kind: 'resize', handle: 'se', start: { x: 0.75 - 8 / 512, y: 0.75 - 8 / 512 }, width: 512, height: 512 });
  expand.update({ x: 1, y: 1 });
  assert.deepEqual(expand.finish().region, { x: 0.25, y: 0.25, w: 0.75, h: 0.75 });
});

test('many pointer updates defer geometry reads until one flush and reuse the flushed preview', () => {
  const pen = finePen();
  let pointReads = 0;
  const original = { ...pen, get points() { pointReads++; return pen.points; } };
  const gesture = gestureFor(original);
  for (let i = 1; i <= 40; i++) gesture.update({ x: start.x + i * 0.001, y: start.y + i * 0.001 });
  assert.equal(pointReads, 0, 'pointer events only update the pending position');
  const preview = gesture.flush(), readsAfterFlush = pointReads;
  assert.ok(readsAfterFlush > 0);
  assert.equal(gesture.flush(), preview);
  assert.equal(pointReads, readsAfterFlush, 'a clean flush does not recalculate geometry');
  for (const [index, point] of preview.points.entries()) {
    assert.ok(Math.abs(point.x - pen.points[index].x - 0.04) < 1e-12);
    assert.ok(Math.abs(point.y - pen.points[index].y - 0.04) < 1e-12);
  }
});

test('pointerup flushes the final position without waiting for a scheduled animation frame', () => {
  const original = { ...createDrawing('rect', start, start, style, 'rect'), frame: 63 };
  const gesture = gestureFor(original, { kind: 'create' });
  gesture.update({ x: 0.4, y: 0.7 });
  const earlier = gesture.flush();
  gesture.update({ x: 0.6, y: 0.8 });
  const final = gesture.finish();
  assert.deepEqual(final, { ...original, ...createDrawing('rect', start, { x: 0.6, y: 0.8 }, original, original.id) });
  assert.equal(final.frame, 63);
  assert.notDeepEqual(final.region, earlier.region);
});

test('discarding pending or flushed gestures cannot alter the committed drawing', () => {
  const original = finePen(), snapshot = structuredClone(original);
  for (const flush of [false, true]) {
    const canceled = gestureFor(original);
    canceled.update({ x: 0.15, y: 0.55 });
    if (flush) canceled.flush();
    // The UI cancels its RAF and drops the helper without calling finish or commit.
    assert.deepEqual(original, snapshot);
  }
});

test('new pen samples include the current event and do not mutate an earlier flushed preview', () => {
  const original = newPen(), gesture = gestureFor(original, { kind: 'create', width: 1000, height: 562.5 });
  gesture.update({ x: 0.4, y: 0.5 }, [{ x: 0.2, y: 0.4 }, { x: 0.3, y: 0.6 }]);
  const first = gesture.flush(), snapshot = structuredClone(first);
  assert.deepEqual(first.points.at(-1), { x: 0.4, y: 0.5 });
  gesture.update({ x: 0.7, y: 0.7 }, [{ x: 0.5, y: 0.6 }, { x: 0.6, y: 0.4 }]);
  const second = gesture.flush();
  assert.deepEqual(first, snapshot);
  assert.deepEqual(second.points, [...first.points, { x: 0.5, y: 0.6 }, { x: 0.6, y: 0.4 }, { x: 0.7, y: 0.7 }]);
  assert.deepEqual(original.points, [start]);
});

test('new pen finish preserves its subpixel final endpoint while a tap remains one dot', () => {
  const gesture = gestureFor(newPen(), { kind: 'create', width: 1000, height: 562.5 });
  gesture.update({ x: 0.4, y: 0.5 });
  gesture.flush();
  const end = { x: 0.4002, y: 0.5001 };
  gesture.update(end);
  assert.deepEqual(gesture.finish().points.at(-1), end);
  const tap = gestureFor(newPen(), { kind: 'create', width: 1000, height: 562.5 });
  tap.update({ x: start.x + 0.0002, y: start.y });
  assert.deepEqual(tap.finish().points, [start]);
});

test('only newly drawn pens are simplified and long sample batches stay bounded', () => {
  const gesture = gestureFor(newPen(), { kind: 'create', width: 1000, height: 562.5 });
  const samples = Array.from({ length: 8000 }, (_, i) => ({ x: 0.1 + i * 0.8 / 7999, y: i % 2 ? 0.7 : 0.3 }));
  gesture.update(samples.at(-1), samples);
  assert.ok(gesture.flush().points.length <= MAX_PEN_POINTS);
  const final = gesture.finish();
  assert.ok(final.points.length <= MAX_PEN_POINTS);
  assert.deepEqual(final.points[0], start);
  assert.deepEqual(final.points.at(-1), samples.at(-1));
  const straight = gestureFor(newPen(), { kind: 'create', width: 1000, height: 562.5 });
  straight.update({ x: 0.4, y: 0.5 }, [{ x: 0.2, y: 0.5 }, { x: 0.3, y: 0.5 }]);
  assert.equal(straight.flush().points.length, 4);
  assert.equal(straight.finish().points.length, 2);
});
