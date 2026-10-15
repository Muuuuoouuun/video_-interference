import { MAX_PEN_POINTS, createDrawing, decimatePoints, drawingBounds, normalizeDrawing, resizeDrawing, translateDrawing } from './overlay-geometry.mjs';

/** Buffer pointer samples separately from geometry work. Call flush at most once per display frame. */
export function createOverlayGesture({ kind, original, start, width, height, handle }) {
  let latest = { ...start }, preview = original, dirty = false;
  const newPen = kind === 'create' && original.kind === 'pen';
  let penPoints = newPen ? original.points.map(point => ({ ...point })) : null;
  let resizeOffset;
  if (kind === 'resize') {
    const bounds = drawingBounds(original);
    const anchor = handle === 'start' ? original.points[0] : handle === 'end' ? original.points.at(-1) : {
      x: bounds.x + (handle.includes('w') ? 0 : handle.includes('e') ? bounds.w : bounds.w / 2),
      y: bounds.y + (handle.includes('n') ? 0 : handle.includes('s') ? bounds.h : bounds.h / 2),
    };
    // The hit target is wider than the handle itself. Preserve where it was grabbed
    // so the first movement cannot snap the geometry to the pointer's position.
    resizeOffset = { x: anchor.x - start.x, y: anchor.y - start.y };
  }

  function appendPenPoint(point) {
    const previous = penPoints.at(-1);
    if (!previous || Math.hypot((point.x - previous.x) * width, (point.y - previous.y) * height) >= 0.7) {
      penPoints.push({ ...point });
      dirty = true;
    }
  }

  function flush() {
    if (!dirty) return preview;
    if (kind === 'move') preview = translateDrawing(original, latest.x - start.x, latest.y - start.y);
    else if (kind === 'resize') preview = latest.x === start.x && latest.y === start.y ? original :
      resizeDrawing(original, handle, { x: latest.x + resizeOffset.x, y: latest.y + resizeOffset.y }, { w: 3 / width, h: 3 / height });
    else if (newPen) preview = { ...original, points: penPoints.slice() };
    else preview = { ...original, ...createDrawing(original.kind, start, latest, original, original.id) };
    dirty = false;
    return preview;
  }

  return {
    update(point, samples = []) {
      if (newPen) {
        for (const sample of samples) appendPenPoint(sample);
        // Coalesced events can end before the event's current position.
        appendPenPoint(point);
        while (penPoints.length > MAX_PEN_POINTS) penPoints = penPoints.filter((_, index) => index % 2 === 0 || index === penPoints.length - 1);
      } else if (point.x !== latest.x || point.y !== latest.y) dirty = true;
      latest = { ...point };
    },
    flush,
    finish() {
      // Preserve the exact end of a stroke even when its last sample is below the live spacing threshold.
      // A single-point tap remains a dot, rather than turning into a rejected tiny line.
      if (newPen && penPoints.length > 1 && (penPoints.at(-1).x !== latest.x || penPoints.at(-1).y !== latest.y)) {
        penPoints.push({ ...latest });
        dirty = true;
      }
      const drawing = flush();
      // Existing pen geometry must survive selection, movement and resize at any viewport size.
      return newPen ? normalizeDrawing({ ...drawing, points: decimatePoints(drawing.points, width, height) }) : drawing;
    },
  };
}
