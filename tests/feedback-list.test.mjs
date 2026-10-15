import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFeedbackList } from '../packages/core/feedback-list.mjs';

const comment = (id, extra = {}) => ({ id, text: '', sceneDescription: '', attachmentIds: [], supplements: [], createdAt: '2026-10-14T00:00:00Z', ...extra });
const projected = (frameIn, status = 'present') => ({ status, ranges: [{ frameIn, frameOut: frameIn + 1 }] });
const ids = rows => rows.map(row => row.id);

test('search covers saved scene, feedback, supplements and only linked image/voice filenames across words', () => {
  const comments = [comment('a', { text: '로고를 키워주세요', sceneDescription: '카페 앞 장면', supplements: [{ text: '오른쪽 위에 배치' }], attachmentIds: ['image'] }), comment('b', { voiceAssetId: 'voice' }), comment('c')];
  const attachments = [{ id: 'image', name: 'Brand Reference.PNG' }, { id: 'voice', name: '목소리 메모.m4a' }, { id: 'unlinked', name: '숨겨진 사진.png' }];
  assert.deepEqual(ids(selectFeedbackList(comments, { query: ' 카페   오른쪽 BRAND ', attachments })), ['a']);
  assert.deepEqual(ids(selectFeedbackList(comments, { query: '목소리', attachments })), ['b']);
  assert.deepEqual(ids(selectFeedbackList(comments, { query: '숨겨진', attachments })), []);
  assert.deepEqual(ids(selectFeedbackList(comments, { query: '카페 목소리', attachments })), []);
});

test('search normalizes decomposed Korean filenames and full-width case without treating punctuation as regex', () => {
  const comments = [comment('a', { text: 'ＡＢＣ', attachmentIds: ['image'] })];
  const attachments = [{ id: 'image', name: '참고[1].PNG'.normalize('NFD') }];
  assert.deepEqual(ids(selectFeedbackList(comments, { query: 'abc 참고[1]', attachments })), ['a']);
  assert.deepEqual(ids(selectFeedbackList(comments, { query: '[2]', attachments })), []);
});

test('timeline sort uses the earliest surviving current-version range and places deleted or unavailable anchors last', () => {
  const comments = [comment('deleted', { frameIn: 0 }), comment('later', { frameIn: 1 }), comment('partial', { frameIn: 999 }), comment('unavailable', { frameIn: 2 }), comment('earliest')];
  const projections = new Map([
    ['deleted', { ...projected(0), status: 'deleted', contextFrame: 0 }], ['later', projected(100)],
    ['partial', { status: 'partial', ranges: [{ frameIn: 80, frameOut: 90 }, { frameIn: 30, frameOut: 40 }], contextFrame: 1 }],
    ['unavailable', { ...projected(2), status: 'unavailable', contextFrame: 2 }], ['earliest', projected(10)],
  ]);
  assert.deepEqual(ids(selectFeedbackList(comments, { projections })), ['earliest', 'partial', 'later', 'deleted', 'unavailable']);
});

test('missing and invalid mapped ranges never fall back to authored or context times; ties retain input order', () => {
  const comments = [comment('missing', { frameIn: 0 }), comment('tie1'), comment('invalid'), comment('tie2'), comment('empty')];
  const projections = new Map([
    ['tie1', projected(50)], ['tie2', projected(50)],
    ['invalid', { status: 'present', ranges: [{ frameIn: -1, frameOut: 10 }, { frameIn: 0, frameOut: 0 }, { frameIn: NaN, frameOut: 1 }], contextFrame: 0 }],
    ['empty', { status: 'partial', ranges: [], contextFrame: 0 }],
  ]);
  assert.deepEqual(ids(selectFeedbackList(comments, { projections })), ['tie1', 'tie2', 'missing', 'invalid', 'empty']);
});

test('newest means creation time, not last edit, with deterministic ties and unknown dates last', () => {
  const comments = [comment('old', { updatedAt: '2026-12-01T00:00:00Z' }), comment('unknown', { createdAt: 'invalid' }), comment('new1', { createdAt: '2026-10-15T00:00:00Z' }), comment('new2', { createdAt: '2026-10-15T00:00:00Z' })];
  assert.deepEqual(ids(selectFeedbackList(comments, { sort: 'newest' })), ['new1', 'new2', 'old', 'unknown']);
});

test('search and ordering retain the original objects and never change source numbering or anchors', () => {
  const first = Object.freeze(comment('one', { text: '로고', frameIn: 300 })), second = Object.freeze(comment('two', { text: '로고', frameIn: 100 }));
  const comments = Object.freeze([first, second]);
  const projections = new Map([['one', projected(30)], ['two', projected(10)]]);
  const numbering = new Map(comments.map((item, index) => [item.id, index + 1]));
  const result = selectFeedbackList(comments, { query: '로고', projections });
  assert.deepEqual(ids(result), ['two', 'one']);
  assert.deepEqual(result.map(item => numbering.get(item.id)), [2, 1]);
  assert.equal(result[0], second); assert.equal(result[1], first);
  assert.deepEqual(ids(comments), ['one', 'two']); assert.equal(first.frameIn, 300);
  assert.deepEqual(selectFeedbackList(comments, { query: '   ' }), [first, second]);
});
