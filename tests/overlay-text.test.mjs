import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextDrawing, textDrawingLayout, scaleTextDrawing } from '../packages/core/overlay-text.mjs';
import { drawingBounds, resizeDrawing, translateDrawing } from '../packages/core/overlay-geometry.mjs';
import { validateDrawings, drawingsSvg } from '../apps/worker/drawings.mjs';
import { createDrawingHistoryStore } from '../packages/core/drawing-history.mjs';

const make = (text = '한글 메모\nSecond line <&>') => createTextDrawing({ id: 'text', text, point: { x: .2, y: .3 }, style: { color: '#FFFFFF', opacity: .8 }, fontSize: 32, logicalHeight: 562.5, frame: 12 });

test('same-size text replacement remains a distinct undoable edit with unchanged geometry', () => {
  const session = createDrawingHistoryStore().activate('text-draft', [make('ABCD')], 12);
  const original = session.present[0];
  assert.equal(session.commit([{ ...original, text: 'EFGH' }]), true);
  assert.equal(session.present[0].text, 'EFGH');
  assert.deepEqual(session.present[0].region, original.region);
  assert.equal(session.undo()[0].text, 'ABCD');
  assert.equal(session.redo()[0].text, 'EFGH');
});

test('multiline text survives validation, move and resize with exact anchors and unchanged source content', () => {
  const original = make(), before = structuredClone(original);
  assert.deepEqual(validateDrawings([original], { durationFrames: 30 }), [original]);
  const moved = translateDrawing(original, .1, -.2);
  assert.ok(Math.abs(moved.region.x - .3) < 1e-9);
  assert.ok(Math.abs(moved.region.y - .1) < 1e-9);
  const resized = resizeDrawing(moved, 'se', { x: .8, y: .7 });
  assert.equal(resized.text, original.text); assert.equal(resized.frame, 12);
  assert.ok(Math.abs(drawingBounds(resized).w - .5) < 1e-9);
  const layout = textDrawingLayout(resized, 562.5);
  assert.equal(layout.lines.length, 2);
  assert.ok(layout.lines.every(line => line.x >= 0 && line.x + line.width <= 1000 && line.y <= 562.5));
  assert.deepEqual(original, before);
});

test('text creation near edges and font resizing fit the full box inside the canonical viewport', () => {
  const text = createTextDrawing({ id: 'edge', text: '한'.repeat(500), point: { x: .999, y: .999 }, style: { color: '#FFFFFF' }, fontSize: 160, logicalHeight: 562.5 });
  for (const drawing of [text, scaleTextDrawing(make(), 160, 562.5)]) {
    const bounds = drawingBounds(drawing);
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.w <= 1.000001 && bounds.y + bounds.h <= 1.000001);
    assert.equal(validateDrawings([drawing]).length, 1);
  }
});

test('text SVG escapes content and rejects missing, oversized or malformed text annotations', () => {
  const drawing = make();
  const svg = drawingsSvg(1920, 1080, [drawing]);
  assert.match(svg, /Second line &lt;&amp;&gt;/);
  assert.doesNotMatch(svg, /Second line <&>/);
  assert.equal((svg.match(/<text /g) ?? []).length, 2);
  for (const bad of [{ ...drawing, text: ' ' }, { ...drawing, text: 'a'.repeat(501) }, { ...drawing, text: 'a\n'.repeat(8) }, { ...drawing, text: '\u0000' }, { ...drawing, region: undefined }, { ...drawing, kind: 'rect' }]) assert.throws(() => validateDrawings([bad]));
});
