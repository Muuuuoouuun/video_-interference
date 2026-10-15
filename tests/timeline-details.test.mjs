import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimelineDetails, layoutTimelineDetails } from '../packages/core/timeline-details.mjs';

const segment = (sourceIn, sourceOut, outputIn, outputOut) => ({ sourceIn, sourceOut, outputIn, outputOut, speed: 1, volume: 1 });
const original = { id: 'original', assetId: 'asset', durationFrames: 1800, timelineMap: [segment(0, 1800, 0, 1800)] };
const cut = { id: 'cut', assetId: 'asset', durationFrames: 1500, timelineMap: [segment(0, 300, 0, 300), segment(600, 1800, 300, 1500)] };
const fast = { id: 'fast', assetId: 'asset', durationFrames: 450, timelineMap: [segment(0, 1800, 0, 450)] };
const drawing = (id, frame) => ({ id, kind: 'pen', color: '#ffffff', points: [{ x: 0.2, y: 0.3 }], ...(frame === undefined ? {} : { frame }) });
const comment = (id, frameIn, frameOut, extra = {}) => ({ id, versionId: original.id, text: `피드백 ${id}`, frameIn, frameOut, contextFrame: frameIn, sourceRanges: [{ frameIn, frameOut }], drawings: [], attachmentIds: [], ...extra });
const image = (id, role = 'reference') => ({ id, name: `${id}.png`, mimeType: 'image/png', role });
const voice = id => ({ id, name: `${id}.webm`, mimeType: 'audio/webm', role: 'voice' });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const spans = items => items.map(item => [item.kind, item.frameIn, item.frameOut, item.rangeIndex]);

test('detail tracks use only saved comment content and deduplicated actual image/voice links', () => {
  const comments = freeze([comment('a', 30, 90, { drawings: [drawing('one', 40), drawing('two', 40)], attachmentIds: ['reference', 'insert', 'reference', 'legacy-voice', 'missing'], voiceAssetId: 'voice' })]);
  const attachments = freeze([image('unrelated'), image('reference'), image('insert', 'insert'), voice('voice'), voice('legacy-voice')]);
  const before = JSON.stringify({ comments, attachments });
  const result = buildTimelineDetails(comments, [original], original, attachments);
  assert.deepEqual(spans(result.items), [['feedback', 30, 90, 0], ['drawing', 40, 41, 0], ['reference', 30, 90, 0], ['voice', 30, 90, 0]]);
  assert.deepEqual(result.items.map(item => item.number), [1, 1, 1, 1]);
  assert.equal(result.items[0].label, '피드백 a');
  assert.equal(result.items[1].drawingCount, 2);
  assert.deepEqual(result.items[2].attachmentIds, ['reference', 'insert']);
  assert.equal(result.items[2].label, 'reference.png, insert.png');
  assert.deepEqual(result.items[3].attachmentIds, ['voice', 'legacy-voice']);
  assert.deepEqual(result.unavailable, []);
  assert.equal(JSON.stringify({ comments, attachments }), before);
  assert.equal(new Set(result.items.map(item => item.id)).size, result.items.length);
});

test('cut ranges remain separate on every interval track, with independent drawings outside the feedback range', () => {
  const source = comment('split', 250, 650, { drawings: [drawing('before', 299), drawing('cut-away', 450), drawing('after', 600), drawing('outside', 1000)], attachmentIds: ['image', 'voice'] });
  const result = buildTimelineDetails([source], [original, cut], cut, [image('image'), voice('voice')]);
  for (const kind of ['feedback', 'reference', 'voice']) {
    assert.deepEqual(spans(result.items.filter(item => item.kind === kind)), [[kind, 250, 300, 0], [kind, 300, 350, 1]]);
  }
  assert.deepEqual(spans(result.items.filter(item => item.kind === 'drawing')), [['drawing', 299, 300, 0], ['drawing', 300, 301, 1], ['drawing', 700, 701, null]]);
  assert.deepEqual(result.unavailable, []);
});

test('speed changes project frame coordinates and combine drawings that land on the same output frame', () => {
  const source = comment('speed', 0, 40, { drawings: [drawing('a', 4), drawing('b', 5)], attachmentIds: ['image'] });
  const result = buildTimelineDetails([source], [original, fast], fast, [image('image')]);
  assert.deepEqual(spans(result.items), [['feedback', 0, 10, 0], ['drawing', 1, 2, 0], ['reference', 0, 10, 0]]);
  assert.equal(result.items[1].drawingCount, 2);
});

test('a deleted feedback range retains its surviving out-of-range drawings without inventing attachment intervals', () => {
  const source = comment('cut-away', 300, 600, { drawings: [drawing('survivor', 1000)], attachmentIds: ['image'], voiceAssetId: 'voice' });
  const result = buildTimelineDetails([source], [original, cut], cut, [image('image'), voice('voice')]);
  assert.deepEqual(spans(result.items), [['drawing', 700, 701, null]]);
  assert.deepEqual(result.unavailable, [{ commentId: 'cut-away', number: 1, reason: 'deleted' }]);
});

test('a quantized-away interval remains unavailable while its independently projected drawing stays visible', () => {
  const source = comment('tiny', 2, 3, { drawings: [drawing('point', 2)], attachmentIds: ['image'] });
  const result = buildTimelineDetails([source], [original, fast], fast, [image('image')]);
  assert.deepEqual(spans(result.items), [['drawing', 1, 2, null]]);
  assert.deepEqual(result.unavailable, [{ commentId: 'tiny', number: 1, reason: 'unavailable' }]);
});

