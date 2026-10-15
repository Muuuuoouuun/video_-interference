import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretLocal, validateAiResponse } from '../apps/worker/interpreter.mjs';

const comment = text => ({ id: 'request', versionId: 'original', frameIn: 30, frameOut: 60, contextFrame: 45, sourceRanges: [{ frameIn: 30, frameOut: 60 }], text, drawings: [], attachmentIds: [], createdAt: '2026-10-14T00:00:00Z' });
const supplement = (text, index = 1) => ({ id: `supplement-${index}`, text, createdAt: `2026-10-14T00:00:0${index}Z` });

test('a supplement supplies missing speed without changing the original instruction or anchors', () => {
  const request = { ...comment('이 구간을 빠르게 넘겨줘'), supplements: [supplement('2배속')] }, before = structuredClone(request);
  assert.ok(interpretLocal({ ...request, supplements: [] }, []).clarification);
  const result = interpretLocal(request, []);
  assert.equal(result.clarification, undefined); assert.equal(result.ops.length, 1); assert.equal(result.ops[0].params.factor, 2);
  assert.deepEqual(result.ops[0].sourceRanges, before.sourceRanges); assert.deepEqual(request, before);
});

test('a quoted supplement completes an earlier subtitle request', () => {
  const result = interpretLocal({ ...comment('자막을 넣어줘'), supplements: [supplement('“배움이 이어지는 순간”')] }, []);
  assert.equal(result.clarification, undefined); assert.equal(result.ops.length, 1); assert.equal(result.ops[0].params.text, '배움이 이어지는 순간');
});

test('different speed factors in one instruction or its supplements require clarification', () => {
  for (const request of [comment('2배속 3배속'), { ...comment('2배속'), supplements: [supplement('3배속')] }]) {
    const result = interpretLocal(request, []); assert.deepEqual(result.ops, []); assert.match(result.clarification, /서로 다른 배속/);
  }
  const repeated = interpretLocal({ ...comment('2배속'), supplements: [supplement('2배속으로 부탁해')] }, []);
  assert.equal(repeated.ops.length, 1); assert.equal(repeated.ops[0].params.factor, 2);
});

test('different subtitle texts require clarification while repeating the same literal remains valid', () => {
  for (const request of [comment('자막 “처음” 그리고 자막 “다음”'), { ...comment('자막: 처음'), supplements: [supplement('자막: 다음')] }]) {
    const result = interpretLocal(request, []); assert.deepEqual(result.ops, []); assert.match(result.clarification, /서로 다른 자막 문구/);
  }
  const repeated = interpretLocal({ ...comment('자막: 배움'), supplements: [supplement('자막 “배움”')] }, []);
  assert.equal(repeated.ops.length, 1); assert.equal(repeated.ops[0].params.text, '배움');
});

test('an explicit final speed in the newest supplement resolves conflicting factors without rewriting history', () => {
  for (const confirmation of ['최종 3배속', '확정: 3배속']) {
    const request = { ...comment('2배속'), supplements: [supplement('3배속'), supplement(confirmation, 2)] }, before = structuredClone(request);
    const result = interpretLocal(request, []); assert.equal(result.clarification, undefined); assert.equal(result.ops.length, 1); assert.equal(result.ops[0].params.factor, 3); assert.deepEqual(request, before);
  }
  const contradictoryLatest = interpretLocal({ ...comment('2배속'), supplements: [supplement('최종 3배속\n2배속')] }, []);
  assert.deepEqual(contradictoryLatest.ops, []); assert.match(contradictoryLatest.clarification, /최종 3배속/);
  const merelyLast = interpretLocal({ ...comment('2배속'), supplements: [supplement('3배속')] }, []);
  assert.deepEqual(merelyLast.ops, []);
});

test('an explicit final subtitle resolves previous literals while an ambiguous confirmation stays blocked', () => {
  const request = { ...comment('자막: 처음'), supplements: [supplement('자막: 다음'), supplement('최종 자막: 다음', 2)] }, before = structuredClone(request);
  const result = interpretLocal(request, []); assert.equal(result.clarification, undefined); assert.equal(result.ops.length, 1); assert.equal(result.ops[0].params.text, '다음'); assert.deepEqual(request, before);
  const ambiguous = interpretLocal({ ...request, supplements: [supplement('최종 자막: 다음\n자막: 다른 문구')] }, []);
  assert.deepEqual(ambiguous.ops, []); assert.match(ambiguous.clarification, /최종 자막/);
});

test('a negative supplement prevents executing a prior instruction', () => {
  const result = interpretLocal({ ...comment('삭제'), supplements: [supplement('삭제하지 마')] }, []);
  assert.deepEqual(result.ops, []); assert.ok(result.clarification);
});

test('explicit drawing insertion can be supplied later and cloud validation preserves the original vectors', () => {
  const drawings = [{ id: 'arrow', kind: 'arrow', color: '#FF0000', points: [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.7 }], strokeWidth: 4 }];
  const request = { ...comment('이 표시를 참고해줘'), drawings, supplements: [supplement('이 그림 그대로 영상에 넣어줘')] };
  assert.equal(interpretLocal({ ...request, supplements: [] }, []).ops.length, 0);
  const local = interpretLocal(request, []); assert.equal(local.ops[0].params.kind, 'drawing'); assert.deepEqual(local.ops[0].params.drawings, drawings);
  const cloud = validateAiResponse({ ops: [{ type: 'overlay', params: { kind: 'drawing' } }] }, request, []);
  assert.deepEqual(cloud.ops[0].params.drawings, drawings);
});
