import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTimelineMarkers } from '../packages/core/timeline-markers.mjs';

const marker = (key, frame, number) => Object.freeze({ key, frame, number });
const keys = groups => groups.flatMap(group => group.items.map(item => item.key));
function assertFits(groups, width) {
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    assert.ok(group.left - group.width / 2 >= 0, 'hit area stays inside the start');
    assert.ok(group.left + group.width / 2 <= width, 'hit area stays inside the end');
    if (index) assert.ok(group.left - group.width / 2 >= groups[index - 1].left + groups[index - 1].width / 2 + 6, 'neighboring hit areas have a gap');
  }
}

test('isolated markers retain numbers and exact anchors, including both timeline edges', () => {
  const input = Object.freeze([marker('end', 2999, 100), marker('start', 0, 8), marker('middle', 1500, 2)]);
  const groups = layoutTimelineMarkers(input, 3000, 600);
  assert.deepEqual(keys(groups), ['start', 'middle', 'end']);
  assert.deepEqual(groups.map(group => group.items[0].number), [8, 2, 100]);
  assert.equal(groups[0].items[0], input[1]);
  assert.equal(groups[2].items[0].frame, 2999);
  assert.equal(groups[0].anchor, 0, 'start stem stays at the exact time, not the inset badge center');
  assert.equal(groups[2].anchor, 2999 / 3000 * 600);
  assertFits(groups, 600);
});

test('same-frame and nearby markers remain individually reachable in one chronological group', () => {
  const input = [marker('a', 900, 1), marker('b', 900, 2), marker('c', 901, 3), marker('d', 2700, 4)];
  const groups = layoutTimelineMarkers(input, 3000, 600);
  assert.deepEqual(groups.map(group => group.items.map(item => item.key)), [['a', 'b', 'c'], ['d']]);
  assert.deepEqual(groups[0].items.map(item => item.frame), [900, 900, 901]);
  assertFits(groups, 600);
});

test('sidebar collapse or resize can separate a cluster without dropping or renumbering feedback', () => {
  const input = [marker('a', 100, 9), marker('b', 120, 3), marker('c', 500, 1)];
  const narrow = layoutTimelineMarkers(input, 1000, 320);
  const wide = layoutTimelineMarkers(input, 1000, 2000);
  assert.equal(narrow.length, 2);
  assert.equal(wide.length, 3);
  assert.deepEqual(keys(narrow), keys(wide));
  assert.deepEqual(wide.map(group => group.items[0].number), [9, 3, 1]);
  assertFits(narrow, 320); assertFits(wide, 2000);
});

test('dense comments at edges and split ranges never obscure each other or lose identity', () => {
  const input = Array.from({ length: 800 }, (_, index) => marker(`comment-${index % 400}-range-${Math.floor(index / 400)}`, Math.round((index / 799) ** 3 * 2999), index + 1));
  for (const width of [120, 320, 680, 1280]) {
    const groups = layoutTimelineMarkers(input, 3000, width);
    assert.deepEqual(keys(groups), input.map(item => item.key));
    assert.equal(new Set(keys(groups)).size, input.length);
    assertFits(groups, width);
  }
});

test('empty or not-yet-measured timelines have no phantom marker', () => {
  assert.deepEqual(layoutTimelineMarkers([], 3000, 600), []);
  assert.deepEqual(layoutTimelineMarkers([marker('a', 1, 1)], 3000, 0), []);
});
