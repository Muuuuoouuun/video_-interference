import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFeedbackComments, renderFeedbackMarkdown } from '../apps/worker/feedback-export.mjs';

const state = { project: { id: 'project' }, versions: [{ id: 'ready', status: 'ready' }, { id: 'rendering', status: 'rendering' }], comments: [{ id: 'first', kind: 'request', createdAt: '2026-01-01' }, { id: 'note', kind: 'note', createdAt: '2026-01-02' }] };
test('feedback export includes notes by default and canonicalizes an explicit selection without changing state', () => {
  assert.deepEqual(selectFeedbackComments(state, 'ready').comments.map(comment => comment.id), ['first', 'note']);
  assert.deepEqual(selectFeedbackComments(state, 'ready', ['note', 'first']).comments.map(comment => comment.id), ['first', 'note']);
  assert.deepEqual(selectFeedbackComments(state, 'ready', ['note']).comments.map(comment => comment.id), ['note']);
  assert.deepEqual(state.comments.map(comment => comment.id), ['first', 'note']);
});

test('feedback export never silently omits an invalid or oversized requested selection', () => {
  for (const selection of [[], 'first', [null], ['first', 'first']]) assert.throws(() => selectFeedbackComments(state, 'ready', selection), error => error.status === 400);
  assert.throws(() => selectFeedbackComments(state, 'ready', ['missing']), error => error.status === 404);
  assert.throws(() => selectFeedbackComments(state, 'missing'), error => error.status === 404);
  assert.throws(() => selectFeedbackComments(state, 'rendering'), error => error.status === 409);
  assert.throws(() => selectFeedbackComments({ ...state, comments: [] }, 'ready'), error => error.status === 409);
  assert.throws(() => selectFeedbackComments({ ...state, comments: Array.from({ length: 301 }, (_, index) => ({ id: String(index), createdAt: '2026-01-01' })) }, 'ready'), error => error.status === 413 && /생략하지/.test(error.message));
});

test('deleted feedback stays out of default exports and explicit deleted selections fail', () => {
  const deleted = { ...state.comments[0], deletedAt: '2026-10-14T00:00:00Z' }, workspace = { ...state, comments: [deleted, state.comments[1]] };
  assert.deepEqual(selectFeedbackComments(workspace, 'ready').comments.map(comment => comment.id), ['note']);
  assert.throws(() => selectFeedbackComments(workspace, 'ready', ['first', 'note']), error => error.status === 404);
  assert.equal(workspace.comments[0], deleted, 'selection never removes the recoverable record');
});


test('feedback brief leads with time, scene and feedback while preserving full detail and a single-point timestamp', () => {
  const description = '장면 설명 | 첫 줄\n두 번째 줄', original = '원문 | 수정 요청\n두 번째 문장', supplement = '추가로 밝기를 낮춰 주세요.';
  const entry = { id: 'technical-id', kind: 'request', sceneDescription: { text: description }, feedback: { original, supplements: [{ text: supplement, createdAt: '2026-01-01' }] }, authored: { versionNumber: 1, frameIn: 75, frameOut: 76, contextFrame: 75 }, current: { status: 'present', ranges: [{ frameIn: 45, frameOut: 46 }], deletedSourceRanges: [] }, scenes: [{ frame: 75, file: 'scenes/still.jpg', annotatedFile: 'annotations/drawing.png' }, { frame: 90, file: 'scenes/other.jpg' }], attachments: [{ role: 'voice', name: '음성.m4a', file: 'attachments/voice.m4a' }] };
  const manifest = { project: { name: '기획 검토' }, targetVersion: { number: 2, label: '편집본' }, createdAt: '2026-01-01', feedback: [entry] };
  const result = renderFeedbackMarkdown(manifest), summary = result.split('검토 가능한')[0];
  assert.ok(summary.includes('| 시간 | 장면 내용 | 피드백 요약 | 자료 |'));
  assert.ok(summary.includes('[1. 00:01.500](#feedback-1)'));
  assert.ok(summary.includes(String.raw`장면 설명 \| 첫 줄 두 번째 줄`));
  assert.ok(summary.includes('[스틸](scenes/still.jpg)') && summary.includes('[그림](annotations/drawing.png)') && summary.includes('[첨부 1개](#feedback-1-materials)'));
  assert.ok(result.includes('작성 v1: 00:02.500\n현재 v2: 00:01.500'));
  assert.ok(!result.includes('00:02.533') && !result.includes('00:01.533') && !result.includes(entry.id));
  assert.ok(result.includes('> 원문 | 수정 요청\n> 두 번째 문장') && result.includes(`> ${supplement}`));
  assert.ok(result.includes('[00:03.000](scenes/other.jpg)') && result.includes('음성 메모 · 미전사'));
  assert.ok(result.includes('원본·편집 영상 파일은 포함하지 않았습니다.') && result.includes('외부 전송·AI 해석·음성 전사는 실행하지 않았습니다.'));
  assert.equal(entry.authored.frameOut, 76, 'readability changes leave exact frame metadata intact');
});
