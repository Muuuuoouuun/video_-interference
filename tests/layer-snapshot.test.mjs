import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLayerSnapshot } from '../packages/core/layer-snapshot.mjs';
import { validateRenderSelection } from '../apps/worker/render-validation.mjs';

const visual = (id, type = 'overlay') => ({ id, type, sourceRanges: [{ frameIn: 30, frameOut: 90 }], params: { kind: 'text', text: id }, status: 'approved' });
const change = (target, action, id = `${target.id}-${action}`) => ({ ...structuredClone(target), id, layerId: target.layerId ?? target.id, layerChange: { action, targetLayerId: target.layerId ?? target.id, targetOpId: target.id } });

test('replacement preserves stack position and stable identity without changing historical snapshots', () => {
  const lower = visual('lower'), upper = visual('upper'), parent = [lower, upper];
  const replacement = change(lower, 'replace'); replacement.params.text = 'changed';
  const child = resolveLayerSnapshot(parent, [replacement, visual('new-top')]);
  assert.deepEqual(child.map(op => op.id), ['lower-replace', 'upper', 'new-top']);
  assert.equal(child[0].layerId, 'lower'); assert.equal(child[0].layerChange, undefined);
  child[0].params.text = 'another'; child[1].params.text = 'mutated clone';
  assert.equal(parent[0].params.text, 'lower'); assert.equal(parent[1].params.text, 'upper');
  assert.equal(replacement.params.text, 'changed');
  const branch = resolveLayerSnapshot(parent, [change(upper, 'remove')]);
  assert.deepEqual(branch.map(op => op.id), ['lower']);
});

test('second-generation changes use stable layer identity plus exact current revision', () => {
  const original = visual('initial'), replaced = resolveLayerSnapshot([original], [change(original, 'replace')])[0];
  assert.deepEqual(resolveLayerSnapshot([replaced], [change(replaced, 'remove')]), []);
  assert.throws(() => resolveLayerSnapshot([replaced], [change(original, 'remove')]), /다른 내용/);
});

test('simultaneous target changes and forged targets fail before producing a snapshot', () => {
  const target = visual('target');
  assert.throws(() => resolveLayerSnapshot([target], [change(target, 'replace'), change(target, 'remove')]), /동시에/);
  assert.throws(() => resolveLayerSnapshot([], [change(target, 'replace')]), /기준 버전에 없습니다/);
  assert.throws(() => resolveLayerSnapshot([target], [{ ...change(target, 'replace'), layerId: 'another' }]), /유효하지/);
  assert.throws(() => resolveLayerSnapshot([target], [{ ...change(target, 'replace'), type: 'speed' }]), /유효하지/);
  assert.throws(() => resolveLayerSnapshot([target], [{ ...change(target, 'replace'), type: 'subtitle' }]), /종류와 원본 구간/);
  assert.throws(() => resolveLayerSnapshot([target], [{ ...change(target, 'replace'), sourceRanges: [{ frameIn: 0, frameOut: 30 }] }]), /종류와 원본 구간/);
  assert.throws(() => resolveLayerSnapshot([target], [{ ...change(target, 'replace'), layerChange: { action: 'delete', targetLayerId: 'target', targetOpId: 'target' } }]), /유효하지/);
});

test('new layers cannot reuse inherited identities or become targets within the same batch', () => {
  const target = visual('target');
  assert.throws(() => resolveLayerSnapshot([target], [visual('target')]), /識別|식별자/);
  assert.throws(() => resolveLayerSnapshot([target, { ...visual('other'), layerId: 'target' }], []), /중복/);
  assert.throws(() => resolveLayerSnapshot([], [target, change(target, 'replace')]), /기준 버전에 없습니다/);
});

test('removal survives a simultaneous cut while replacement cannot target a fully removed scene', () => {
  const target = visual('target'), cut = { id: 'cut', type: 'cut', sourceRanges: [{ frameIn: 30, frameOut: 90 }], params: {} };
  const removed = validateRenderSelection(120, [target], [cut, change(target, 'remove')]);
  assert.deepEqual(removed.snapshot.map(op => op.id), ['cut']); assert.equal(removed.timelineMap.at(-1).outputOut, 60);
  assert.throws(() => validateRenderSelection(120, [target], [cut, change(target, 'replace')]), /남지 않습니다/);
});

test('split source ranges and drawing authored metadata survive the resolver without rebasing', () => {
  const target = { ...visual('ink'), sourceRanges: [{ frameIn: 0, frameOut: 20 }, { frameIn: 40, frameOut: 60 }], params: { kind: 'drawing', drawings: [{ id: 'shape', frame: 81, points: [{ x: 0.1, y: 0.2 }] }] } };
  const replacement = change(target, 'replace'); replacement.params.drawings[0].frame = 3;
  const snapshot = resolveLayerSnapshot([target], [replacement]);
  assert.deepEqual(snapshot[0].sourceRanges, target.sourceRanges); assert.equal(snapshot[0].params.drawings[0].frame, 3);
  assert.equal(target.params.drawings[0].frame, 81);
});
