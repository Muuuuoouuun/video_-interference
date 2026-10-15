export const TIMELINE_HEIGHT_DEFAULT = 280;
export const TIMELINE_HEIGHT_MIN = 180;
export const TIMELINE_HEIGHT_MAX = 600;
export const TIMELINE_COMPACT_HEIGHT = 48;
export const VIEWER_MIN_HEIGHT = 180;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Persist the expanded preference, never a temporary fit to a short workspace. */
export function sanitizeTimelineHeight(value) {
  return Number.isFinite(value) ? clamp(value, TIMELINE_HEIGHT_MIN, TIMELINE_HEIGHT_MAX) : TIMELINE_HEIGHT_DEFAULT;
}

export function decodeTimelineHeight(raw) {
  if (typeof raw !== 'string') return TIMELINE_HEIGHT_DEFAULT;
  try { return sanitizeTimelineHeight(JSON.parse(raw)); }
  catch { return TIMELINE_HEIGHT_DEFAULT; }
}

/** Short workspaces keep the 48px controls visible, then reserve the viewer's minimum height. */
export function timelineHeightLimits(availableHeight) {
  const max = Number.isFinite(availableHeight) && availableHeight >= 0
    ? Math.min(TIMELINE_HEIGHT_MAX, Math.max(Math.min(TIMELINE_COMPACT_HEIGHT, availableHeight), availableHeight - VIEWER_MIN_HEIGHT))
    : TIMELINE_HEIGHT_MAX;
  return { min: Math.min(TIMELINE_HEIGHT_MIN, max), max };
}

export function resolveTimelineHeight(preferred, availableHeight, compact = false) {
  if (compact) return TIMELINE_COMPACT_HEIGHT;
  const { min, max } = timelineHeightLimits(availableHeight);
  return clamp(sanitizeTimelineHeight(preferred), min, max);
}

/** Use the pointer-down preference plus total deltaY; upward motion grows the bottom dock. */
export function resizeTimelineHeight(initialPreferred, deltaY, availableHeight, compact = false) {
  const preferred = sanitizeTimelineHeight(initialPreferred);
  if (compact || !Number.isFinite(deltaY) || deltaY === 0 || !Number.isFinite(availableHeight) || availableHeight <= 0) return preferred;
  const { min, max } = timelineHeightLimits(availableHeight);
  if (max <= min) return preferred;
  const actual = resolveTimelineHeight(preferred, availableHeight);
  const next = clamp(actual - deltaY, min, max);
  // Hitting an already-compressed limit must not erase the larger saved preference.
  return next === actual ? preferred : next;
}
