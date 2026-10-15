export type PanelSide = 'project' | 'feedback';
export interface PanelWidths { project: number; feedback: number }
export interface PanelOpen { project: boolean; feedback: boolean }
export const PANEL_DEFAULTS: Readonly<PanelWidths>;
export const PANEL_LIMITS: Readonly<Record<PanelSide, Readonly<{ min: number; max: number }>>>;
export const COLLAPSED_WIDTHS: Readonly<PanelWidths>;
export const WORKSPACE_MIN_WIDTH: number;
export function sanitizePanelWidths(value: unknown): PanelWidths;
export function decodePanelWidths(raw: string | null): PanelWidths;
/** Actual widths include collapsed rails. Open panels shrink in project-then-feedback order. */
export function resolvePanelWidths(preferred: PanelWidths, containerWidth: number, open: PanelOpen): PanelWidths;
/** Use the preferred snapshot at pointer-down plus total deltaX; the origin is its resolved visible width. */
export function resizePanelWidth(side: PanelSide, initialPreferred: PanelWidths, deltaX: number, containerWidth: number, open: PanelOpen): PanelWidths;
