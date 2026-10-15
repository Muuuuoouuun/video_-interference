export const MAX_PEN_POINTS = 2000;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const normalizedPoint = (point) => ({ x: clamp(point.x), y: clamp(point.y) });
const isValidRegion = (region) => region && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(region[key])) && region.x >= 0 && region.y >= 0 && region.w >= 0 && region.h >= 0 && region.x + region.w <= 1.00001 && region.y + region.h <= 1.00001;

export function drawingBounds(drawing) {
  if ((drawing.kind === 'rect' || drawing.kind === 'ellipse') && drawing.region) return { ...drawing.region };
  if (!drawing.points.length) return { x: 0, y: 0, w: 0, h: 0 };
  let left = 1, top = 1, right = 0, bottom = 0;
  for (const point of drawing.points) { left = Math.min(left, point.x); top = Math.min(top, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y); }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function normalizeDrawing(drawing) {
  const originalPoints = drawing.points || [];
  const points = originalPoints.length <= MAX_PEN_POINTS ? originalPoints.map(normalizedPoint) : decimatePoints(originalPoints, 1000, 1000, 0.5, MAX_PEN_POINTS).map(normalizedPoint);
  const next = { ...drawing, points, strokeWidth: clamp(drawing.strokeWidth ?? 3, 0.25, 64), opacity: clamp(drawing.opacity ?? 1) };
  if (drawing.kind === 'rect' || drawing.kind === 'ellipse') {
    if (isValidRegion(drawing.region)) next.region = { ...drawing.region };
    else {
      const first = points[0] || { x: 0, y: 0 }, last = points.at(-1) || first;
      next.region = { x: Math.min(first.x, last.x), y: Math.min(first.y, last.y), w: Math.abs(last.x - first.x), h: Math.abs(last.y - first.y) };
    }
    next.points = [normalizedPoint(next.region), normalizedPoint({ x: next.region.x + next.region.w, y: next.region.y + next.region.h })];
  }
  return next;
}

export function createDrawing(kind, start, end, style, id) {
  return normalizeDrawing({ id, kind, color: style.color, strokeWidth: style.strokeWidth, opacity: style.opacity,
    fill: kind === 'rect' || kind === 'ellipse' ? style.fill || 'none' : 'none', points: [start, end],
  });
}

/** Logical canvas coordinates; matches the filled arrow head used by the native raster renderer. */
export function arrowHeadPoints(start, end, strokeWidth = 3) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x), length = Math.max(9, strokeWidth * 4), halfWidth = Math.max(4.5, strokeWidth * 2.2);
  const back = { x: end.x - Math.cos(angle) * length, y: end.y - Math.sin(angle) * length };
  return [
    { ...end },
    { x: back.x + Math.sin(angle) * halfWidth, y: back.y - Math.cos(angle) * halfWidth },
    { x: back.x - Math.sin(angle) * halfWidth, y: back.y + Math.cos(angle) * halfWidth },
  ];
}

export function translateDrawing(drawing, dx, dy) {
  const bounds = drawingBounds(drawing);
  const safeX = clamp(dx, -bounds.x, 1 - bounds.x - bounds.w);
  const safeY = clamp(dy, -bounds.y, 1 - bounds.y - bounds.h);
  return normalizeDrawing({ ...drawing,
    ...((drawing.kind === 'rect' || drawing.kind === 'ellipse') ? { region: { ...bounds, x: bounds.x + safeX, y: bounds.y + safeY } } : {}),
    points: drawing.points.map((point) => ({ x: point.x + safeX, y: point.y + safeY })),
  });
}

export function resizeDrawing(drawing, handle, point, minimum = { w: 0.003, h: 0.003 }) {
  if (handle === 'start' || handle === 'end') {
    const points = drawing.points.map((item) => ({ ...item }));
    if (!points.length) return drawing;
    points[handle === 'start' ? 0 : points.length - 1] = normalizedPoint(point);
    return normalizeDrawing({ ...drawing, points });
  }
  const bounds = drawingBounds(drawing);
  let left = bounds.x, top = bounds.y, right = left + bounds.w, bottom = top + bounds.h;
  if (handle.includes('w')) left = clamp(point.x, 0, Math.max(0, right - minimum.w));
  if (handle.includes('e')) right = clamp(point.x, Math.min(1, left + minimum.w), 1);
  if (handle.includes('n')) top = clamp(point.y, 0, Math.max(0, bottom - minimum.h));
  if (handle.includes('s')) bottom = clamp(point.y, Math.min(1, top + minimum.h), 1);
  const width = right - left, height = bottom - top;
  const points = drawing.points.map((item) => ({
    x: bounds.w > 1e-8 ? left + (item.x - bounds.x) / bounds.w * width : left + width / 2,
    y: bounds.h > 1e-8 ? top + (item.y - bounds.y) / bounds.h * height : top + height / 2,
  }));
  return normalizeDrawing({ ...drawing, points, ...((drawing.kind === 'rect' || drawing.kind === 'ellipse') ? { region: { x: left, y: top, w: width, h: height } } : {}) });
}

export function isDrawableSize(drawing, width, height, minimumPixels = 3) {
  if (width <= 0 || height <= 0 || !drawing.points.length) return false;
  if (drawing.kind === 'pen' && drawing.points.length === 1) return true;
  if (drawing.points.length < 2) return false;
  if (drawing.kind === 'rect' || drawing.kind === 'ellipse') {
    const bounds = drawingBounds(drawing);
    return bounds.w * width + 1e-6 >= minimumPixels && bounds.h * height + 1e-6 >= minimumPixels;
  }
  let length = 0;
  for (let index = 1; index < drawing.points.length; index++) {
    const previous = drawing.points[index - 1], point = drawing.points[index];
    length += Math.hypot((point.x - previous.x) * width, (point.y - previous.y) * height);
    if (length >= minimumPixels) return true;
  }
  return false;
}

/** Iterative Ramer–Douglas–Peucker simplification measured in displayed pixels. */
export function decimatePoints(points, width, height, tolerance = 0.75, limit = MAX_PEN_POINTS) {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  const kept = new Uint8Array(points.length);
  kept[0] = kept[points.length - 1] = 1;
  const stack = [[0, points.length - 1]], threshold = tolerance * tolerance;
  while (stack.length) {
    const [firstIndex, lastIndex] = stack.pop();
    const first = points[firstIndex], last = points[lastIndex];
    const ax = first.x * width, ay = first.y * height, vx = (last.x - first.x) * width, vy = (last.y - first.y) * height;
    const lengthSquared = vx * vx + vy * vy;
    let farthest = -1, distance = threshold;
    for (let index = firstIndex + 1; index < lastIndex; index++) {
      const point = points[index], px = point.x * width - ax, py = point.y * height - ay;
      const along = lengthSquared > 0 ? clamp((px * vx + py * vy) / lengthSquared) : 0;
      const squared = (px - along * vx) ** 2 + (py - along * vy) ** 2;
      if (squared > distance) { distance = squared; farthest = index; }
    }
    if (farthest !== -1) { kept[farthest] = 1; stack.push([firstIndex, farthest], [farthest, lastIndex]); }
  }
  const result = points.filter((_, index) => kept[index]);
  if (result.length <= limit) return result.map((point) => ({ ...point }));
  return Array.from({ length: limit }, (_, index) => ({ ...result[Math.round(index * (result.length - 1) / (limit - 1))] }));
}
