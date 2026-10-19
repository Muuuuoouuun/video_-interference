import type { FeedbackCategory } from './types';
export const FEEDBACK_CATEGORIES: readonly FeedbackCategory[];
export const FEEDBACK_CATEGORY_LABELS: Readonly<Record<FeedbackCategory | 'note', string>>;
export function feedbackCategory(comment?: { kind?: string; category?: string } | null): FeedbackCategory | 'note';
