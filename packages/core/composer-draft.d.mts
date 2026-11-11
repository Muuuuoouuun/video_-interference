import type { FeedbackCategory } from './types';
export interface ComposerDraftAnchor { mode: 'point' | 'range'; in: number; out: number; contextFrame: number }
export interface ComposerDraft { versionId: string; text: string; sceneDescription: string; kind: 'request' | 'note'; category: FeedbackCategory; anchor: ComposerDraftAnchor; savedAt: string | null }
export const COMPOSER_DRAFT_KEY: string;
export function encodeComposerDraft(draft: Omit<ComposerDraft, 'savedAt'> & { savedAt?: string | null }): string | null;
export function decodeComposerDraft(raw: string | null, versionId: string, durationFrames?: number): ComposerDraft | null;
