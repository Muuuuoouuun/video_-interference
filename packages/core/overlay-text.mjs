import { normalizeDrawing, drawingBounds } from './overlay-geometry.mjs';

export const MAX_DRAWING_TEXT = 500;
export const MAX_DRAWING_TEXT_LINES = 8;
export const DRAWING_TEXT_FONT = 'Arial, Apple SD Gothic Neo, Noto Sans CJK KR, sans-serif';
const units = line => Math.max(0.5, Array.from(line).reduce((sum, char) => sum + (/\s/u.test(char) ? 0.35 : /[\u0000-\u007f]/u.test(char) ? 0.6 : 1), 0));
export const drawingTextLines = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

/** Explicit line lengths make the browser and native SVG share the same box. */
export function textDrawingLayout(drawing, logicalHeight) {
  const region = drawingBounds(drawing), lines = drawingTextLines(drawing.text);
  const widest = Math.max(...lines.map(units));
  const fontSize = region.h * logicalHeight / (lines.length * 1.25);
  return { region, fontSize, lines: lines.map((text, index) => ({ text,
    x: region.x * 1000, y: region.y * logicalHeight + fontSize * (0.95 + index * 1.25),
    width: region.w * 1000 * units(text) / widest,
  })) };
}

export function createTextDrawing({ id, text, point, style, fontSize = 32, logicalHeight, frame }) {
  const lines = drawingTextLines(text), size = Math.max(8, Math.min(160, fontSize));
  const naturalW = Math.max(...lines.map(units)) * size / 1000;
  const naturalH = lines.length * size * 1.25 / logicalHeight;
  const scale = Math.min(1, 0.98 / naturalW, 0.98 / naturalH);
  const w = naturalW * scale, h = naturalH * scale;
  const region = { x: Math.max(0, Math.min(1 - w, point.x)), y: Math.max(0, Math.min(1 - h, point.y)), w, h };
  return normalizeDrawing({ id, kind: 'text', text: drawingTextLines(text).join('\n'), color: style.color,
    opacity: style.opacity ?? 1, fill: 'none', points: [], region, ...(frame !== undefined ? { frame } : {}) });
}

export function scaleTextDrawing(drawing, fontSize, logicalHeight) {
  const current = textDrawingLayout(drawing, logicalHeight), scale = Math.max(8, Math.min(160, fontSize)) / current.fontSize;
  const fit = Math.min(scale, (1 - current.region.x) / current.region.w, (1 - current.region.y) / current.region.h);
  return normalizeDrawing({ ...drawing, region: { ...current.region, w: current.region.w * fit, h: current.region.h * fit } });
}
