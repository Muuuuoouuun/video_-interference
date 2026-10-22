import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackCategory, FEEDBACK_CATEGORIES } from '../packages/core/feedback-category.mjs';

test('explicit feedback categories survive unrelated text changes; legacy feedback stays video', () => {
  for (const category of FEEDBACK_CATEGORIES) {
    assert.equal(feedbackCategory({ category, text: '자막·사운드·효과를 모두 이야기해도 직접 고른 분야 유지' }), category);
  }
  for (const comment of [undefined, {}, { text: '사운드 조절' }, { category: 'unknown' }]) assert.equal(feedbackCategory(comment), 'video');
});

test('notes stay notes regardless of any retained request category', () => {
  for (const category of [undefined, ...FEEDBACK_CATEGORIES]) assert.equal(feedbackCategory({ kind: 'note', category }), 'note');
});
