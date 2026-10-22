import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreviewViewport, zoomPreviewViewport, stepPreviewZoom } from '../packages/core/preview-viewport.mjs';

const landscape = { left: 0, top: 75, width: 800, height: 450 };
const fit = { zoom: 1, x: 0, y: 0 };
test('preview fit centers letterboxed footage and bounds zoom and panning without exposing empty edges', () => {
  assert.deepEqual(resolvePreviewViewport(landscape, fit), { ...landscape, ...fit });
  const zoomed = resolvePreviewViewport(landscape, { zoom: 2, x: 9999, y: -9999 });
  assert.deepEqual(zoomed, { zoom: 2, x: 400, y: -150, left: 0, top: -300, width: 1600, height: 900 });
  assert.equal(resolvePreviewViewport(landscape, { zoom: 20, x: 0, y: 0 }).zoom, 4);
  assert.equal(resolvePreviewViewport(landscape, { zoom: -1, x: 200, y: -200 }).zoom, 1);
  assert.equal(resolvePreviewViewport(landscape, { zoom: NaN, x: Infinity, y: NaN }).x, 0);
});

test('preview cursor zoom preserves the normalized scene anchor and drawing coordinates', () => {
  const anchor = { x: 300, y: 250 }, first = resolvePreviewViewport(landscape, fit);
  const next = resolvePreviewViewport(landscape, zoomPreviewViewport(landscape, fit, 2, anchor));
  const point = rect => ({ x: (anchor.x - rect.left) / rect.width, y: (anchor.y - rect.top) / rect.height });
  assert.deepEqual(point(first), point(next));
  const back = zoomPreviewViewport(landscape, next, 1, anchor);
  assert.deepEqual(back, fit);
});

test('portrait and resized viewports retain aspect ratio and recenter axes smaller than the surface', () => {
  const portrait = { left: 231.25, top: 0, width: 337.5, height: 600 };
  const rect = resolvePreviewViewport(portrait, { zoom: 2, x: 200, y: 100 });
  assert.equal(rect.x, 0); assert.equal(rect.y, 100);
  assert.equal(rect.width / rect.height, 337.5 / 600);
  const smaller = resolvePreviewViewport({ left: 0, top: 0, width: 400, height: 225 }, { zoom: 2, x: 400, y: -150 });
  assert.equal(smaller.x, 200); assert.equal(smaller.y, -112.5);
});

test('preview zoom steps recover arbitrary wheel zoom, respect both limits and leave input untouched', () => {
  assert.equal(stepPreviewZoom(1, 1), 1.25); assert.equal(stepPreviewZoom(1.38, 1), 1.5);
  assert.equal(stepPreviewZoom(1.38, -1), 1.25); assert.equal(stepPreviewZoom(4, 1), 4);
  assert.equal(stepPreviewZoom(1, -1), 1);
  const view = { zoom: 2, x: 50, y: -30 }, before = structuredClone(view);
  zoomPreviewViewport(landscape, view, 3);
  assert.deepEqual(view, before);
});
