import type { Comment, Drawing, Version } from './types';

export interface DrawingFrameGroup { frame: number; drawings: Drawing[] }
export interface ProjectedDrawing {
  /** Present drawings are nested clones stamped with their target-version frame. */
  drawing: Drawing;
  authoredFrame: number | null;
  frame: number | null;
  status: 'present' | 'deleted' | 'unavailable';
}

export function drawingFrame(drawing: Drawing, fallbackFrame: number): number;
export function groupDrawings(drawings: Drawing[], fallbackFrame: number): DrawingFrameGroup[];
export function projectDrawings(comment: Pick<Comment, 'versionId' | 'frameIn' | 'frameOut' | 'contextFrame' | 'sourceRanges' | 'drawings'>, authoredVersion: Version | undefined, targetVersion: Version): ProjectedDrawing[];
export function reconcileDrawingFrame(drawings: Drawing[], currentFrame: number, visibleDrawings: Drawing[], fallbackFrame?: number): Drawing[];
