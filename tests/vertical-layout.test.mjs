import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMELINE_HEIGHT_DEFAULT, TIMELINE_HEIGHT_MIN, TIMELINE_HEIGHT_MAX, TIMELINE_COMPACT_HEIGHT, VIEWER_MIN_HEIGHT,
  decodeTimelineHeight, sanitizeTimelineHeight, timelineHeightLimits, resolveTimelineHeight, resizeTimelineHeight,
} from '../packages/core/vertical-layout.mjs';

test('expanded timeline preferences accept only finite numbers and recover malformed storage', () => {
  assert.equal(TIMELINE_HEIGHT_DEFAULT, 240);
  for (const value of [null, undefined, true, '420', [], {}, NaN, Infinity, -Infinity]) assert.equal(sanitizeTimelineHeight(value), 240);
  assert.equal(sanitizeTimelineHeight(240.5), 240.5);
  assert.equal(sanitizeTimelineHeight(-10), 180);
  assert.equal(sanitizeTimelineHeight(900), 600);
  for (const raw of [null, '', '{', 'null', 'false', '[]', '{}', '"420"', 'Infinity']) assert.equal(decodeTimelineHeight(raw), 240);
  assert.equal(decodeTimelineHeight('420.5'), 420.5);
  assert.equal(decodeTimelineHeight('900'), 600);
});

test('normal dock height preserves controls in short workspaces and retains 180px for the viewer when both fit', () => {
  assert.equal(TIMELINE_HEIGHT_MIN, 180);
  assert.equal(TIMELINE_HEIGHT_MAX, 600);
  assert.equal(VIEWER_MIN_HEIGHT, 180);
  assert.deepEqual(timelineHeightLimits(1000), { min: 180, max: 600 });
  assert.deepEqual(timelineHeightLimits(700), { min: 180, max: 520 });
  assert.deepEqual(timelineHeightLimits(360), { min: 180, max: 180 });
  assert.deepEqual(timelineHeightLimits(300), { min: 120, max: 120 });
  assert.equal(resolveTimelineHeight(280, 700), 280);
  assert.equal(resolveTimelineHeight(600, 700), 520);
  assert.equal(resolveTimelineHeight(280, 300), 120);
  assert.equal(resolveTimelineHeight(280, 228), 48);
  assert.equal(resolveTimelineHeight(280, 180), 48);
  assert.equal(resolveTimelineHeight(280, 100), 48);
  assert.equal(resolveTimelineHeight(280, 48), 48);
  assert.equal(resolveTimelineHeight(280, 20), 20);
  assert.equal(resolveTimelineHeight(280, 0), 0);
});

test('short windows and compact mode never overwrite the expanded preference', () => {
  const preference = 510;
  assert.equal(resolveTimelineHeight(preference, 400), 220);
  assert.equal(resolveTimelineHeight(preference, 300), 120);
  assert.equal(resolveTimelineHeight(preference, 1000), preference);
  assert.equal(TIMELINE_COMPACT_HEIGHT, 48);
  for (const height of [300, 500, 1000]) {
    assert.equal(resolveTimelineHeight(preference, height, true), 48);
    assert.equal(resizeTimelineHeight(preference, -100, height, true), preference);
  }
  assert.equal(resolveTimelineHeight(preference, 1000, false), preference);
});

test('dragging upward grows the dock and downward shrinks it within visible limits', () => {
  assert.equal(resizeTimelineHeight(280, -10, 700), 290);
  assert.equal(resizeTimelineHeight(280, 10, 700), 270);
  assert.equal(resizeTimelineHeight(280, -40, 700), 320);
  assert.equal(resizeTimelineHeight(280, 40, 700), 240);
  assert.equal(resizeTimelineHeight(280, -100000, 700), 520);
  assert.equal(resizeTimelineHeight(280, 100000, 700), 180);
  assert.equal(resizeTimelineHeight(280, -100000, 1000), 600);
});

test('compressed drags start at the visible height and returning to the grab point restores the original preference', () => {
  const preference = 600;
  assert.equal(resolveTimelineHeight(preference, 600), 420);
  assert.equal(resizeTimelineHeight(preference, 1, 600), 419);
  assert.equal(resizeTimelineHeight(preference, 30, 600), 390);
  assert.equal(resizeTimelineHeight(preference, 1, 600), 419, 'total displacement does not accumulate');
  assert.equal(resizeTimelineHeight(preference, 0, 600), preference);
  assert.equal(resizeTimelineHeight(preference, -50, 600), preference, 'dragging against an existing fit limit does not replace the preference');
  assert.equal(resizeTimelineHeight(preference, 50, 300), preference, 'a forced fit below the normal minimum is not a user preference');
});

test('invalid drag geometry preserves preferences and unknown layout size resolves safely', () => {
  for (const delta of [NaN, Infinity, -Infinity, 0]) assert.equal(resizeTimelineHeight(410, delta, 800), 410);
  for (const height of [NaN, Infinity, -Infinity, -1, 0]) assert.equal(resizeTimelineHeight(410, -10, height), 410);
  for (const height of [NaN, Infinity, -1]) assert.equal(resolveTimelineHeight(410, height), 410);
});

test('resolved sizes remain inside the container budget and explicit resize choices round-trip through storage', () => {
  for (const available of [0, 20, 48, 100, 180, 228, 300, 360, 400, 500, 780, 1000]) for (const preference of [180, 280, 420.5, 600]) {
    const actual = resolveTimelineHeight(preference, available);
    assert.ok(actual >= 0 && actual <= available);
    assert.ok(actual >= Math.min(TIMELINE_COMPACT_HEIGHT, available));
    if (available >= VIEWER_MIN_HEIGHT + TIMELINE_COMPACT_HEIGHT) assert.ok(available - actual >= VIEWER_MIN_HEIGHT);
    for (const delta of [-10000, -1, 0, 1, 10000]) {
      const next = resizeTimelineHeight(preference, delta, available);
      assert.ok(next >= TIMELINE_HEIGHT_MIN && next <= TIMELINE_HEIGHT_MAX);
      assert.equal(decodeTimelineHeight(JSON.stringify(next)), next);
      const resolved = resolveTimelineHeight(next, available);
      assert.ok(resolved >= 0 && resolved <= available);
    }
  }
});
