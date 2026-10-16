export const PREVIEW_ZOOM_STEPS = [1, 1.25, 1.5, 2, 3, 4];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

/** A view only changes display geometry; normalized annotation coordinates stay intact. */
export function resolvePreviewViewport(base, view) {
  const zoom = clamp(finite(view.zoom, 1), 1, 4);
  const width = Math.max(0, finite(base.width)) * zoom, height = Math.max(0, finite(base.height)) * zoom;
  const surfaceWidth = Math.max(0, finite(base.width) + 2 * finite(base.left));
  const surfaceHeight = Math.max(0, finite(base.height) + 2 * finite(base.top));
  const x = clamp(finite(view.x), -Math.max(0, (width - surfaceWidth) / 2), Math.max(0, (width - surfaceWidth) / 2));
  const y = clamp(finite(view.y), -Math.max(0, (height - surfaceHeight) / 2), Math.max(0, (height - surfaceHeight) / 2));
  return { zoom, x, y, left: (surfaceWidth - width) / 2 + x, top: (surfaceHeight - height) / 2 + y, width, height };
}

export function zoomPreviewViewport(base, view, zoom, anchor) {
  const previous = resolvePreviewViewport(base, view);
  const centerX = base.left + base.width / 2, centerY = base.top + base.height / 2;
  const target = clamp(finite(zoom, previous.zoom), 1, 4), ratio = target / previous.zoom;
  const ax = finite(anchor?.x, centerX), ay = finite(anchor?.y, centerY);
  const next = resolvePreviewViewport(base, { zoom: target, x: ax - centerX - (ax - centerX - previous.x) * ratio, y: ay - centerY - (ay - centerY - previous.y) * ratio });
  return { zoom: next.zoom, x: next.x, y: next.y };
}

export function stepPreviewZoom(zoom, direction) {
  return direction > 0 ? PREVIEW_ZOOM_STEPS.find(value => value > zoom + 0.001) ?? 4
    : PREVIEW_ZOOM_STEPS.findLast(value => value < zoom - 0.001) ?? 1;
}
