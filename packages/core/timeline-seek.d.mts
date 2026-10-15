/** Round the pointer position to a playable frame in [0, durationFrames - 1]; invalid geometry returns null. */
export function seekFrameAtPointer(clientX: number, left: number, width: number, durationFrames: number): number | null;
/** Arrows ±1 (Shift ±30), PageUp/Down ±150, Home/End to the first/last playable frame. */
export function timelineSeekKey(key: string, currentFrame: number, durationFrames: number, shiftKey?: boolean): number | null;
