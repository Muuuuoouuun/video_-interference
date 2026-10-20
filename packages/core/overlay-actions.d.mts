import type { Drawing } from './types';
export function duplicateOverlay(drawings: Drawing[], id: string, frame: number, fallbackFrame: number, newId: string, width: number, height: number, limit?: number): Drawing[];
export function reorderOverlay(drawings: Drawing[], id: string, frame: number, fallbackFrame: number, direction: 'front' | 'back'): Drawing[];
