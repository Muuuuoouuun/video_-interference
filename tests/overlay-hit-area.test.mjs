import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

// Inspect the real component's SVG output without launching a browser. These
// regressions cover hit geometry, not browser pointer routing or input latency.
let server, cache, OverlayEditor, css;
before(async () => {
  cache = await mkdtemp(join(tmpdir(), 'overlay-hit-'));
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: cache,
    server: { middlewareMode: true, watch: { ignored: ['**/*'] } },
    appType: 'custom', esbuild: { jsx: 'automatic' },
  });
  ({ OverlayEditor } = await server.ssrLoadModule('/apps/web/src/components/OverlayEditor.tsx'));
  css = await readFile(new URL('../apps/web/src/components/OverlayEditor.css', import.meta.url), 'utf8');
});
after(async () => { await server?.close(); if (cache) await rm(cache, { recursive: true, force: true }); });

function markup(kind, strokeWidth, width, points = [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]) {
  return renderToStaticMarkup(React.createElement(OverlayEditor, {
    drawings: [{ id: 'hit-fixture', kind, frame: 0, color: '#ffffff', strokeWidth, points }],
    currentFrame: 0, onChange() {}, viewport: { left: 0, top: 0, width, height: width * 0.5625 },
    enabled: true, onPause() {}, onBackgroundClick() {}, toolbarHost: null, resetKey: 'test',
  }));
}
const attr = (tag, name) => tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];

test('arrowhead selection covers the painted wings at every editor scale', () => {
  for (const width of [400, 1000, 1600]) for (const stroke of [3, 20, 64]) {
    const polygons = markup('arrow', stroke, width).match(/<polygon\b[^>]*>/g) ?? [];
    const painted = polygons.find(tag => attr(tag, 'fill') === '#ffffff');
    const selectable = polygons.find(tag => attr(tag, 'class')?.split(' ').includes('oe-hit-area'));
    assert.ok(painted, 'painted arrowhead exists');
    assert.ok(selectable, 'arrowhead itself must accept selection, beyond its narrow shaft');
    assert.equal(attr(selectable, 'points'), attr(painted, 'points'));
    if (stroke === 20 && width === 1000) assert.equal(attr(selectable, 'points'), '800,281.25 720,237.25 720,325.25');
  }
  assert.match(css, /\.oe-hit-area\s*\{[^}]*pointer-events:\s*all/);
});

test('line, pen and dot hit surfaces cover thick paint and retain a 14px minimum', () => {
  for (const width of [400, 1000, 1600]) for (const stroke of [0.25, 20, 64]) {
    const scale = width / 1000, expected = Math.max(14, stroke * scale);
    for (const kind of ['line', 'arrow', 'pen']) {
      const tag = (markup(kind, stroke, width).match(/<(?:line|polyline)\b[^>]*>/g) ?? []).find(tag => attr(tag, 'class') === 'oe-hit');
      assert.ok(tag, `${kind} selectable stroke exists`);
      assert.equal(Number(attr(tag, 'style')?.match(/stroke-width:([\d.]+)/)?.[1]), expected);
    }
    const circles = markup('pen', stroke, width, [{ x: 0.5, y: 0.5 }]).match(/<circle\b[^>]*>/g) ?? [];
    const dot = circles.find(tag => attr(tag, 'class')?.split(' ').includes('oe-hit-point'));
    assert.ok(dot, 'a pen tap has a filled hit surface, including its center');
    assert.ok(Number(attr(dot, 'r')) * scale >= Math.max(7, stroke * scale / 2) - 1e-9);
  }
  assert.match(css, /\.oe-hit\s*\{[^}]*vector-effect:\s*non-scaling-stroke/);
  assert.match(css, /\.oe-hit\s*\{[^}]*stroke-linecap:\s*round/);
  assert.match(css, /\.oe-hit\s*\{[^}]*stroke-linejoin:\s*round/);
  assert.match(css, /\.oe-hit-point\s*\{[^}]*pointer-events:\s*all/);
});
