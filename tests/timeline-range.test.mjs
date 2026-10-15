import test from 'node:test';
import assert from 'node:assert/strict';
import { markTimelineRange } from '../packages/core/timeline-range.mjs';

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
