import type { EditOp } from './types';
export function isVisualOp(op: EditOp | undefined): boolean;
export function visualLayerId(op: EditOp): string;
export function resolveLayerSnapshot(inherited: EditOp[], selected: EditOp[]): EditOp[];
