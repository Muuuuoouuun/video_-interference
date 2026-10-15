import type { Drawing, Point } from './types';
import type { DrawingHandle } from './overlay-geometry.mjs';

export interface OverlayGesture {
  update(point: Point, samples?: Point[]): void;
  flush(): Drawing;
  finish(): Drawing;
}

export function createOverlayGesture(options: {
  kind: 'create' | 'move' | 'resize';
  original: Drawing;
  start: Point;
  width: number;
  height: number;
  handle?: DrawingHandle;
}): OverlayGesture;
