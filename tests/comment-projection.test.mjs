import test from 'node:test';
import assert from 'node:assert/strict';
import { projectComment, mapFrameBetweenVersions } from '../packages/core/comment-projection.mjs';

const segment = (sourceIn, sourceOut, outputIn, outputOut, speed = 1) => ({ sourceIn, sourceOut, outputIn, outputOut, speed, volume: 1 });
const version = (id, durationFrames, timelineMap, assetId = 'asset') => ({ id, assetId, durationFrames, timelineMap });
const original = (duration = 1800) => version('original', duration, [segment(0, duration, 0, duration)]);
const request = (frameIn, frameOut, contextFrame = frameIn, extra = {}) => ({ versionId: 'original', frameIn, frameOut, contextFrame, sourceRanges: [{ frameIn, frameOut }], ...extra });
const cutVersion = () => version('cut', 1500, [segment(0, 300, 0, 300), segment(600, 1800, 300, 1500)]);
const speedVersion = () => version('speed', 1710, [segment(0, 360, 0, 360), segment(360, 540, 360, 450, 2), segment(540, 1800, 450, 1710)]);
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };

test('the 60→57 second acceptance marker at original 24s projects to output 21s', () => {
  const from = freeze(original()), to = freeze(speedVersion()), comment = freeze(request(720, 750)), before = JSON.stringify({ from, to, comment });
  assert.deepEqual(projectComment(comment, from, to), { status: 'present', ranges: [{ frameIn: 630, frameOut: 660, sourceIn: 720, sourceOut: 750 }], contextFrame: 630, contextStatus: 'present' });
  assert.equal(mapFrameBetweenVersions(from, to, 720), 630); assert.equal(mapFrameBetweenVersions(to, from, 630), 720);
  assert.equal(JSON.stringify({ from, to, comment }), before);
});

test('a completely cut request and its context remain deleted instead of moving to a nearby scene', () => {
  assert.deepEqual(projectComment(request(300, 600, 450), original(), cutVersion()), { status: 'deleted', ranges: [], contextFrame: null, contextStatus: 'deleted' });
  assert.equal(mapFrameBetweenVersions(original(), cutVersion(), 450), null);
});

test('a partially cut request keeps both surviving source spans and can lose its independent context', () => {
  assert.deepEqual(projectComment(request(250, 650, 450), original(), cutVersion()), { status: 'partial', ranges: [{ frameIn: 250, frameOut: 300, sourceIn: 250, sourceOut: 300 }, { frameIn: 300, frameOut: 350, sourceIn: 600, sourceOut: 650 }], contextFrame: null, contextStatus: 'deleted' });
});

test('a request authored across a v2 cut projects back to separate ranges in the original', () => {
  const comment = request(250, 350, 325, { versionId: 'cut', sourceRanges: [{ frameIn: 250, frameOut: 300 }, { frameIn: 600, frameOut: 650 }] });
  assert.deepEqual(projectComment(comment, cutVersion(), original()), { status: 'present', ranges: [{ frameIn: 250, frameOut: 300, sourceIn: 250, sourceOut: 300 }, { frameIn: 600, frameOut: 650, sourceIn: 600, sourceOut: 650 }], contextFrame: 625, contextStatus: 'present' });
});

test('a context frame outside the selected request range maps independently', () => {
  const result = projectComment(request(0, 30, 720), original(), speedVersion());
  assert.equal(result.status, 'present'); assert.equal(result.ranges[0].frameIn, 0); assert.equal(result.contextFrame, 630); assert.equal(result.contextStatus, 'present');
});

test('cut boundaries are half-open and do not reattach the first or last deleted frame', () => {
  for (const [frame, expected] of [[299, 299], [300, null], [599, null], [600, 300], [1799, 1499]]) {
    assert.equal(mapFrameBetweenVersions(original(), cutVersion(), frame), expected);
    const result = projectComment(request(0, 30, frame), original(), cutVersion()); assert.equal(result.contextFrame, expected); assert.equal(result.contextStatus, expected === null ? 'deleted' : 'present');
  }
});

