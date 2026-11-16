import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Static contract only: these rules are what keep the desktop review on one screen.
// Actual sizes at 1280×800–1600×1000 are checked in a real browser (docs/피드백프로토타입.md).
const theme = await readFile(new URL('../apps/web/src/theme.css', import.meta.url), 'utf8');
const rule = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...theme.matchAll(new RegExp(`(?:^|[\\n{}])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map(match => match[1]).join(' ');
};

test('the feedback list scrolls on its own while the composer stays pinned in the rail', () => {
  assert.match(rule('.editor-layout > .request-rail'), /overflow:\s*hidden/);
  assert.match(rule('.request-rail .request-panel'), /min-height:\s*0/);
  assert.match(rule('.request-rail .request-list'), /overflow-y:\s*auto/);
  assert.match(rule('.request-rail .saved-context-details, .request-rail .composer-wrap, .request-rail .interpreter-note'), /flex:\s*0 0 auto/);
  assert.match(rule('.request-rail .composer-wrap'), /max-height:/, 'a long draft scrolls inside the composer instead of pushing the list out');
});

test('offscreen cards skip rendering with a remembered size, and the composer grows from one line', () => {
  const cards = rule('.request-list > .request-item');
  assert.match(cards, /content-visibility:\s*auto/);
  assert.match(cards, /contain-intrinsic-size:\s*auto\s+\d+px/);
  assert.match(rule('.composer .composer-feedback-field > textarea'), /min-height:\s*36px;[^}]*resize:\s*none/);
});

// Design scale guard: every stylesheet, so a new component cannot quietly reintroduce the old values.
const { readdir } = await import('node:fs/promises');
const styles = [];
for (const directory of ['../apps/web/src/', '../apps/web/src/components/', '../apps/web/src/ui/']) {
  let names = [];
  try { names = await readdir(new URL(directory, import.meta.url)); } catch { /* optional directory */ }
  for (const name of names.filter(file => file.endsWith('.css'))) styles.push([`${directory}${name}`, await readFile(new URL(`${directory}${name}`, import.meta.url), 'utf8')]);
}

test('no stylesheet sets text below 11px', () => {
  assert.ok(styles.length >= 20, 'the stylesheets were found');
  for (const [file, css] of styles) {
    const small = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map(match => Number(match[1])).filter(size => size < 11);
    assert.deepEqual(small, [], `${file} has text under 11px`);
  }
});

test('corner radii stay on the 2 · 4 · 6 · 8 scale', () => {
  for (const [file, css] of styles) {
    const off = [...css.matchAll(/border-radius:\s*([357])px\s*[;}]/g)].map(match => `${match[1]}px`);
    assert.deepEqual(off, [], `${file} uses a radius that was merged into the scale`);
  }
});

test('the feedback rail keeps one right edge: list and composer share an 8px scrollbar lane', () => {
  const lane = rule('.request-rail .request-list, .request-rail .composer-wrap');
  assert.match(lane, /scrollbar-gutter:\s*stable/);
  assert.match(lane, /margin-right:\s*-8px/);
  assert.match(theme, /\.request-rail \.request-list::-webkit-scrollbar, \.request-rail \.composer-wrap::-webkit-scrollbar \{ width: 8px; \}/);
});
