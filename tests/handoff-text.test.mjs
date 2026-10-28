import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFeedbackJsonl, renderFeedbackVtt, entryDigest } from '../apps/worker/handoff.mjs';
import { parseSceneCuts, shotsFromCuts } from '../apps/worker/overview.mjs';

const entry = (number, changes = {}) => ({
  id: `feedback-${number}`, number, kind: 'request', sceneDescription: { source: 'user', text: '' }, feedback: { original: `요청 ${number}`, supplements: [] },
  authored: { versionId: 'v1', versionNumber: 1, frameIn: 30, frameOut: 31, contextFrame: 30, sourceRanges: [{ frameIn: 30, frameOut: 31 }] },
  current: { versionId: 'v2', status: 'present', ranges: [{ frameIn: 30, frameOut: 31 }], contextFrame: 30, contextStatus: 'present', deletedSourceRanges: [] },
  drawings: [], drawingProjection: [], scenes: [{ frame: 30, roles: ['comment-context'], drawingIds: [], file: 'scenes/version-001/frame-000030.jpg' }],
  sheet: { file: `sheets/feedback-000${number}.jpg`, width: 960, height: 560, cells: [] }, attachments: [], ...changes,
});
const manifest = feedback => ({ kind: 'video-feedback-handoff', schemaVersion: 2, project: { name: '검증' }, targetVersion: { number: 2, label: '편집본', durationFrames: 90 }, frameConvention: '30fps; half-open ranges [frameIn,frameOut)', stats: {}, localOnly: true, modelCalled: false, networkUsed: false, sourceVideoIncluded: false, renderedVideoIncluded: false, feedback });

test('WebVTT keeps exact ranges, lengthens only point cues for display and never moves deleted feedback onto the timeline', () => {
  const partial = entry(2, { feedback: { original: 'a --> b <b>강조</b> & 줄\n\n다음 줄', supplements: [{ id: 's', text: '보완 문장' }] }, current: { versionId: 'v2', status: 'partial', ranges: [{ frameIn: 0, frameOut: 15 }, { frameIn: 45, frameOut: 60 }], contextFrame: null, contextStatus: 'deleted', deletedSourceRanges: [{ frameIn: 15, frameOut: 30 }] } });
  const deleted = entry(3, { current: { versionId: 'v2', status: 'deleted', ranges: [], contextFrame: null, contextStatus: 'deleted', deletedSourceRanges: [{ frameIn: 30, frameOut: 31 }] } });
  const nearEnd = entry(4, { current: { ...entry(4).current, ranges: [{ frameIn: 80, frameOut: 81 }] } });
  const voice = entry(5, { attachments: [{ id: 'voice', name: 'v.m4a', role: 'voice', mimeType: 'audio/mp4', file: 'attachments/asset-0001.m4a', transcript: { source: 'asr', engine: 'whisper.cpp', model: 'ggml-base.bin', language: 'ko', text: '자막을 조금 더 크게', segments: [], createdAt: '2026-10-15T00:00:00Z' } }] });
  const vtt = renderFeedbackVtt(manifest([entry(1), partial, deleted, nearEnd, voice]));
  assert.ok(vtt.startsWith('WEBVTT')); assert.ok(!/\n\n\n/.test(vtt));
  assert.match(vtt, /feedback-1\n00:00:01\.000 --> 00:00:03\.000\n\[1\] 피드백: 요청 1/, 'a one-frame point is shown for two seconds');
  assert.match(vtt, /feedback-4\n00:00:02\.667 --> 00:00:03\.000\n/, 'display lengthening stops at the version end');
  assert.match(vtt, /feedback-2-1\n00:00:00\.000 --> 00:00:00\.500\n/); assert.match(vtt, /feedback-2-2\n00:00:01\.500 --> 00:00:02\.000\n/);
  assert.ok(vtt.includes('a → b &lt;b&gt;강조&lt;/b&gt; &amp; 줄 다음 줄'), 'cue text cannot open a new cue, tag or blank line');
  assert.equal(vtt.split('-->').length - 1, 5, 'only cue timing lines contain an arrow');
  assert.ok(!/^feedback-3$/m.test(vtt)); assert.match(vtt, /NOTE\n현재 버전에 위치가 없는 피드백 1개[^\n]*\n\[3\] 작성 v1 00:01\.000/);
  assert.match(vtt, /음성\(자동 받아쓰기\): 자막을 조금 더 크게/);
});

test('JSONL starts with a handoff header and keeps one parseable line per feedback in reading order', () => {
  const drawing = { id: 'd', kind: 'rect', color: '#FF0000', points: [{ x: 0.1, y: 0.1 }, { x: 0.30000000000000004, y: 0.2 }], frame: 30 };
  const marked = entry(1, { drawings: [drawing], drawingProjection: [{ id: 'd', authoredFrame: 30, frame: 30, status: 'present', description: '빨간 박스(#FF0000) · 화면 왼쪽 위' }], sceneDescription: { source: 'user', text: '줄\n바꿈' } });
  const lines = renderFeedbackJsonl(manifest([marked, entry(2, { kind: 'note' })])).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 3); assert.equal(lines[0].type, 'handoff'); assert.equal(lines[0].target.duration, '00:03.000');
  assert.deepEqual(lines[1].drawings, [{ kind: 'rect', color: '#FF0000', at: '00:01.000', current: '00:01.000', where: '빨간 박스(#FF0000) · 화면 왼쪽 위', box: [0.1, 0.1, 0.2, 0.1] }]);
  assert.deepEqual(lines[1].scene, { text: '줄\n바꿈', source: 'user' }); assert.equal(lines[2].kind, 'note'); assert.equal(lines[2].scene, null);
  assert.deepEqual(lines[1].images, { sheet: 'sheets/feedback-0001.jpg', context: 'scenes/version-001/frame-000030.jpg', annotated: [], stills: ['scenes/version-001/frame-000030.jpg'] });
});

test('entry digests change with what a model saw, not with presentation-only fields', () => {
  const base = entry(1), same = { ...entry(1), number: 9, sheet: undefined };
  assert.equal(entryDigest(base), entryDigest(same));
  assert.notEqual(entryDigest(base), entryDigest(entry(1, { feedback: { original: '요청 1', supplements: [{ id: 's', text: '추가' }] } })));
});

test('scene cut parsing converts framemd5 timestamps to canonical frames and closes contiguous shots', () => {
  const framemd5 = '#tb 0: 1/15360\n#stream#, dts, pts, duration, size, hash\n0, 15360, 15360, 512, 100, abc\n0, 46080, 46080, 512, 100, def\n0, 0, 0, 512, 100, start\n';
  assert.deepEqual(parseSceneCuts(framemd5, 120), [30, 90]);
  assert.deepEqual(shotsFromCuts([30, 90], 120), [{ index: 1, frameIn: 0, frameOut: 30 }, { index: 2, frameIn: 30, frameOut: 90 }, { index: 3, frameIn: 90, frameOut: 120 }]);
  assert.deepEqual(shotsFromCuts([], 120), [{ index: 1, frameIn: 0, frameOut: 120 }]);
  assert.throws(() => parseSceneCuts('no header', 120));
});
