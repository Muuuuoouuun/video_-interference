import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeComposerDraft, encodeComposerDraft } from '../packages/core/composer-draft.mjs';

const base = { versionId: 'v1', text: '자막을 아래로', sceneDescription: '', kind: 'request', category: 'subtitle', anchor: { mode: 'range', in: 30, out: 90, contextFrame: 45 } };

test('composer drafts round-trip text, category and the authored anchor for the same version only', () => {
  const raw = encodeComposerDraft({ ...base, savedAt: '2026-11-11T00:00:00.000Z' });
  assert.deepEqual(decodeComposerDraft(raw, 'v1', 300), { ...base, savedAt: '2026-11-11T00:00:00.000Z' });
  assert.equal(decodeComposerDraft(raw, 'v2', 300), null, 'a draft never moves to another version');
  assert.equal(decodeComposerDraft(raw, 'v1', 60), null, 'anchors outside the current duration are rejected');
});

test('empty drafts are not stored and malformed storage recovers to no draft', () => {
  assert.equal(encodeComposerDraft({ ...base, text: '   ', sceneDescription: '' }), null);
  assert.equal(encodeComposerDraft({ ...base, versionId: '' }), null);
  for (const raw of [null, '', '{', 'null', '[]', '"x"', JSON.stringify({ versionId: 'v1', text: 'a' }),
    JSON.stringify({ ...base, anchor: { in: 10, out: 10, contextFrame: 10 } }), JSON.stringify({ ...base, anchor: { in: -1, out: 4, contextFrame: 0 } }),
    JSON.stringify({ ...base, anchor: { in: 1.5, out: 4, contextFrame: 2 } })]) {
    assert.equal(decodeComposerDraft(raw, 'v1', 300), null, String(raw));
  }
});

test('decoded drafts normalize unknown kinds, categories and single-frame ranges', () => {
  const raw = JSON.stringify({ ...base, kind: 'other', category: 'guess', anchor: { mode: 'range', in: 5, out: 6, contextFrame: 5 } });
  const draft = decodeComposerDraft(raw, 'v1', 300);
  assert.equal(draft.kind, 'request'); assert.equal(draft.category, 'video'); assert.equal(draft.anchor.mode, 'point');
  const note = decodeComposerDraft(encodeComposerDraft({ ...base, kind: 'note', text: '', sceneDescription: '제품 소개 장면' }), 'v1');
  assert.equal(note.kind, 'note'); assert.equal(note.sceneDescription, '제품 소개 장면');
});
