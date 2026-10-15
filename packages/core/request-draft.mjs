import { groupDrawings } from './drawing-anchors.mjs';

/** The player's compose action follows the playhead; reusing a saved interval is a separate action. */
export function planPlayerCompose({ liveFrame, durationFrames, reviewing, draftReturnable, draftFrame, range, anchorMode }) {
  if (!Number.isInteger(durationFrames) || durationFrames < 1 || !Number.isFinite(liveFrame)) return null;
  const bounded = value => Math.max(0, Math.min(durationFrames - 1, Math.floor(value)));
  if (reviewing && draftReturnable) {
    if (!Number.isFinite(draftFrame)) return null;
    return { action: 'resume', frame: bounded(draftFrame), range, anchorMode };
  }
  const frame = bounded(liveFrame);
  if (reviewing) return { action: 'new', frame, range: { in: frame, out: frame + 1 }, anchorMode: 'point' };
  return { action: 'focus', frame, range, anchorMode };
}

/** A fresh request uses exactly one interval and an explicitly chosen drawing-frame group. */
export function createProjectedRequestDraft(comment, projection, rangeIndex, copyDrawings = false, drawingSelection) {
  if (!projection || !['present', 'partial'].includes(projection.status)) return null;
  const range = projection.ranges[rangeIndex];
  if (!range) return null;
  let context = projection.contextStatus === 'present' ? projection.contextFrame : null;
  let drawings = [];
  if (copyDrawings) {
    let selected = drawingSelection;
    if (!selected) {
      // Older callers can copy a single context-bound group, never silently merge separate anchors.
      const fallback = comment.contextFrame ?? comment.frameIn ?? 0;
      let groups;
      try { groups = groupDrawings(comment.drawings, fallback); } catch { return null; }
      if (groups.length !== 1 || groups[0].frame !== fallback || context == null) return null;
      selected = { drawings: groups[0].drawings, contextFrame: context };
      drawings = structuredClone(selected.drawings).map(drawing => ({ ...drawing, frame: context }));
    } else {
      if (!Number.isInteger(selected.contextFrame) || selected.contextFrame < 0 || !Array.isArray(selected.drawings) || !selected.drawings.length || selected.drawings.some(drawing => drawing.frame !== undefined && drawing.frame !== selected.contextFrame)) return null;
      context = selected.contextFrame;
      drawings = structuredClone(selected.drawings).map(drawing => ({ ...drawing, frame: context }));
    }
  }
  const contextInsideRange = context != null && context >= range.frameIn && context < range.frameOut;
  return {
    in: range.frameIn,
    out: range.frameOut,
    contextFrame: copyDrawings || contextInsideRange ? context : range.frameIn,
    drawings,
  };
}
