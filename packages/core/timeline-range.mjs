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

/** Move from the grabbed boundary, independent of where inside its hit area the pointer began. */
export function dragTimelineBoundary(startFrame, deltaPixels, width, durationFrames) {
  if (!Number.isFinite(startFrame) || !Number.isFinite(deltaPixels) || !Number.isFinite(width) || width <= 0
    || !Number.isSafeInteger(durationFrames) || durationFrames < 1 || deltaPixels === 0) return startFrame;
  return Math.max(0, Math.min(durationFrames, startFrame + Math.round(deltaPixels / width * durationFrames)));
}

/** Keep only the latest pointer position; publish a distinct range once per display frame. */
export function createTimelineRangeGesture({ edge, range, startX, width, durationFrames }) {
  const initial = { ...range };
  let latestX = startX, previous = initial;
  return {
    update(clientX) { if (Number.isFinite(clientX)) latestX = clientX; },
    flush() {
      const boundary = dragTimelineBoundary(initial[edge], latestX - startX, width, durationFrames);
      const next = edge === 'in' ? { in: Math.min(boundary, initial.out - 1), out: initial.out }
        : { in: initial.in, out: Math.max(boundary, initial.in + 1) };
      if (next.in === previous.in && next.out === previous.out) return null;
      previous = next;
      return next;
    },
  };
}
