import type { Attachment, Comment } from './types';
import type { CommentProjection } from './comment-projection.mjs';

export type FeedbackSort = 'timeline' | 'newest';
export interface FeedbackListOptions {
  query?: string;
  sort?: FeedbackSort;
  projections?: ReadonlyMap<string, Pick<CommentProjection, 'status' | 'ranges'>>;
  attachments?: readonly Attachment[];
}
export function selectFeedbackList(comments: readonly Comment[], options?: FeedbackListOptions): Comment[];
