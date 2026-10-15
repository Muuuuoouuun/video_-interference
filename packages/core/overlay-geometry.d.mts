import type { Drawing, Point, Region } from './types';
export const MAX_PEN_POINTS: number;
export const MIN_DRAWING_SIZE_PX: number;
export type DrawingHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'start' | 'end';
export type DrawingStyle = Pick<Drawing, 'color' | 'strokeWidth' | 'opacity' | 'fill'>;
export function drawingBounds(drawing: Drawing): Region;
/** Pens at most 3 CSS pixels thick use only their long-axis handles; tiny pens can move only. */
export function drawingResizeHandles(drawing: Drawing, width: number, height: number, bounds?: Region): Array<Point & { id: DrawingHandle }>;
export function normalizeDrawing(drawing: Drawing): Drawing;
export function createDrawing(kind: Drawing['kind'], start: Point, end: Point, style: DrawingStyle, id: string): Drawing;
export function arrowHeadPoints(start: Point, end: Point, strokeWidth?: number): Point[];
export function translateDrawing(drawing: Drawing, dx: number, dy: number): Drawing;
export function resizeDrawing(drawing: Drawing, handle: DrawingHandle, point: Point, minimum?: { w: number; h: number }): Drawing;
export function isDrawableSize(drawing: Drawing, width: number, height: number, minimumPixels?: number): boolean;
export function decimatePoints(points: Point[], width: number, height: number, tolerance?: number, limit?: number): Point[];
