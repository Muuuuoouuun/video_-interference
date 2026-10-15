/** Mark IN/OUT in canonical 30 fps coordinates; an inactive range has no reusable bounds. */
export function markTimelineRange({ edge, frame, durationFrames, range, active }) {
  if (!['in', 'out'].includes(edge) || !Number.isInteger(durationFrames) || durationFrames < 1 || !Number.isFinite(frame)) return null;
  const bounded = (value, min, max) => Math.max(min, Math.min(max, Math.floor(value)));
  const current = bounded(frame, 0, durationFrames - 1);
  if (!active) return { in: current, out: current + 1 };
  if (!range || !Number.isFinite(range.in) || !Number.isFinite(range.out)) return null;
  const start = bounded(range.in, 0, durationFrames - 1), end = bounded(range.out, start + 1, durationFrames);
  return edge === 'in' ? { in: current, out: Math.max(end, current + 1) } : { in: Math.min(start, current), out: current + 1 };
}
