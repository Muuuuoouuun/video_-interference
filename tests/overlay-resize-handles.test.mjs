import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayGesture } from '../packages/core/overlay-gesture.mjs';
import { MIN_DRAWING_SIZE_PX, createDrawing, drawingBounds, drawingResizeHandles } from '../packages/core/overlay-geometry.mjs';

const style = { color: '#ffffff', strokeWidth: 3, opacity: 1, fill: 'none' };
const pen = points => ({ ...style, id: 'thin-pen', kind: 'pen', frame: 42, points });
const ids = handles => handles.map(handle => handle.id);

test('flat and almost-horizontal pens resize without moving or flattening any original Y coordinate', () => {
  for (const height of [250, 500, 1000]) for (const amplitude of [0, 1e-10, 2.5 / height]) {
    const original = pen([{ x: .2, y: .4 }, { x: .4, y: .4 + amplitude }, { x: .6, y: .4 + amplitude / 3 }, { x: .8, y: .4 }]);
    const snapshot = structuredClone(original);
    const handles = drawingResizeHandles(original, 1000, height);
    assert.deepEqual(ids(handles), ['w', 'e']);
    assert.equal(new Set(handles.map(handle => `${handle.x},${handle.y}`)).size, 2, 'no overlapping corner handles remain');
    for (const handle of handles) {
      const start = { x: handle.x - .008, y: handle.y + 8 / height };
      const gesture = createOverlayGesture({ kind: 'resize', original, handle: handle.id, start, width: 1000, height });
      gesture.update({ x: start.x + (handle.id === 'w' ? -.1 : .1), y: start.y + 20 / height });
      const resized = gesture.finish();
      assert.deepEqual(resized.points.map(point => point.y), original.points.map(point => point.y));
      assert.equal(resized.points.length, original.points.length);
      assert.ok(drawingBounds(resized).w > drawingBounds(original).w);
      assert.equal(resized.frame, 42);
    }
    assert.deepEqual(original, snapshot);
  }
});

test('flat and almost-vertical pens resize without moving or flattening any original X coordinate', () => {
  for (const width of [400, 800, 1600]) for (const amplitude of [0, 1e-10, 2.5 / width]) {
    const original = pen([{ x: .4, y: .2 }, { x: .4 + amplitude, y: .4 }, { x: .4 + amplitude / 3, y: .6 }, { x: .4, y: .8 }]);
    const snapshot = structuredClone(original);
    const handles = drawingResizeHandles(original, width, 500);
    assert.deepEqual(ids(handles), ['n', 's']);
    assert.equal(new Set(handles.map(handle => `${handle.x},${handle.y}`)).size, 2);
    for (const handle of handles) {
      const start = { x: handle.x + 8 / width, y: handle.y - .016 };
      const gesture = createOverlayGesture({ kind: 'resize', original, handle: handle.id, start, width, height: 500 });
      gesture.update({ x: start.x + 20 / width, y: start.y + (handle.id === 'n' ? -.1 : .1) });
      const resized = gesture.finish();
      assert.deepEqual(resized.points.map(point => point.x), original.points.map(point => point.x));
      assert.equal(resized.points.length, original.points.length);
      assert.ok(drawingBounds(resized).h > drawingBounds(original).h);
      assert.equal(resized.frame, 42);
    }
    assert.deepEqual(original, snapshot);
  }
});

test('thin-pen classification uses an inclusive 3 CSS-pixel threshold at the current display scale', () => {
  assert.equal(MIN_DRAWING_SIZE_PX, 3);
  for (const [width, height] of [[400, 225], [1000, 562.5], [1600, 900]]) {
    const horizontal = pen([{ x: .2, y: .3 }, { x: .8, y: .3 + 3 / height }]);
    const vertical = pen([{ x: .3, y: .2 }, { x: .3 + 3 / width, y: .8 }]);
    assert.deepEqual(ids(drawingResizeHandles(horizontal, width, height)), ['w', 'e']);
    assert.deepEqual(ids(drawingResizeHandles(vertical, width, height)), ['n', 's']);
    assert.equal(drawingResizeHandles(horizontal, width, height * 1.01).length, 8);
    assert.equal(drawingResizeHandles(vertical, width * 1.01, height).length, 8);
    const tiny = pen([{ x: .3, y: .3 }, { x: .3 + 3 / width, y: .3 + 3 / height }]);
    assert.deepEqual(drawingResizeHandles(tiny, width, height), [], 'tiny strokes stay movable without overlapping handles');
  }
  assert.deepEqual(drawingResizeHandles(pen([{ x: .5, y: .5 }]), 1000, 500), []);
});

test('closed shapes keep all eight resize handles and their original 3px minimum', () => {
  for (const kind of ['rect', 'ellipse']) {
    const thin = createDrawing(kind, { x: .2, y: .3 }, { x: .8, y: .3 + 2 / 500 }, style, kind);
    assert.equal(drawingResizeHandles(thin, 1000, 500).length, 8);
    const original = createDrawing(kind, { x: .2, y: .3 }, { x: .8, y: .7 }, style, kind);
    const handle = drawingResizeHandles(original, 1000, 500).find(item => item.id === 'se');
    const gesture = createOverlayGesture({ kind: 'resize', original, handle: handle.id, start: handle, width: 1000, height: 500 });
    gesture.update({ x: .1, y: .1 });
    const bounds = drawingBounds(gesture.finish());
    assert.ok(Math.abs(bounds.w * 1000 - 3) < 1e-9);
    assert.ok(Math.abs(bounds.h * 500 - 3) < 1e-9);
  }
});

test('lines and arrows retain endpoint handles and a two-dimensional pen retains every corner and edge', () => {
  for (const kind of ['line', 'arrow']) {
    const original = createDrawing(kind, { x: .2, y: .5 }, { x: .8, y: .5 }, style, kind);
    assert.deepEqual(drawingResizeHandles(original, 1000, 500), [{ id: 'start', x: .2, y: .5 }, { id: 'end', x: .8, y: .5 }]);
  }
  const original = pen([{ x: .2, y: .2 }, { x: .4, y: .3 }, { x: .8, y: .7 }]);
  const handles = drawingResizeHandles(original, 1000, 500);
  assert.deepEqual(ids(handles), ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
  assert.equal(new Set(handles.map(handle => `${handle.x},${handle.y}`)).size, 8);
});
