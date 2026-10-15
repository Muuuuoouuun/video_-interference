import test from 'node:test';
import assert from 'node:assert/strict';
import { projectComment } from '../packages/core/comment-projection.mjs';
import { createProjectedRequestDraft, planPlayerCompose } from '../packages/core/request-draft.mjs';

const segment = (sourceIn, sourceOut, outputIn, outputOut) => ({ sourceIn, sourceOut, outputIn, outputOut, speed: 1, volume: 1 });
const original = { id: 'v1', assetId: 'a', durationFrames: 1800, timelineMap: [segment(0, 1800, 0, 1800)] };
const cut = { id: 'v2', assetId: 'a', durationFrames: 1500, timelineMap: [segment(0, 300, 0, 300), segment(600, 1800, 300, 1500)] };
const comment = { versionId: 'v2', frameIn: 250, frameOut: 350, contextFrame: 325, sourceRanges: [{ frameIn: 250, frameOut: 300 }, { frameIn: 600, frameOut: 650 }], drawings: [{ id: 'drawing', kind: 'pen', color: '#fff', points: [{ x: 0.2, y: 0.4 }] }] };
const projected = projectComment(comment, cut, original);

const playerInput = { liveFrame: 900, durationFrames: 1800, reviewing: true, draftReturnable: false, draftFrame: 150, range: { in: 150, out: 240 }, anchorMode: 'range' };
test('player compose after reviewing old feedback starts at the live scene, independent of the saved interval', () => {
  assert.deepEqual(planPlayerCompose(playerInput), { action: 'new', frame: 900, range: { in: 900, out: 901 }, anchorMode: 'point' });
  assert.deepEqual(planPlayerCompose({ ...playerInput, liveFrame: 1799.9 }), { action: 'new', frame: 1799, range: { in: 1799, out: 1800 }, anchorMode: 'point' });
});
test('player compose returns to an existing draft without replacing its interval or point/range mode', () => {
  const plan = planPlayerCompose({ ...playerInput, draftReturnable: true });
  assert.equal(plan.action, 'resume'); assert.equal(plan.frame, 150); assert.equal(plan.range, playerInput.range); assert.equal(plan.anchorMode, 'range');
});
test('player compose while already writing pauses at the live frame and retains the chosen range', () => {
  const plan = planPlayerCompose({ ...playerInput, reviewing: false, draftReturnable: true });
  assert.equal(plan.action, 'focus'); assert.equal(plan.frame, 900); assert.equal(plan.range, playerInput.range); assert.equal(plan.anchorMode, 'range');
});
test('player compose bounds EOF and rejects unavailable media coordinates', () => {
  assert.equal(planPlayerCompose({ ...playerInput, liveFrame: 1800 }).frame, 1799);
  assert.equal(planPlayerCompose({ ...playerInput, liveFrame: -1 }).frame, 0);
  for (const patch of [{ liveFrame: NaN }, { durationFrames: 0 }, { durationFrames: Infinity }, { draftReturnable: true, draftFrame: NaN }]) assert.equal(planPlayerCompose({ ...playerInput, ...patch }), null);
});

test('a new request from the first split range starts inside that range and excludes the cut gap', () => {
  assert.deepEqual(createProjectedRequestDraft(comment, projected, 0), { in: 250, out: 300, contextFrame: 250, drawings: [] });
});

test('a new request from the second split range retains its context within the selected range', () => {
  assert.deepEqual(createProjectedRequestDraft(comment, projected, 1), { in: 600, out: 650, contextFrame: 625, drawings: [] });
});

test('explicit drawing copy preserves the original context and clones every nested drawing value', () => {
  const before = JSON.stringify(comment);
  const draft = createProjectedRequestDraft(comment, projected, 0, true);
  assert.deepEqual(draft, { in: 250, out: 300, contextFrame: 625, drawings: comment.drawings.map(drawing => ({ ...drawing, frame: 625 })) });
  draft.drawings[0].points[0].x = 0.8;
  assert.equal(JSON.stringify(comment), before);
});

test('a deleted independent context allows a plain request but cannot copy the old drawing', () => {
  const authored = { ...comment, versionId: 'v1', frameIn: 250, frameOut: 650, contextFrame: 450, sourceRanges: [{ frameIn: 250, frameOut: 650 }] };
  const projection = projectComment(authored, original, cut);
  assert.equal(projection.status, 'partial');
  assert.equal(createProjectedRequestDraft(authored, projection, 0, true), null);
  assert.deepEqual(createProjectedRequestDraft(authored, projection, 1), { in: 300, out: 350, contextFrame: 300, drawings: [] });
});

test('deleted, unavailable and invalid range selections cannot silently create requests elsewhere', () => {
  for (const status of ['deleted', 'unavailable']) assert.equal(createProjectedRequestDraft(comment, { ...projected, status }, 0), null);
  for (const index of [-1, 2, 0.5]) assert.equal(createProjectedRequestDraft(comment, projected, index), null);
  assert.equal(createProjectedRequestDraft(comment, null, 0), null);
});

test('the exclusive range end is not an in-range context for a plain request', () => {
  assert.equal(createProjectedRequestDraft(comment, { ...projected, contextFrame: 300 }, 0).contextFrame, 250);
});

test('multiple drawing-frame groups require an explicit choice instead of copying or dropping anchors', () => {
  const multiple = { ...comment, drawings: [{ ...comment.drawings[0], frame: 325 }, { ...comment.drawings[0], id: 'other', frame: 275 }] };
  assert.equal(createProjectedRequestDraft(multiple, projected, 0, true), null);
  const selected = { contextFrame: 625, drawings: [{ ...multiple.drawings[0], frame: 625 }] };
  const draft = createProjectedRequestDraft(multiple, projected, 0, true, selected);
  assert.equal(draft.contextFrame, 625); assert.deepEqual(draft.drawings.map(item => [item.id, item.frame]), [['drawing', 625]]);
  draft.drawings[0].points[0].x = 0.8; assert.equal(multiple.drawings[0].points[0].x, 0.2);
});

test('an explicitly selected surviving drawing group can copy even when the request context was deleted', () => {
  const missingContext = { ...projected, contextFrame: null, contextStatus: 'deleted' };
  const draft = createProjectedRequestDraft(comment, missingContext, 0, true, { contextFrame: 270, drawings: [{ ...comment.drawings[0], frame: 270 }] });
  assert.equal(draft.contextFrame, 270); assert.equal(draft.drawings[0].frame, 270);
  assert.equal(createProjectedRequestDraft(comment, missingContext, 0, true), null);
});

test('explicit copy selections reject mixed-frame geometry instead of reanchoring it silently', () => {
  for (const selection of [{ contextFrame: -1, drawings: comment.drawings }, { contextFrame: 625, drawings: [] }, { contextFrame: 625, drawings: [{ ...comment.drawings[0], frame: 624 }] }]) {
    assert.equal(createProjectedRequestDraft(comment, projected, 0, true, selection), null);
  }
});
