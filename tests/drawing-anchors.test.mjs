import test from 'node:test';
import assert from 'node:assert/strict';
import { drawingFrame, groupDrawings, projectDrawings, reconcileDrawingFrame } from '../packages/core/drawing-anchors.mjs';

const drawing = (id, frame) => ({ id, kind: 'pen', color: '#FFFFFF', points: [{ x: 0.2, y: 0.4 }], ...(frame === undefined ? {} : { frame }) });
const segment = (sourceIn, sourceOut, outputIn, outputOut) => ({ sourceIn, sourceOut, outputIn, outputOut, speed: 1, volume: 1 });
const original = { id: 'v1', assetId: 'asset', durationFrames: 1800, timelineMap: [segment(0, 1800, 0, 1800)] };
const cut = { id: 'v2', assetId: 'asset', durationFrames: 1500, timelineMap: [segment(0, 300, 0, 300), segment(600, 1800, 300, 1500)] };
const request = drawings => ({ versionId: 'v1', frameIn: 100, frameOut: 800, contextFrame: 450, sourceRanges: [{ frameIn: 100, frameOut: 800 }], drawings });
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };

test('absent drawing frames use the legacy context while malformed explicit frames never fall back', () => {
  assert.equal(drawingFrame(drawing('legacy'), 30), 30);
  assert.equal(drawingFrame(drawing('explicit', 50), 30), 50);
  for (const frame of [-1, 0.5, NaN, Infinity, null, '30']) assert.throws(() => drawingFrame(drawing('invalid', frame), 30), RangeError);
  assert.throws(() => drawingFrame(drawing('legacy'), undefined), RangeError);
});

test('grouping sorts frames and preserves drawing order without stamping or changing the source', () => {
  const source = freeze([drawing('later', 50), drawing('legacy'), drawing('first', 10), drawing('same-later', 50)]), before = JSON.stringify(source);
  const groups = groupDrawings(source, 10);
  assert.deepEqual(groups.map(group => [group.frame, group.drawings.map(item => item.id)]), [[10, ['legacy', 'first']], [50, ['later', 'same-later']]]);
  assert.equal(source[1].frame, undefined); assert.equal(JSON.stringify(source), before);
});

test('each drawing projects independently including legacy, deleted and out-of-range context scenes', () => {
  const comment = freeze(request([drawing('before', 299), drawing('cut-in', 300), drawing('legacy'), drawing('cut-out', 600), drawing('outside-request', 1000)]));
  const entries = projectDrawings(comment, original, cut);
  assert.deepEqual(entries.map(entry => [entry.drawing.id, entry.authoredFrame, entry.frame, entry.status]), [
    ['before', 299, 299, 'present'], ['cut-in', 300, null, 'deleted'], ['legacy', 450, null, 'deleted'], ['cut-out', 600, 300, 'present'], ['outside-request', 1000, 700, 'present'],
  ]);
  assert.equal(entries[3].drawing.frame, 300); assert.equal(comment.drawings[3].frame, 600);
  entries[3].drawing.points[0].x = 0.9; assert.equal(comment.drawings[3].points[0].x, 0.2);
  assert.equal(entries.length, comment.drawings.length, 'deleted anchors remain explicit entries, not silently dropped');
});

test('different source frames can project to one current frame without losing either drawing', () => {
  const fast = { id: 'fast', assetId: 'asset', durationFrames: 450, timelineMap: [segment(0, 1800, 0, 450)] };
  const entries = projectDrawings(request([drawing('one', 4), drawing('two', 5)]), original, fast);
  assert.deepEqual(entries.map(entry => entry.frame), [1, 1]);
  assert.deepEqual(groupDrawings(entries.map(entry => entry.drawing), 0).map(group => [group.frame, group.drawings.map(item => item.id)]), [[1, ['one', 'two']]]);
});

test('a drawing authored after a cut projects back to its original frame and identity stays exact', () => {
  const comment = { ...request([drawing('after-cut', 325)]), versionId: 'v2', frameIn: 250, frameOut: 350, contextFrame: 325, sourceRanges: [{ frameIn: 250, frameOut: 300 }, { frameIn: 600, frameOut: 650 }] };
  assert.equal(projectDrawings(comment, cut, original)[0].drawing.frame, 625);
  assert.equal(projectDrawings(comment, cut, cut)[0].drawing.frame, 325);
});

test('one malformed drawing frame or missing version marks only unavailable entries without crashing review', () => {
  const comment = request([drawing('valid', 250), drawing('bad', -1), drawing('fraction', 2.5)]);
  assert.deepEqual(projectDrawings(comment, original, cut).map(entry => [entry.authoredFrame, entry.status]), [[250, 'present'], [null, 'unavailable'], [null, 'unavailable']]);
  for (const [from, to] of [[undefined, cut], [original, { ...cut, assetId: 'other' }]]) assert.ok(projectDrawings(comment, from, to).every(entry => entry.status === 'unavailable'));
});

test('editing one frame retains drawings and order on other frames and stamps newly created drawings', () => {
  const source = freeze([drawing('a', 10), drawing('other', 20), drawing('b', 10), drawing('last', 30)]);
  const edited = { ...drawing('a', 10), color: '#FF0000' }, added = drawing('new');
  const next = reconcileDrawingFrame(source, 10, [edited, source[2], added], 0);
  assert.deepEqual(next.map(item => [item.id, item.frame]), [['a', 10], ['other', 20], ['b', 10], ['new', 10], ['last', 30]]);
  assert.equal(next[1], source[1]); assert.equal(next[4], source[3]); assert.equal(source[0].color, '#FFFFFF'); assert.equal(added.frame, undefined);
});

test('clearing a frame leaves all other groups and allows adding to a previously empty frame', () => {
  const source = freeze([drawing('legacy'), drawing('other', 20), drawing('current', 10)]);
  assert.deepEqual(reconcileDrawingFrame(source, 10, [], 10).map(item => item.id), ['other']);
  assert.deepEqual(reconcileDrawingFrame(source, 30, [drawing('new')], 10).map(item => [item.id, item.frame]), [['legacy', undefined], ['other', 20], ['current', 10], ['new', 30]]);
});

test('a stale frame update or duplicated drawing ID cannot overwrite another frame group', () => {
  const source = freeze([drawing('a', 10), drawing('other', 20)]), before = JSON.stringify(source);
  assert.throws(() => reconcileDrawingFrame(source, 10, [drawing('other')]), RangeError);
  assert.throws(() => reconcileDrawingFrame(source, 10, [drawing('a', 20)]), RangeError);
  assert.throws(() => reconcileDrawingFrame(source, 10, [drawing('new'), drawing('new')]), RangeError);
  assert.equal(JSON.stringify(source), before);
});
