import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDrawing } from '../packages/core/overlay-geometry.mjs';
import { duplicateOverlay, reorderOverlay } from '../packages/core/overlay-actions.mjs';
import { createDrawingHistoryStore } from '../packages/core/drawing-history.mjs';

const box = (id, frame, x = .2) => normalizeDrawing({ id, frame, kind: 'rect', color: '#ff7878', fill: '#ffd166', opacity: .5, strokeWidth: 8, points: [], region: { x, y: .8, w: .2, h: .2 } });

test('duplicate offsets inward, preserves content and source frame, and respects global limits', () => {
  const source = { ...box('a', 60, .8), kind: 'text', text: '확인\n<&>' };
  const other = box('b', 120);
  const drawings = [source, other];
  const next = duplicateOverlay(drawings, 'a', 60, 0, 'copy', 600, 400);
  assert.equal(next.length, 3);
  assert.equal(next[0], source);
  assert.equal(next[1], other);
  assert.equal(source.region.x, .8);
  assert.equal(next[2].id, 'copy');
  assert.equal(next[2].frame, 60);
  assert.equal(next[2].text, source.text);
  assert.equal(next[2].fill, source.fill);
  assert.equal(next[2].opacity, .5);
  assert.ok(next[2].region.x < .8 && next[2].region.y < .8);
  assert.equal(duplicateOverlay(drawings, 'a', 120, 0, 'bad', 600, 400), drawings);
  assert.equal(duplicateOverlay(drawings, 'a', 60, 0, 'bad', 600, 400, 2), drawings);
});

test('layer ordering affects only its frame and is reversible with the shared undo history', () => {
  const drawings = [box('a', 60), box('other', 120), box('b', 60), box('c', 60)];
  const next = reorderOverlay(drawings, 'a', 60, 0, 'front');
  assert.deepEqual(next.map(item => item.id), ['b', 'other', 'c', 'a']);
  assert.equal(next[1], drawings[1]);
  assert.equal(reorderOverlay(next, 'a', 60, 0, 'front'), next);
  assert.deepEqual(reorderOverlay(next, 'a', 60, 0, 'back'), drawings);
  const history = createDrawingHistoryStore().activate('draft', drawings, 0);
  assert.equal(history.commit(next), true);
  assert.deepEqual(history.undo(), drawings);
  assert.deepEqual(history.redo(), next);
});
