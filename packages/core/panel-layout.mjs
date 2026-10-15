export const PANEL_DEFAULTS = Object.freeze({ project: 180, feedback: 380 });
export const PANEL_LIMITS = Object.freeze({
  project: Object.freeze({ min: 160, max: 320 }),
  feedback: Object.freeze({ min: 320, max: 640 }),
});
export const COLLAPSED_WIDTHS = Object.freeze({ project: 56, feedback: 52 });
export const WORKSPACE_MIN_WIDTH = 440;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sides = ['project', 'feedback'];

/** Persist expanded preferences only. Ignore malformed values without coercing strings. */
export function sanitizePanelWidths(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(sides.map(side => [side, Number.isFinite(input[side])
    ? clamp(input[side], PANEL_LIMITS[side].min, PANEL_LIMITS[side].max)
    : PANEL_DEFAULTS[side]]));
}

export function decodePanelWidths(raw) {
  if (typeof raw !== 'string') return sanitizePanelWidths(null);
  try { return sanitizePanelWidths(JSON.parse(raw)); }
  catch { return sanitizePanelWidths(null); }
}

/** Return actual widths, including collapsed rails; never overwrite expanded preferences. */
export function resolvePanelWidths(preferred, containerWidth, open) {
  const widths = sanitizePanelWidths(preferred);
  for (const side of sides) if (!open[side]) widths[side] = COLLAPSED_WIDTHS[side];
  if (!Number.isFinite(containerWidth) || containerWidth < 0) return widths;

  let deficit = widths.project + widths.feedback + WORKSPACE_MIN_WIDTH - containerWidth;
  // Keep feedback readable first; below the minimum budget the workspace takes the remainder.
  for (const side of sides) {
    if (deficit <= 0) break;
    if (!open[side]) continue;
    const reduction = Math.min(deficit, widths[side] - PANEL_LIMITS[side].min);
    widths[side] -= reduction;
    deficit -= reduction;
  }
  return widths;
}

/**
 * Pass the unchanged preferred-width snapshot captured at pointer-down and total pointer
 * displacement, not incremental deltas. The drag starts at its resolved visible width,
 * so a preference compressed by the viewport never causes a jump. Only the dragged
 * expanded preference changes; the other panel retains its saved preference.
 */
export function resizePanelWidth(side, initialPreferred, deltaX, containerWidth, open) {
  const preferred = sanitizePanelWidths(initialPreferred);
  if (!sides.includes(side) || !open[side] || !Number.isFinite(deltaX) || deltaX === 0
    || !Number.isFinite(containerWidth) || containerWidth <= 0) return preferred;
  const actual = resolvePanelWidths(preferred, containerWidth, open);
  const other = side === 'project' ? 'feedback' : 'project';
  const { min, max } = PANEL_LIMITS[side];
  const availableMax = Math.max(min, Math.min(max, containerWidth - actual[other] - WORKSPACE_MIN_WIDTH));
  return { ...preferred, [side]: clamp(actual[side] + (side === 'project' ? deltaX : -deltaX), min, availableMax) };
}
