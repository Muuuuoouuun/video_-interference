import type { Comment, Version } from './types';

export interface ProjectedCommentRange {
  frameIn: number;
  frameOut: number;
  /** Logical source boundaries; same-version slow-motion selections can have fractional boundaries. */
  sourceIn: number;
  sourceOut: number;
}

export interface CommentProjection {
  /** unavailable also covers a surviving source interval quantized to no output frames. */
  status: 'present' | 'partial' | 'deleted' | 'unavailable';
  ranges: ProjectedCommentRange[];
  contextFrame: number | null;
  contextStatus: 'present' | 'deleted' | 'unavailable';
}

export function projectComment(comment: Pick<Comment, 'versionId' | 'frameIn' | 'frameOut' | 'contextFrame' | 'sourceRanges'>, authoredVersion: Version | undefined, targetVersion: Version): CommentProjection;
export function mapFrameBetweenVersions(from: Version | undefined, to: Version, frame: number): number | null;
