export type PreviewView = { zoom: number; x: number; y: number };
export type PreviewRect = { left: number; top: number; width: number; height: number };
export const PREVIEW_ZOOM_STEPS: number[];
export function resolvePreviewViewport(base: PreviewRect, view: PreviewView): PreviewRect & PreviewView;
export function zoomPreviewViewport(base: PreviewRect, view: PreviewView, zoom: number, anchor?: { x: number; y: number }): PreviewView;
export function stepPreviewZoom(zoom: number, direction: number): number;
