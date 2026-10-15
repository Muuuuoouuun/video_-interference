/** Parse seconds, MM:SS or HH:MM:SS with up to three fractional-second digits. */
export function parseTimecodeInput(text: string, fps?: number): number | null;
/** Keep invalid drafts unchanged, otherwise clamp the nearest frame to inclusive bounds. */
export function commitTimecodeInput(text: string, currentFrame: number, minFrame: number, maxFrame: number, fps?: number): number;