test('unavailable authors, foreign assets and invalid maps cannot project timestamps', () => {
  for (const [from, to] of [[undefined, original()], [original(), { ...cutVersion(), assetId: 'foreign' }], [{ ...original(), id: 'different-author' }, cutVersion()], [original(), version('invalid', 1500, [segment(600, 1800, 10, 1500)])], [original(), version('invalid', 1, [null])]]) {
    assert.deepEqual(projectComment(request(0, 30), from, to), { status: 'unavailable', ranges: [], contextFrame: null, contextStatus: 'unavailable' });
  }
  assert.equal(mapFrameBetweenVersions(original(), { ...cutVersion(), assetId: 'foreign' }, 0), null);
});

test('a surviving source interval quantized to zero output frames is unavailable rather than cut', () => {
  const from = original(8), to = version('fast', 2, [segment(0, 8, 0, 2, 4)]);
  assert.deepEqual(projectComment(request(2, 3), from, to), { status: 'unavailable', ranges: [], contextFrame: 1, contextStatus: 'present' });
});

test('point rounding stays inside its surviving segment and range ends remain exclusive', () => {
  const from = original(12), to = version('fast-and-cut', 4, [segment(0, 8, 0, 2, 4), segment(10, 12, 2, 4)]);
  assert.equal(mapFrameBetweenVersions(from, to, 7), 1); assert.equal(mapFrameBetweenVersions(from, to, 8), null); assert.equal(mapFrameBetweenVersions(from, to, 9), null); assert.equal(mapFrameBetweenVersions(from, to, 10), 2);
  assert.deepEqual(projectComment(request(0, 8, 7), from, to).ranges, [{ frameIn: 0, frameOut: 2, sourceIn: 0, sourceOut: 8 }]);
  assert.equal(mapFrameBetweenVersions(original(), speedVersion(), 539), 449); assert.equal(mapFrameBetweenVersions(original(), speedVersion(), 540), 450);
});

test('only ranges consecutive in both source and output are merged across speed boundaries', () => {
  const to = version('two-speeds', 6, [segment(0, 8, 0, 2, 4), segment(8, 12, 2, 6)]);
  assert.deepEqual(projectComment(request(0, 12), original(12), to).ranges, [{ frameIn: 0, frameOut: 6, sourceIn: 0, sourceOut: 12 }]);
});

test('same-version identity preserves a one-output-frame selection in slowed footage', () => {
  const slow = version('slow', 32, [segment(0, 8, 0, 32, 0.25)]), comment = request(2, 3, 2, { versionId: 'slow', sourceRanges: [{ frameIn: 1, frameOut: 2 }] });
  assert.deepEqual(projectComment(comment, slow, slow), { status: 'present', ranges: [{ frameIn: 2, frameOut: 3, sourceIn: 0.5, sourceOut: 0.75 }], contextFrame: 2, contextStatus: 'present' });
  for (let frame = 0; frame < slow.durationFrames; frame++) assert.equal(mapFrameBetweenVersions(slow, slow, frame), frame);
});

test('quantized fragments are omitted without expanding the selected range', () => {
  const result = projectComment(request(2, 8, 2, { sourceRanges: [{ frameIn: 2, frameOut: 3 }, { frameIn: 4, frameOut: 8 }] }), original(8), version('fast', 2, [segment(0, 8, 0, 2, 4)]));
  assert.equal(result.status, 'partial'); assert.deepEqual(result.ranges, [{ frameIn: 1, frameOut: 2, sourceIn: 4, sourceOut: 8 }]);
});

test('invalid context is unavailable while the valid request range remains present', () => {
  const result = projectComment(request(0, 30, 1800), original(), cutVersion()); assert.equal(result.status, 'present'); assert.equal(result.contextFrame, null); assert.equal(result.contextStatus, 'unavailable');
  for (const frame of [-1, 0.5, 1800, NaN]) assert.equal(mapFrameBetweenVersions(original(), cutVersion(), frame), null);
});

test('overlapping and out-of-order anchor records are normalized without mutating the input', () => {
  const comment = freeze(request(720, 750, 720, { sourceRanges: [{ frameIn: 740, frameOut: 750 }, { frameIn: 720, frameOut: 745 }] }));
  assert.deepEqual(projectComment(comment, original(), speedVersion()).ranges, [{ frameIn: 630, frameOut: 660, sourceIn: 720, sourceOut: 750 }]);
  assert.equal(comment.sourceRanges[0].frameIn, 740);
});
