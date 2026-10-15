import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRenderSelection } from '../apps/worker/render-validation.mjs';
import { mapToOutput } from '../apps/worker/engine.mjs';

const op = (type, frameIn, frameOut, params = {}) => ({ id: `${type}-${frameIn}-${frameOut}`, type, sourceRanges: [{ frameIn, frameOut }], params, status: 'approved' });

test('simultaneously selected overlapping speeds with different factors are rejected', () => {
  assert.throws(() => validateRenderSelection(180, [], [op('speed', 30, 90, { factor: 2 }), op('speed', 60, 120, { factor: 3 })]), error => error.status === 409);
  assert.doesNotThrow(() => validateRenderSelection(180, [], [op('speed', 30, 90, { factor: 2 }), op('speed', 60, 120, { factor: 2 })]));
  assert.doesNotThrow(() => validateRenderSelection(180, [], [op('speed', 30, 60, { factor: 2 }), op('speed', 60, 90, { factor: 3 })]));
});

test('a later version may deliberately replace its inherited source speed', () => {
  const result = validateRenderSelection(180, [op('speed', 30, 90, { factor: 2 })], [op('speed', 30, 90, { factor: 3 })]);
  assert.equal(result.timelineMap.find(segment => segment.sourceIn === 30).speed, 3);
});

test('new requests wholly removed by the final cut are blocked before rendering', () => {
  for (const type of ['subtitle', 'overlay', 'audio', 'speed']) {
    const request = op(type, 30, 60, type === 'speed' ? { factor: 2 } : type === 'audio' ? { volume: 0.5 } : {});
    assert.throws(() => validateRenderSelection(180, [], [op('cut', 30, 60), request]), error => error.status === 409);
  }
  assert.doesNotThrow(() => validateRenderSelection(180, [], [op('cut', 30, 60), op('subtitle', 30, 90, { text: 'part remains' })]));
});

test('removing an inherited layer is allowed and keeps its historical snapshot unchanged', () => {
  const inherited = [op('overlay', 30, 60, { kind: 'drawing', drawings: [{ id: 'saved', kind: 'pen', color: '#FFFFFF', points: [{ x: 0.1, y: 0.1 }] }] })];
  const result = validateRenderSelection(180, inherited, [op('cut', 30, 60)]);
  assert.equal(mapToOutput(result.timelineMap, inherited[0].sourceRanges).length, 0);
  result.snapshot[0].params.drawings[0].color = '#000000';
  assert.equal(inherited[0].params.drawings[0].color, '#FFFFFF');
});

test('the existing temporal segment capacity is checked on source operations before a job starts', () => {
  const speeds = Array.from({ length: 51 }, (_, index) => ({ ...op('speed', index * 3 + 1, index * 3 + 2, { factor: 2 }), id: `speed-${index}` }));
  assert.throws(() => validateRenderSelection(180, [], speeds), /100개의 편집 구간/);
});
