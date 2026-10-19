export const FEEDBACK_CATEGORIES = Object.freeze(['video', 'subtitle', 'audio', 'effect']);
export const FEEDBACK_CATEGORY_LABELS = Object.freeze({ video: '영상', subtitle: '자막', audio: '사운드', effect: '효과', note: '메모' });

// Legacy requests keep a neutral video category. Never guess from user text.
export function feedbackCategory(comment) {
  return comment?.kind === 'note' ? 'note' : FEEDBACK_CATEGORIES.includes(comment?.category) ? comment.category : 'video';
}
