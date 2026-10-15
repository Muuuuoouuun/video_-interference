export interface TimelineRange { in: number; out: number }
export function markTimelineRange(input: { edge: 'in' | 'out'; frame: number; durationFrames: number; range: TimelineRange; active: boolean }): TimelineRange | null;
/** Apply pointer displacement to the initial boundary; the exclusive OUT may equal durationFrames. */
export function dragTimelineBoundary(startFrame: number, deltaPixels: number, width: number, durationFrames: number): number;
export interface TimelineRangeGesture { update: (clientX: number) => void; flush: () => TimelineRange | null }
export function createTimelineRangeGesture(input: { edge: 'in' | 'out'; range: TimelineRange; startX: number; width: number; durationFrames: number }): TimelineRangeGesture;
