const validDuration = value => Number.isSafeInteger(value) && value > 0;
const clampFrame = (frame, durationFrames) => Math.max(0, Math.min(durationFrames - 1, frame));

/** Map the shared timeline coordinate space to a playable frame, excluding the EOF boundary. */
export function seekFrameAtPointer(clientX, left, width, durationFrames) {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0
    || !validDuration(durationFrames)) return null;
  // Bound the ratio before multiplication so extreme but finite coordinates cannot overflow.
  const ratio = Math.max(0, Math.min(1, (clientX - left) / width));
  return clampFrame(Math.round(ratio * durationFrames), durationFrames);
}

/** Canonical 30 fps navigation: arrows by frame/second, pages by five seconds. */
export function timelineSeekKey(key, currentFrame, durationFrames, shiftKey = false) {
  if (!Number.isSafeInteger(currentFrame) || !validDuration(durationFrames)) return null;
  const step = shiftKey ? 30 : 1;
  switch (key) {
    case 'ArrowLeft': return clampFrame(currentFrame - step, durationFrames);
    case 'ArrowRight': return clampFrame(currentFrame + step, durationFrames);
    case 'Home': return 0;
    case 'End': return durationFrames - 1;
    case 'PageUp': return clampFrame(currentFrame - 150, durationFrames);
    case 'PageDown': return clampFrame(currentFrame + 150, durationFrames);
    default: return null;
  }
}
