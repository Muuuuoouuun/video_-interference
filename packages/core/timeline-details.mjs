import { projectComment } from './comment-projection.mjs';
import { projectDrawings } from './drawing-anchors.mjs';

const named = (attachment, fallback) => typeof attachment.name === 'string' && attachment.name.trim() ? attachment.name : fallback;

/** Derive detail tracks only from saved links and surviving current-version anchors. */
export function buildTimelineDetails(comments, versions, currentVersion, attachments) {
  const versionsById = new Map((versions ?? []).filter(Boolean).map(version => [version.id, version]));
  const attachmentsById = new Map((attachments ?? []).filter(attachment => attachment && typeof attachment.id === 'string').map(attachment => [attachment.id, attachment]));
  const items = [], unavailable = [];
  for (const [index, comment] of (comments ?? []).entries()) {
    if (!comment || typeof comment.id !== 'string' || !comment.id || comment.deletedAt) continue;
    const number = index + 1;
    const authoredVersion = versionsById.get(comment.versionId);
    const projection = projectComment(comment, authoredVersion, currentVersion);
    if (!projection.ranges.length) unavailable.push({ commentId: comment.id, number, reason: projection.status === 'deleted' ? 'deleted' : 'unavailable' });
    const base = { commentId: comment.id, number };
    const feedbackLabel = comment.text?.trim() || comment.sceneDescription?.trim() || '그림·첨부 자료';
    const appendRanges = (kind, attachmentIds, label) => {
      projection.ranges.forEach((range, rangeIndex) => items.push({
        ...base, id: `${kind}:${comment.id}:${rangeIndex}`, kind,
        frameIn: range.frameIn, frameOut: range.frameOut, rangeIndex, attachmentIds: [...attachmentIds], label,
      }));
    };
    appendRanges('feedback', [], feedbackLabel);

    const drawingGroups = new Map();
    for (const drawing of projectDrawings(comment, authoredVersion, currentVersion)) {
      if (drawing.status !== 'present' || drawing.frame === null) continue;
      drawingGroups.set(drawing.frame, (drawingGroups.get(drawing.frame) ?? 0) + 1);
    }
    for (const [frame, drawingCount] of [...drawingGroups.entries()].sort(([a], [b]) => a - b)) {
      const containing = projection.ranges.findIndex(range => frame >= range.frameIn && frame < range.frameOut);
      items.push({ ...base, id: `drawing:${comment.id}:${frame}`, kind: 'drawing', frameIn: frame, frameOut: frame + 1,
        rangeIndex: containing < 0 ? null : containing, drawingCount, attachmentIds: [], label: `그림 ${drawingCount}개` });
    }

    const linkedIds = [...new Set(Array.isArray(comment.attachmentIds) ? comment.attachmentIds : [])];
    const linked = linkedIds.map(id => attachmentsById.get(id)).filter(Boolean);
    const voiceIds = [...new Set([
      ...(attachmentsById.has(comment.voiceAssetId) ? [comment.voiceAssetId] : []),
      ...linked.filter(attachment => attachment.role === 'voice').map(attachment => attachment.id),
    ])];
    const voiceIdSet = new Set(voiceIds);
    const references = linked.filter(attachment => !voiceIdSet.has(attachment.id) && ['reference', 'insert'].includes(attachment.role)
      && typeof attachment.mimeType === 'string' && attachment.mimeType.startsWith('image/'));
    if (references.length) appendRanges('reference', references.map(attachment => attachment.id), references.map(attachment => named(attachment, '참고 이미지')).join(', '));
    if (voiceIds.length) appendRanges('voice', voiceIds, voiceIds.map(id => named(attachmentsById.get(id), '음성 피드백')).join(', '));
  }
  return { items, unavailable };
}

/** Give short spans usable hit areas while retaining their exact temporal footprint separately. */
export function layoutTimelineDetails(items, durationFrames, width) {
  if (!items.length || !Number.isFinite(width) || width <= 0 || !Number.isFinite(durationFrames) || durationFrames <= 0) return { entries: [], rows: 0 };
  const rowEnds = [];
  const entries = [...items].sort((a, b) => a.frameIn - b.frameIn).map(item => {
    const anchorLeft = item.frameIn / durationFrames * width;
    const anchorWidth = (item.frameOut - item.frameIn) / durationFrames * width;
    const displayWidth = Math.min(width, Math.max(28, anchorWidth));
    const naturalLeft = anchorWidth < 28 ? anchorLeft - displayWidth / 2 : anchorLeft;
    const left = Math.max(0, Math.min(width - displayWidth, naturalLeft));
    let row = rowEnds.findIndex(end => left >= end + 4);
    if (row < 0) row = rowEnds.length;
    rowEnds[row] = left + displayWidth;
    return { item, left, width: displayWidth, anchorLeft, anchorWidth, row };
  });
  return { entries, rows: rowEnds.length };
}
