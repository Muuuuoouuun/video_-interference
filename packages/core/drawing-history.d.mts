import type { Drawing } from './types';

export const DRAWING_HISTORY_LIMIT: number;
/** Snapshots are deeply frozen at runtime; derive edits with map/spread, never mutate. */
export interface DrawingHistorySession {
  readonly present: Drawing[];
  readonly past: readonly Drawing[][];
  readonly future: readonly Drawing[][];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly grouping: boolean;
  /** Returns true only when an actual external replacement resets the history. */
  sync(drawings: Drawing[], fallbackFrame?: number): boolean;
  /** Returns true if present changed; no-op commits preserve redo. */
  commit(drawings: Drawing[]): boolean;
  beginGroup(): void;
  updateGroup(drawings: Drawing[]): boolean;
  endGroup(): boolean;
  undo(): Drawing[] | null;
  redo(): Drawing[] | null;
}
export interface DrawingHistoryStore {
  readonly size: number;
  activate(key: string, drawings: Drawing[], fallbackFrame: number): DrawingHistorySession;
  get(key: string): DrawingHistorySession | undefined;
  delete(key: string): boolean;
  clear(): void;
}
export function createDrawingHistoryStore(options?: { limit?: number; maxContexts?: number }): DrawingHistoryStore;
export function drawingEqual(left: Drawing, right: Drawing, fallbackFrame?: number): boolean;
export function drawingsEqual(left: Drawing[], right: Drawing[], fallbackFrame?: number): boolean;
export function changedDrawingFrames(before: Drawing[], after: Drawing[], fallbackFrame: number): number[];
