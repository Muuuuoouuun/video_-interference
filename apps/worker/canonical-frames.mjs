/** Only for normalized, zero-based 30fps review/render media, never source VFR. */
export function planCanonicalFrameDecode(frames) {
  if (!Array.isArray(frames) || !frames.length || frames.some((frame, index) => !Number.isSafeInteger(frame) || frame < 0 || (index > 0 && frame <= frames[index - 1]))) {
    throw new Error('추출할 프레임은 시간순의 중복 없는 정수 목록이어야 합니다.');
  }
  // Seek on an exact whole-second boundary with one second of preroll. This
  // avoids fractional timestamp rounding while skipping the unused prefix.
  const seekSeconds = Math.max(0, Math.floor(frames[0] / 30) - 1);
  const skippedFrames = seekSeconds * 30;
  return {
    inputArgs: seekSeconds ? ['-ss', String(seekSeconds)] : [],
    select: frames.map(frame => `eq(n\\,${frame - skippedFrames})`).join('+'),
    skippedFrames
  };
}
