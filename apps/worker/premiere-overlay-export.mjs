import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { projectComment } from '../../packages/core/comment-projection.mjs';
import { mapToSource } from './engine.mjs';

/** Display intervals are resolved in the authored version BEFORE cuts/speed are projected. */
export function overlayDisplayRanges(comment, authored, target, groups, groupIndex, anchorStatus) {
  const group = groups[groupIndex];
  if (anchorStatus !== 'present' || group.frame < comment.frameIn || group.frame >= comment.frameOut) return [];
  // The first drawing represents the start of the comment range; subsequent drawings replace it.
  const frameIn = groupIndex === 0 ? comment.frameIn : group.frame;
  const frameOut = Math.min(comment.frameOut, groups[groupIndex + 1]?.frame ?? comment.frameOut);
  if (frameOut <= frameIn) return [];
  const sourceRanges = mapToSource(authored.timelineMap, frameIn, frameOut);
  const projection = projectComment({ ...comment, frameIn, frameOut, sourceRanges, contextFrame: group.frame }, authored, target);
  return projection.ranges.map(({ frameIn: start, frameOut: end }) => ({ frameIn: start, frameOut: end }));
}

/** Flatten simultaneous annotations into one transparent lane; gaps stay empty. */
export async function buildTimelineOverlays(bundle, pngs) {
  const intervals = [];
  let skippedGroups = 0;
  for (const entry of bundle.feedback) for (const overlay of entry.overlays) {
    if (!overlay.displayRanges.length) skippedGroups++;
    for (const range of overlay.displayRanges) intervals.push({ ...range, file: overlay.file });
  }
  const boundaries = [...new Set(intervals.flatMap(range => [range.frameIn, range.frameOut]))].sort((a, b) => a - b);
  const plan = [];
  for (let index = 0; index + 1 < boundaries.length; index++) {
    const frameIn = boundaries[index], frameOut = boundaries[index + 1];
    const files = [...new Set(intervals.filter(range => range.frameIn <= frameIn && range.frameOut >= frameOut).map(range => range.file))];
    if (!files.length) continue;
    const previous = plan.at(-1), key = files.join('|');
    if (previous?.key === key && previous.frameOut === frameIn) previous.frameOut = frameOut;
    else plan.push({ frameIn, frameOut, files, key });
  }
  if (plan.length > 600) throw new Error('오버레이 구간은 최대 600개까지 전달할 수 있습니다. 자료를 생략하지 않았습니다.');
  const images = new Map(pngs.map(png => [png.file, png.bytes])), composites = new Map(), timelinePngs = [], segments = [];
  let totalBytes = 0;
  for (const segment of plan) {
    let bytes = composites.get(segment.key);
    if (!bytes) {
      bytes = segment.files.length === 1 ? images.get(segment.files[0]) : await sharp({ create: {
        ...bundle.canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 },
      } }).composite(segment.files.map(file => ({ input: images.get(file), left: 0, top: 0 }))).png().toBuffer();
      composites.set(segment.key, bytes);
    }
    totalBytes += bytes.length;
    if (totalBytes > 128 * 1024 * 1024) throw new Error('오버레이 PNG 묶음이 128MB를 넘었습니다. 그림 수를 줄여 주세요.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = `timeline-overlays/vi-${bundle.scope}-${segment.frameIn}-${segment.frameOut}-${sha256}.png`;
    timelinePngs.push({ file, bytes });
    segments.push({ frameIn: segment.frameIn, frameOut: segment.frameOut, file, sha256, bytes: bytes.length });
  }
  bundle.timelineOverlays = { schemaVersion: 1, policy: 'comment-range; first drawing from IN; replace at next drawing; point is one canonical frame',
    alpha: 'straight', pixelAspectRatio: 1, skippedGroups, segments };
  return timelinePngs;
}
