import type { Drawing, Point, Region } from './types';
import type { DrawingStyle } from './overlay-geometry.mjs';
export const MAX_DRAWING_TEXT: number;
export const MAX_DRAWING_TEXT_LINES: number;
export const DRAWING_TEXT_FONT: string;
export function drawingTextLines(text?: string): string[];
export function textDrawingLayout(drawing: Drawing, logicalHeight: number): { region: Region; fontSize: number; lines: Array<{ text: string; x: number; y: number; width: number }> };
export function createTextDrawing(input: { id: string; text: string; point: Point; style: DrawingStyle; fontSize?: number; logicalHeight: number; frame?: number }): Drawing;
export function scaleTextDrawing(drawing: Drawing, fontSize: number, logicalHeight: number): Drawing;
