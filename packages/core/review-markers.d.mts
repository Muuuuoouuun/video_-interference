interface FrameMarker { frame: number }
export function markerAt<T extends FrameMarker>(markers: readonly T[], frame: number): T | undefined;
export function adjacentMarkerFrame(markers: readonly FrameMarker[], frame: number, direction: -1 | 1): number | null;
export function markerLoopRange(markers: readonly FrameMarker[], frame: number, durationFrames: number): { in: number; out: number } | null;
