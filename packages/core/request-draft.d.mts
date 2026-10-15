import type { Comment, Drawing } from './types';
import type { CommentProjection } from './comment-projection.mjs';

export function planPlayerCompose(input: {
  liveFrame: number;
  durationFrames: number;
  reviewing: boolean;
  draftReturnable: boolean;
  draftFrame: number;
  range: { in: number; out: number };
  anchorMode: 'point' | 'range';
}): { action: 'resume' | 'new' | 'focus'; frame: number; range: { in: number; out: number }; anchorMode: 'point' | 'range' } | null;

export interface ProjectedRequestDraft {
  in: number;
  out: number;
  contextFrame: number;
  drawings: Drawing[];
}

export interface DrawingFrameSelection { drawings: Drawing[]; contextFrame: number }

export function createProjectedRequestDraft(comment: Pick<Comment, 'drawings'> & Partial<Pick<Comment, 'frameIn' | 'contextFrame'>>, projection: CommentProjection | null, rangeIndex: number, copyDrawings?: boolean, drawingSelection?: DrawingFrameSelection): ProjectedRequestDraft | null;
