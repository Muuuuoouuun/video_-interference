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
