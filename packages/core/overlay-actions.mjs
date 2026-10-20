import { drawingFrame } from './drawing-anchors.mjs';
import { drawingBounds, translateDrawing } from './overlay-geometry.mjs';

export function duplicateOverlay(drawings, id, frame, fallbackFrame, newId, width, height, limit = 30) {
  const source = drawings.find(item => item.id === id && drawingFrame(item, fallbackFrame) === frame);
  if (!source || drawings.length >= limit || width <= 0 || height <= 0) return drawings;
  const bounds = drawingBounds(source);
  // Offset inward at the edge, so the copy remains reachable without clipping.
  const dx = 12 / width * (bounds.x + bounds.w + 12 / width <= 1 ? 1 : -1);
  const dy = 12 / height * (bounds.y + bounds.h + 12 / height <= 1 ? 1 : -1);
  const copy = translateDrawing(source, dx, dy);
  return [...drawings, { ...copy, id: newId, frame }];
}

export function reorderOverlay(drawings, id, frame, fallbackFrame, direction) {
  const indices = drawings.flatMap((item, index) => drawingFrame(item, fallbackFrame) === frame ? [index] : []);
  const ordered = indices.map(index => drawings[index]);
  const from = ordered.findIndex(item => item.id === id);
  const to = direction === 'front' ? ordered.length - 1 : 0;
  if (from < 0 || from === to) return drawings;
  const [selected] = ordered.splice(from, 1);
  ordered.splice(to, 0, selected);
  const next = [...drawings];
  indices.forEach((index, offset) => { next[index] = ordered[offset]; });
  return next;
}