test('missing versions, invalid source anchors and foreign assets are unavailable without authored-coordinate fallback', () => {
  const comments = [comment('missing-version', 30, 60, { versionId: 'missing', drawings: [drawing('a', 40)] }), comment('missing-anchors', 90, 120, { sourceRanges: undefined })];
  const result = buildTimelineDetails(comments, [original], cut, []);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.unavailable, [{ commentId: 'missing-version', number: 1, reason: 'unavailable' }, { commentId: 'missing-anchors', number: 2, reason: 'unavailable' }]);
  const foreign = buildTimelineDetails([comment('foreign', 30, 60)], [original], { ...cut, assetId: 'other' }, []);
  assert.deepEqual(foreign.items, []);
  assert.equal(foreign.unavailable[0].reason, 'unavailable');
});

test('missing and unrelated files produce no fake details, and skipped deleted comments do not renumber later cards', () => {
  const comments = [comment('trash', 0, 30, { deletedAt: '2026-10-15', attachmentIds: ['image'] }), comment('kept', 60, 90, { attachmentIds: ['missing', 'document', 'wrong-role'], voiceAssetId: 'missing-voice' })];
  const attachments = [image('image'), { id: 'document', role: 'reference', mimeType: 'application/pdf', name: 'note.pdf' }, image('wrong-role', 'unknown')];
  const result = buildTimelineDetails(comments, [original], original, attachments);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, 'feedback');
  assert.equal(result.items[0].commentId, 'kept');
  assert.equal(result.items[0].number, 2);
  assert.deepEqual(result.items[0].attachmentIds, []);
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(buildTimelineDetails([], [original], original, attachments), { items: [], unavailable: [] });
});

test('legacy drawing context is preserved and malformed explicit frames never fall back to the comment time', () => {
  const source = comment('legacy', 30, 60, { contextFrame: 720, drawings: [drawing('legacy'), drawing('bad', -1)] });
  const result = buildTimelineDetails([source], [original, cut], cut, []);
  assert.deepEqual(spans(result.items), [['feedback', 30, 60, 0], ['drawing', 420, 421, null]]);
  assert.equal(result.items[1].drawingCount, 1);
});

const detail = (id, frameIn, frameOut) => ({ id, kind: 'feedback', commentId: id, number: 1, frameIn, frameOut, rangeIndex: 0, attachmentIds: [], label: id });
function assertLayout(result, items, width) {
  assert.equal(result.entries.length, items.length);
  assert.deepEqual(new Set(result.entries.map(entry => entry.item)), new Set(items));
  for (const entry of result.entries) {
    assert.ok(entry.left >= 0);
    assert.ok(entry.left + entry.width <= width);
    assert.ok(entry.row >= 0 && entry.row < result.rows);
    assert.ok(entry.item === items.find(item => item.id === entry.item.id), 'retain the original item reference');
  }
  for (let row = 0; row < result.rows; row++) {
    const boxes = result.entries.filter(entry => entry.row === row).sort((a, b) => a.left - b.left);
    for (let index = 1; index < boxes.length; index++) assert.ok(boxes[index].left >= boxes[index - 1].left + boxes[index - 1].width + 4);
  }
}

test('detail layout keeps exact point anchors while widening edge hit areas inside the lane', () => {
  const items = freeze([detail('end', 999, 1000), detail('start', 0, 1), detail('middle', 500, 501)]);
  const result = layoutTimelineDetails(items, 1000, 500);
  assert.deepEqual(result.entries.map(entry => [entry.item.id, entry.left, entry.width, entry.anchorLeft, entry.anchorWidth]), [
    ['start', 0, 28, 0, 0.5], ['middle', 236, 28, 250, 0.5], ['end', 472, 28, 499.5, 0.5],
  ]);
  assert.equal(result.rows, 1);
  assertLayout(result, items, 500);
});

test('overlapping full spans and equal-time points pack into rows without clustering or losing chronology', () => {
  const items = freeze([detail('first', 0, 500), detail('second', 0, 1), detail('third', 0, 1), detail('fourth', 600, 800)]);
  const result = layoutTimelineDetails(items, 1000, 500);
  assert.deepEqual(result.entries.map(entry => [entry.item.id, entry.row]), [['first', 0], ['second', 1], ['third', 2], ['fourth', 0]]);
  assert.equal(result.entries[0].left, 0); assert.equal(result.entries[0].width, 250);
  assert.equal(result.entries[3].left, 300); assert.equal(result.entries[3].width, 100);
  assert.equal(result.rows, 3);
  assertLayout(result, items, 500);
});

test('narrow or unmeasured lanes never overflow or invent entries', () => {
  const items = [detail('one', 0, 1), detail('two', 99, 100)];
  const narrow = layoutTimelineDetails(items, 100, 12);
  assert.deepEqual(narrow.entries.map(entry => [entry.left, entry.width, entry.row]), [[0, 12, 0], [0, 12, 1]]);
  assertLayout(narrow, items, 12);
  for (const width of [0, -1, NaN, Infinity]) assert.deepEqual(layoutTimelineDetails(items, 100, width), { entries: [], rows: 0 });
  assert.deepEqual(layoutTimelineDetails([], 100, 500), { entries: [], rows: 0 });
});
