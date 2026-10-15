export const TIMELINE_HEIGHT_DEFAULT: number;
export const TIMELINE_HEIGHT_MIN: number;
export const TIMELINE_HEIGHT_MAX: number;
export const TIMELINE_COMPACT_HEIGHT: number;
export const VIEWER_MIN_HEIGHT: number;
export function sanitizeTimelineHeight(value: unknown): number;
export function decodeTimelineHeight(raw: string | null): number;
export function timelineHeightLimits(availableHeight: number): { min: number; max: number };
export function resolveTimelineHeight(preferred: number, availableHeight: number, compact?: boolean): number;
/** Pass the unchanged pointer-down preference and total pointer displacement. */
export function resizeTimelineHeight(initialPreferred: number, deltaY: number, availableHeight: number, compact?: boolean): number;
