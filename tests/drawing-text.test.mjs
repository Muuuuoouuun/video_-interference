import test from 'node:test';
import assert from 'node:assert/strict';
import { colorName, describeDrawing, drawingBox } from '../packages/core/drawing-text.mjs';

test('drawing sentences locate shapes by screen area, normalized span and coverage without changing input', () => {
  const box = { id: 'box', kind: 'rect', color: '#FF0000', fill: '#FF0000', points: [{ x: 0.1, y: 0.1 }, { x: 0.30000000000000004, y: 0.30000000000000004 }] }, before = JSON.stringify(box);
  assert.equal(describeDrawing(box), '빨간 박스(#FF0000, 채움) · 화면 왼쪽 위 · 가로 10–30%, 세로 10–30% (화면의 약 4%)');
  assert.deepEqual(drawingBox(box), [0.1, 0.1, 0.2, 0.2], 'compact boxes drop floating-point noise');
  assert.equal(JSON.stringify(box), before);
  const region = { kind: 'ellipse', color: '#2655e3', points: [], region: { x: 0.4, y: 0.6, w: 0.2, h: 0.3 } };
  assert.equal(describeDrawing(region), '파란 원(#2655e3) · 화면 아래쪽 가운데 · 가로 40–60%, 세로 60–90% (화면의 약 6%)');
  assert.equal(describeDrawing({ ...region, kind: 'rect', region: { x: 0.7, y: 0.4, w: 0.2, h: 0.1 }, fill: 'none' }), '파란 박스(#2655e3) · 화면 오른쪽 가운데 · 가로 70–90%, 세로 40–50% (화면의 약 2%)');
});

test('arrows and lines keep direction; pens distinguish dots, strokes and enclosing marks', () => {
  assert.equal(describeDrawing({ kind: 'arrow', color: '#FFFF00', points: [{ x: 0.1, y: 0.9 }, { x: 0.6, y: 0.2 }] }), '노란 화살표(#FFFF00) · 화면 왼쪽 아래에서 위쪽 가운데 쪽을 가리킴 · 시작 (가로 10%, 세로 90%) → 끝 (가로 60%, 세로 20%)');
  assert.match(describeDrawing({ kind: 'line', color: '#00ff00', points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] }), /^초록 선\(#00ff00\) · 화면 왼쪽 가운데에서 오른쪽 가운데까지/);
  const loop = Array.from({ length: 40 }, (_, index) => ({ x: 0.7 + 0.1 * Math.cos(index / 39 * 2 * Math.PI), y: 0.8 + 0.1 * Math.sin(index / 39 * 2 * Math.PI) }));
  assert.match(describeDrawing({ kind: 'pen', color: '#ffffff', points: loop }), /^흰 펜.*화면 오른쪽 아래.*영역을 둘러싼 표시$/);
  assert.match(describeDrawing({ kind: 'pen', color: '#000000', points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.12 }, { x: 0.9, y: 0.1 }] }), /그은 선$/);
  assert.match(describeDrawing({ kind: 'pen', color: '#000000', points: [{ x: 0.5, y: 0.1 }] }), /^검은 펜.*가로 50%, 세로 10%.*점 하나$/);
  assert.equal(describeDrawing({ kind: 'pen', color: '#123456', points: [] }), '파란 펜(#123456) · 위치 정보 없음'.replace('파란 ', `${colorName('#123456')} `));
  assert.equal(colorName('not-a-color'), '');
});
