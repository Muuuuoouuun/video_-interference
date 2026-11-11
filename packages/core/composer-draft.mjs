import { FEEDBACK_CATEGORIES } from './feedback-category.mjs';

export const COMPOSER_DRAFT_KEY = 'vi.composer-draft.v1';
const TEXT_LIMIT = 5000, SCENE_LIMIT = 500;
const frame = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * Only typed text and its anchor are recoverable locally. Drawings, images and voice
 * are server/frame bound and must not be silently reattached to a recovered draft.
 */
export function encodeComposerDraft(draft) {
  const text = String(draft?.text ?? '').slice(0, TEXT_LIMIT), sceneDescription = String(draft?.sceneDescription ?? '').slice(0, SCENE_LIMIT);
  if (!draft?.versionId || !text.trim() && !sceneDescription.trim()) return null;
  return JSON.stringify({
    versionId: String(draft.versionId), text, sceneDescription,
    kind: draft.kind === 'note' ? 'note' : 'request',
    category: FEEDBACK_CATEGORIES.includes(draft.category) ? draft.category : 'video',
    anchor: draft.anchor, savedAt: draft.savedAt ?? null,
  });
}

/** Returns a recoverable draft for this version only; malformed or out-of-range anchors are rejected. */
export function decodeComposerDraft(raw, versionId, durationFrames) {
  if (!raw || !versionId) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || value.versionId !== versionId) return null;
  const text = typeof value.text === 'string' ? value.text.slice(0, TEXT_LIMIT) : '';
  const sceneDescription = typeof value.sceneDescription === 'string' ? value.sceneDescription.slice(0, SCENE_LIMIT) : '';
  if (!text.trim() && !sceneDescription.trim()) return null;
  const anchor = value.anchor ?? {}, frameIn = frame(anchor.in), frameOut = frame(anchor.out), contextFrame = frame(anchor.contextFrame);
  if (frameIn === null || frameOut === null || contextFrame === null || frameOut <= frameIn) return null;
  if (Number.isSafeInteger(durationFrames) && (frameOut > durationFrames || contextFrame >= durationFrames)) return null;
  return {
    versionId, text, sceneDescription,
    kind: value.kind === 'note' ? 'note' : 'request',
    category: FEEDBACK_CATEGORIES.includes(value.category) ? value.category : 'video',
    anchor: { mode: anchor.mode === 'range' && frameOut - frameIn > 1 ? 'range' : 'point', in: frameIn, out: frameOut, contextFrame },
    savedAt: typeof value.savedAt === 'string' ? value.savedAt : null,
  };
}
