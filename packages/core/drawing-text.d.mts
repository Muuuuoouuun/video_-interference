import type { Drawing } from './types';

export function colorName(hex: string): string;
export function drawingBox(drawing: Drawing): [number, number, number, number] | null;
export function describeDrawing(drawing: Drawing): string;
