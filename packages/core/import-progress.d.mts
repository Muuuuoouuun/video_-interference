export type ImportStage = 'receiving' | 'converting' | 'finishing';
export interface ImportProgressInput { stage: ImportStage; progress?: number; sentBytes?: number; totalBytes?: number; stageElapsedMs?: number }
/** Words for one import step. Upload bytes come from the browser; conversion progress comes from the worker. */
export function importProgressLabel(input: ImportProgressInput): { step: 1 | 2 | 3; title: string; detail: string; percent: number; indeterminate: boolean };
