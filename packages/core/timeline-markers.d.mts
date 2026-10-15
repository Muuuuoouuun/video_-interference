export interface TimelineMarker { key: string; frame: number; number: number }
export interface TimelineMarkerGroup<T extends TimelineMarker> { key: string; items: T[]; anchor: number; left: number; width: number }
export function layoutTimelineMarkers<T extends TimelineMarker>(markers: T[], durationFrames: number, width: number): TimelineMarkerGroup<T>[];
