export interface TimelineRange { in: number; out: number }
export function markTimelineRange(input: { edge: 'in' | 'out'; frame: number; durationFrames: number; range: TimelineRange; active: boolean }): TimelineRange | null;
