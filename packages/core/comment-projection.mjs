/** Project immutable source anchors onto a canonical 30 fps version. All ranges are half-open. */
const unavailable = () => ({ status: 'unavailable', ranges: [], contextFrame: null, contextStatus: 'unavailable' });
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function validVersion(version) {
  if (!version || typeof version.id !== 'string' || !version.id || typeof version.assetId !== 'string' || !version.assetId || !Number.isInteger(version.durationFrames) || version.durationFrames < 1 || !Array.isArray(version.timelineMap) || !version.timelineMap.length) return false;
  let output = 0, previousSourceOut = 0;
  for (const segment of version.timelineMap) {
    if (!segment || ![segment.sourceIn, segment.sourceOut, segment.outputIn, segment.outputOut].every(Number.isInteger) || segment.sourceIn < previousSourceOut || segment.sourceOut <= segment.sourceIn || segment.outputIn !== output || segment.outputOut <= segment.outputIn || segment.outputOut > version.durationFrames) return false;
    previousSourceOut = segment.sourceOut; output = segment.outputOut;
  }
  return output === version.durationFrames;
}

function sourceAtFrame(version, frame) {
  if (!Number.isInteger(frame) || frame < 0 || frame >= version.durationFrames) return null;
  const segment = version.timelineMap.find(item => frame >= item.outputIn && frame < item.outputOut);
  if (!segment) return null;
  return segment.sourceIn + (frame - segment.outputIn) * (segment.sourceOut - segment.sourceIn) / (segment.outputOut - segment.outputIn);
}

function frameAtSource(version, source) {
  const segment = version.timelineMap.find(item => source >= item.sourceIn && source < item.sourceOut);
  if (!segment) return null;
  const output = Math.round(segment.outputIn + (source - segment.sourceIn) * (segment.outputOut - segment.outputIn) / (segment.sourceOut - segment.sourceIn));
  // A point may round to the exclusive end. Keep it inside its own surviving segment.
  return clamp(output, segment.outputIn, segment.outputOut - 1);
}

/** A cut-away source point returns null; it is never reattached to a nearby surviving scene. */
export function mapFrameBetweenVersions(from, to, frame) {
  if (!validVersion(from) || !validVersion(to) || from.assetId !== to.assetId) return null;
  const source = sourceAtFrame(from, frame);
  return source === null ? null : frameAtSource(to, source);
}

function sourceRanges(comment) {
  if (!Array.isArray(comment.sourceRanges) || !comment.sourceRanges.length || comment.sourceRanges.some(range => !range || !Number.isInteger(range.frameIn) || !Number.isInteger(range.frameOut) || range.frameIn < 0 || range.frameOut <= range.frameIn)) return null;
  const sorted = comment.sourceRanges.map(range => ({ ...range })).sort((a, b) => a.frameIn - b.frameIn);
  const ranges = [];
  for (const range of sorted) {
    const previous = ranges.at(-1);
    if (previous && range.frameIn <= previous.frameOut) previous.frameOut = Math.max(previous.frameOut, range.frameOut);
    else ranges.push(range);
  }
  return ranges;
}

function appendRange(ranges, range) {
  const previous = ranges.at(-1);
  // Output adjacency alone can hide a source gap created by a cut.
  if (previous && previous.frameOut === range.frameIn && previous.sourceOut === range.sourceIn) {
    previous.frameOut = range.frameOut; previous.sourceOut = range.sourceOut;
  } else ranges.push(range);
}

export function projectComment(comment, authoredVersion, targetVersion) {
  if (!comment || !validVersion(authoredVersion) || !validVersion(targetVersion) || authoredVersion.id !== comment.versionId || authoredVersion.assetId !== targetVersion.assetId || !Number.isInteger(comment.frameIn) || !Number.isInteger(comment.frameOut) || comment.frameIn < 0 || comment.frameOut <= comment.frameIn || comment.frameOut > authoredVersion.durationFrames) return unavailable();
  const anchors = sourceRanges(comment);
  if (!anchors) return unavailable();
  const originalContext = comment.contextFrame ?? comment.frameIn;
  const contextSource = sourceAtFrame(authoredVersion, originalContext);
  const contextFrame = contextSource === null ? null : frameAtSource(targetVersion, contextSource);
  const contextStatus = contextSource === null ? 'unavailable' : contextFrame === null ? 'deleted' : 'present';
  const ranges = [];

  if (authoredVersion.id === targetVersion.id) {
    // Source anchors have integer precision. Identity must preserve finer selections in slowed footage.
    for (const segment of targetVersion.timelineMap) {
      const frameIn = Math.max(comment.frameIn, segment.outputIn), frameOut = Math.min(comment.frameOut, segment.outputOut);
      if (frameOut <= frameIn) continue;
      const ratio = (segment.sourceOut - segment.sourceIn) / (segment.outputOut - segment.outputIn);
      appendRange(ranges, { frameIn, frameOut, sourceIn: segment.sourceIn + (frameIn - segment.outputIn) * ratio, sourceOut: segment.sourceIn + (frameOut - segment.outputIn) * ratio });
    }
    return { status: 'present', ranges, contextFrame: Number.isInteger(originalContext) && originalContext >= 0 && originalContext < targetVersion.durationFrames ? originalContext : null, contextStatus };
  }

  let covered = 0, quantizedAway = false;
  const requested = anchors.reduce((total, range) => total + range.frameOut - range.frameIn, 0);
  for (const segment of targetVersion.timelineMap) for (const anchor of anchors) {
    const sourceIn = Math.max(segment.sourceIn, anchor.frameIn), sourceOut = Math.min(segment.sourceOut, anchor.frameOut);
    if (sourceOut <= sourceIn) continue;
    covered += sourceOut - sourceIn;
    const ratio = (segment.outputOut - segment.outputIn) / (segment.sourceOut - segment.sourceIn);
    // Match the renderer's graphic interval quantization; do not invent a one-frame interval.
    const frameIn = clamp(Math.round(segment.outputIn + (sourceIn - segment.sourceIn) * ratio), segment.outputIn, segment.outputOut);
    const frameOut = clamp(Math.round(segment.outputIn + (sourceOut - segment.sourceIn) * ratio), segment.outputIn, segment.outputOut);
    if (frameOut <= frameIn) { quantizedAway = true; continue; }
    appendRange(ranges, { frameIn, frameOut, sourceIn, sourceOut });
  }
  const status = covered === 0 ? 'deleted' : !ranges.length ? 'unavailable' : covered < requested || quantizedAway ? 'partial' : 'present';
  return { status, ranges, contextFrame, contextStatus };
}
