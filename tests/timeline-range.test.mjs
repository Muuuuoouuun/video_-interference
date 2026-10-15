import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimelineRangeGesture, dragTimelineBoundary, markTimelineRange } from '../packages/core/timeline-range.mjs';

const mark = (edge, frame, active, range = { in: 150, out: 270 }, durationFrames = 600) => markTimelineRange({ edge, frame, active, range, durationFrames });

test('the first IN or OUT after clearing starts at the playhead and never revives an old interval', () => {
  for (const edge of ['in', 'out']) {
    assert.deepEqual(mark(edge, 420, false), { in: 420, out: 421 });
    assert.deepEqual(mark(edge, 20, false, { in: NaN, out: Infinity }), { in: 20, out: 21 });
  }
});

test('later IN and OUT marks extend or shorten the active interval with exclusive OUT', () => {
  const start = mark('in', 120, false);
  assert.deepEqual(mark('out', 180, true, start), { in: 120, out: 181 });
  assert.deepEqual(mark('in', 160, true, { in: 120, out: 181 }), { in: 160, out: 181 });
  assert.deepEqual(mark('in', 300, true), { in: 300, out: 301 });
  assert.deepEqual(mark('out', 20, true), { in: 20, out: 21 });
});

test('range marking bounds EOF and one-frame media without creating empty intervals', () => {
  for (const edge of ['in', 'out']) {
    assert.deepEqual(mark(edge, 600, false), { in: 599, out: 600 });
    assert.deepEqual(mark(edge, -1, false), { in: 0, out: 1 });
    assert.deepEqual(mark(edge, 0, true, { in: 0, out: 1 }, 1), { in: 0, out: 1 });
  }
  assert.equal(mark('in', NaN, false), null);
  assert.equal(mark('in', 0, false, { in: 0, out: 1 }, 0), null);
  assert.equal(mark('out', 0, true, { in: 0, out: NaN }), null);
});

test('grabbing either side of a wide range handle never changes the frame until the pointer moves', () => {
  for (const startFrame of [0, 150, 270, 1050]) {
    for (const grabOffset of [-10, -5, 0, 5, 10]) {
      const pointerDown = 200 + grabOffset;
      assert.equal(dragTimelineBoundary(startFrame, pointerDown - pointerDown, 600, 1050), startFrame);
      assert.equal(dragTimelineBoundary(startFrame, pointerDown + 8 - pointerDown, 600, 1050), Math.min(1050, startFrame + 14));
      assert.equal(dragTimelineBoundary(startFrame, pointerDown - 8 - pointerDown, 600, 1050), Math.max(0, startFrame - 14));
    }
  }
});

test('boundary drags round from the initial frame without accumulating movement and preserve exclusive EOF', () => {
  assert.equal(dragTimelineBoundary(150, 0.2, 600, 1050), 150);
  assert.equal(dragTimelineBoundary(150, 0.4, 600, 1050), 151);
  assert.equal(dragTimelineBoundary(150, -0.2, 600, 1050), 150);
  assert.equal(dragTimelineBoundary(150, -0.4, 600, 1050), 149);
  assert.equal(dragTimelineBoundary(150, 0, 600, 1050), 150, 'returning to the grab position restores the original boundary');
  assert.equal(dragTimelineBoundary(150, -500, 600, 1050), 0);
  assert.equal(dragTimelineBoundary(270, 500, 600, 1050), 1050);
  assert.equal(dragTimelineBoundary(1050, 10, 600, 1050), 1050);
  assert.equal(dragTimelineBoundary(1050, -8, 600, 1050), 1036);
});

test('an unavailable timeline measurement or invalid pointer displacement preserves the grabbed boundary', () => {
  for (const width of [0, -1, NaN, Infinity]) assert.equal(dragTimelineBoundary(150, 10, width, 1050), 150);
  for (const delta of [NaN, Infinity, -Infinity]) assert.equal(dragTimelineBoundary(150, delta, 600, 1050), 150);
  for (const duration of [0, -1, NaN, Infinity, 1.5]) assert.equal(dragTimelineBoundary(150, 10, 600, duration), 150);
  assert.equal(dragTimelineBoundary(NaN, 10, 600, 1050), NaN);
});

test('range dragging coalesces a burst of pointer samples into the latest range', () => {
  const gesture = createTimelineRangeGesture({ edge: 'out', range: { in: 150, out: 270 }, startX: 200, width: 600, durationFrames: 900 });
  assert.equal(gesture.flush(), null, 'grabbing a handle does not publish an unchanged range');
  for (let offset = 1; offset <= 100; offset++) gesture.update(200 + offset);
  assert.deepEqual(gesture.flush(), { in: 150, out: 420 });
  assert.equal(gesture.flush(), null);
  gesture.update(300.1);
  assert.equal(gesture.flush(), null, 'sub-frame motion does not re-render the workspace');
  gesture.update(301);
  assert.deepEqual(gesture.flush(), { in: 150, out: 422 }, 'the final pointer-up position can be flushed before the next display frame');
});

test('range gestures keep the opposite edge fixed, preserve one frame and recover after overshoot', () => {
  for (const edge of ['in', 'out']) {
    const gesture = createTimelineRangeGesture({ edge, range: { in: 150, out: 270 }, startX: 200, width: 600, durationFrames: 900 });
    gesture.update(-1000);
    assert.deepEqual(gesture.flush(), edge === 'in' ? { in: 0, out: 270 } : { in: 150, out: 151 });
    gesture.update(2000);
    assert.deepEqual(gesture.flush(), edge === 'in' ? { in: 269, out: 270 } : { in: 150, out: 900 });
    gesture.update(200);
    assert.deepEqual(gesture.flush(), { in: 150, out: 270 });
  }
});

test('range gesture snapshots its bounds and ignores non-finite pointer samples', () => {
  const range = { in: 150, out: 270 };
  const gesture = createTimelineRangeGesture({ edge: 'in', range, startX: 200, width: 600, durationFrames: 900 });
  range.out = 180;
  gesture.update(240);
  for (const value of [NaN, Infinity, -Infinity]) gesture.update(value);
  assert.deepEqual(gesture.flush(), { in: 210, out: 270 });
});
