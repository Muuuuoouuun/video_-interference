/** Review markers are plain per-version bookmarks: no text, no feedback, not exported. */
const frames = markers => [...new Set(markers.map(marker => marker.frame))].sort((a, b) => a - b);

export function markerAt(markers, frame) {
  return markers.find(marker => marker.frame === frame);
}

/** Nearest marker frame strictly before (-1) or after (1) the playhead, or null. */
export function adjacentMarkerFrame(markers, frame, direction) {
  const sorted = frames(markers);
  if (direction > 0) return sorted.find(value => value > frame) ?? null;
  return sorted.findLast(value => value < frame) ?? null;
}

/** Half-open range from the last marker at or before the playhead to the next marker, or the end. */
export function markerLoopRange(markers, frame, durationFrames) {
  const sorted = frames(markers).filter(value => value >= 0 && value < durationFrames);
  const start = sorted.findLast(value => value <= frame);
  if (start === undefined) return null;
  const out = sorted.find(value => value > start) ?? durationFrames;
  return out - start > 1 ? { in: start, out } : null;
}
