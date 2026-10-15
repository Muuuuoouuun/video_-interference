function normalizeSearch(value) {
  return typeof value === 'string' ? value.normalize('NFKC').toLocaleLowerCase('ko-KR') : '';
}

function projectedStart(projection) {
  if (!projection || !['present', 'partial'].includes(projection.status)) return Infinity;
  let first = Infinity;
  for (const range of projection.ranges ?? []) {
    if (Number.isFinite(range.frameIn) && range.frameIn >= 0 && Number.isFinite(range.frameOut) && range.frameOut > range.frameIn) first = Math.min(first, range.frameIn);
  }
  return first;
}

/** Search saved user content only. Timeline ordering never substitutes authored or context anchors. */
export function selectFeedbackList(comments, { query = '', sort = 'timeline', projections = new Map(), attachments = [] } = {}) {
  const tokens = normalizeSearch(query).trim().split(/\s+/u).filter(Boolean);
  const names = new Map(attachments.map(attachment => [attachment.id, attachment.name]));
  const rows = comments.map((comment, index) => {
    const attachmentIds = [...(comment.attachmentIds ?? []), ...(comment.voiceAssetId ? [comment.voiceAssetId] : [])];
    const content = tokens.length ? normalizeSearch([
      comment.text, comment.sceneDescription, ...(comment.supplements ?? []).map(supplement => supplement.text),
      ...attachmentIds.map(id => names.get(id)),
    ].filter(Boolean).join('\n')) : '';
    const createdAt = Date.parse(comment.createdAt);
    return { comment, index, content, start: projectedStart(projections.get(comment.id)), createdAt: Number.isFinite(createdAt) ? createdAt : -Infinity };
  }).filter(row => tokens.every(token => row.content.includes(token)));
  rows.sort((a, b) => {
    const primary = sort === 'newest' ? b.createdAt - a.createdAt : a.start - b.start;
    return Number.isNaN(primary) || primary === 0 ? a.index - b.index : primary;
  });
  return rows.map(row => row.comment);
}
