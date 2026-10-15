import type { Attachment, Comment, Version } from './types';

export interface TimelineDetailItem {
  id: string;
  kind: 'feedback' | 'drawing' | 'reference' | 'voice';
  commentId: string;
  /** Original comment-array index + 1, including gaps left by deleted entries. */
  number: number;
  frameIn: number;
  frameOut: number;
  rangeIndex: number | null;
  drawingCount?: number;
  attachmentIds: string[];
  label: string;
}
export interface UnavailableTimelineDetail { commentId: string; number: number; reason: 'deleted' | 'unavailable' }
export interface TimelineDetails { items: TimelineDetailItem[]; unavailable: UnavailableTimelineDetail[] }
export function buildTimelineDetails(comments: readonly Comment[], versions: readonly Version[], currentVersion: Version, attachments: readonly Attachment[]): TimelineDetails;
export interface TimelineDetailLayoutEntry { item: TimelineDetailItem; left: number; width: number; anchorLeft: number; anchorWidth: number; row: number }
export interface TimelineDetailsLayout { entries: TimelineDetailLayoutEntry[]; rows: number }
export function layoutTimelineDetails(items: readonly TimelineDetailItem[], durationFrames: number, width: number): TimelineDetailsLayout;
