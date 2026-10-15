import test from 'node:test';
import assert from 'node:assert/strict';
import { arrowHeadPoints, createDrawing, decimatePoints, drawingBounds, isDrawableSize, normalizeDrawing, resizeDrawing, translateDrawing } from '../packages/core/overlay-geometry.mjs';

const style = { color: '#bcf7de', strokeWidth: 3, opacity: 1, fill: 'none' };
const rectangle = () => createDrawing('rect', { x: 0.2, y: 0.3 }, { x: 0.6, y: 0.7 }, style, 'shape');
test('reverse drag produces normalized box and ellipse bounds', () => {
  const drawing = createDrawing('ellipse', { x: 0.8, y: 0.7 }, { x: 0.2, y: 0.1 }, style, 'ellipse');
  assert.deepEqual(drawing.points[0], { x: 0.2, y: 0.1 });
  assert.ok(Math.abs(drawing.region.w - 0.6) < 1e-10);
  assert.ok(Math.abs(drawing.region.h - 0.6) < 1e-10);
});
test('translation clamps entire shape without distorting dimensions or mutating source', () => {
  const original = rectangle(), moved = translateDrawing(original, 0.8, -0.9);
  assert.equal(moved.region.y, 0);
  assert.ok(Math.abs(moved.region.x + moved.region.w - 1) < 1e-10);
  assert.deepEqual(original.points[0], { x: 0.2, y: 0.3 });
  assert.ok(Math.abs(moved.region.w - original.region.w) < 1e-10);
});
test('corner resize keeps opposite corner fixed and enforces minimum dimensions', () => {
  const resized = resizeDrawing(rectangle(), 'nw', { x: 0.9, y: -1 }, { w: 0.03, h: 0.03 });
  assert.equal(resized.region.y, 0);
  assert.ok(Math.abs(resized.region.w - 0.03) < 1e-10);
  assert.ok(Math.abs(resized.region.x + resized.region.w - 0.6) < 1e-10);
});
test('arrow endpoints resize independently and pen paths scale proportionately', () => {
  const arrow = createDrawing('arrow', { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.6 }, style, 'arrow');
  const resized = resizeDrawing(arrow, 'end', { x: 1.2, y: 0.4 });
  assert.deepEqual(resized.points, [{ x: 0.2, y: 0.2 }, { x: 1, y: 0.4 }]);
  const pen = { ...arrow, kind: 'pen', points: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.3 }, { x: 0.6, y: 0.6 }] };
  const larger = resizeDrawing(pen, 'se', { x: 1, y: 1 });
  assert.ok(Math.abs(larger.points[1].x - 0.6) < 1e-10);
  assert.ok(Math.abs(larger.points[1].y - 0.4) < 1e-10);
  assert.deepEqual(drawingBounds(larger), { x: 0.2, y: 0.2, w: 0.8, h: 0.8 });
});
test('tiny geometry is rejected using screen pixels; horizontal lines remain valid', () => {
  assert.equal(isDrawableSize(createDrawing('rect', { x: 0.2, y: 0.2 }, { x: 0.201, y: 0.21 }, style, 'tiny'), 1000, 562), false);
  assert.equal(isDrawableSize(createDrawing('line', { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.2 }, style, 'line'), 1000, 562), true);
});
test('freehand decimation preserves endpoints and bounds very long zigzags at 2000 points', () => {
  const points = Array.from({ length: 8000 }, (_, index) => ({ x: index / 7999, y: index % 2 ? 0.7 : 0.3 }));
  const simplified = decimatePoints(points, 1000, 562);
  assert.ok(simplified.length <= 2000);
  assert.deepEqual(simplified[0], points[0]);
  assert.deepEqual(simplified.at(-1), points.at(-1));
  const straight = decimatePoints([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }], 1000, 562);
  assert.equal(straight.length, 2);
});
test('normalization clones points and clamps optional styles', () => {
  const original = { id: 'line', kind: 'line', color: '#fff', points: [{ x: -0.1, y: 0.5 }, { x: 1.2, y: 0.4 }], strokeWidth: 99, opacity: -1 };
  const normalized = normalizeDrawing(original);
  assert.equal(normalized.strokeWidth, 64);
  assert.equal(normalized.opacity, 0);
  assert.deepEqual(normalized.points[0], { x: 0, y: 0.5 });
  assert.notEqual(normalized.points[0], original.points[0]);
});
test('arrow head uses the native filled triangle geometry and open paths discard closed-shape fill', () => {
  const head = arrowHeadPoints({ x: 20, y: 100 }, { x: 100, y: 100 }, 3);
  assert.deepEqual(head, [{ x: 100, y: 100 }, { x: 88, y: 93.4 }, { x: 88, y: 106.6 }]);
  const pen = createDrawing('pen', { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }, { ...style, fill: '#ffffff' }, 'pen');
  assert.equal(pen.fill, 'none');
});
test('region-only and conflicting corner points preserve renderer-authoritative region during style edits', () => {
  const region = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  for (const points of [[], [{ x: 0.8, y: 0.8 }, { x: 0.9, y: 0.9 }]]) {
    const shape = { id: 'region', kind: 'ellipse', color: '#bcf7de', points, region };
    const styled = normalizeDrawing({ ...shape, opacity: 0.5, strokeWidth: 8 });
    assert.deepEqual(styled.region, region);
    assert.deepEqual(styled.points, [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.6000000000000001 }]);
    assert.notEqual(styled.region, region);
  }
});
test('region-only geometry translates and resizes using explicit updated bounds without stale region', () => {
  const shape = { id: 'region', kind: 'rect', color: '#bcf7de', points: [], region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } };
  const moved = translateDrawing(shape, 0.2, 0.1);
  assert.ok(Math.abs(moved.region.x - 0.3) < 1e-10);
  assert.ok(Math.abs(moved.region.y - 0.3) < 1e-10);
  assert.equal(moved.region.w, 0.3);
  const resized = resizeDrawing(shape, 'se', { x: 0.8, y: 0.9 });
  assert.ok(Math.abs(resized.region.w - 0.7) < 1e-10);
  assert.ok(Math.abs(resized.region.h - 0.7) < 1e-10);
  assert.deepEqual(resized.points[0], { x: 0.1, y: 0.2 });
  assert.deepEqual(shape.points, []);
  const drawing = createDrawing('rect', { x: 0.5, y: 0.5 }, { x: 0.7, y: 0.8 }, shape, 'new');
  assert.deepEqual(drawing.region, { x: 0.5, y: 0.5, w: 0.19999999999999996, h: 0.30000000000000004 });
});
test('server-tolerated fractional edge overflow preserves authoritative region with strictly normalized points', () => {
  const region = { x: 0.5, y: 0.5, w: 0.500005, h: 0.500005 };
  const drawing = normalizeDrawing({ id: 'edge', kind: 'rect', color: '#bcf7de', points: [], region });
  assert.deepEqual(drawing.region, region);
  assert.deepEqual(drawing.points.at(-1), { x: 1, y: 1 });
});
test('an intentional pen tap is a dot and translating it keeps one point and immutable input', () => {
  const dot = normalizeDrawing({ id: 'dot', kind: 'pen', color: '#bcf7de', strokeWidth: 16, points: [{ x: 0.5, y: 0.5 }] });
  assert.equal(isDrawableSize(dot, 800, 450), true);
  const moved = translateDrawing(dot, 0.2, -0.1);
  assert.deepEqual(moved.points, [{ x: 0.7, y: 0.4 }]);
  assert.deepEqual(dot.points, [{ x: 0.5, y: 0.5 }]);
  assert.notEqual(moved.points[0], dot.points[0]);
  assert.equal(isDrawableSize(createDrawing('arrow', { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, style, 'empty'), 800, 450), false);
});
