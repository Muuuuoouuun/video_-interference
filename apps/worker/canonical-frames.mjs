import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegPath, run } from './engine.mjs';
import { mapLimit } from './parallel.mjs';

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

/**
 * Splits sorted canonical frames into decode runs. Each run seeks once, so a gap longer than
 * `gapFrames` costs less as a new seek (about one second of preroll) than as decoded frames.
 */
export function planCanonicalFrameRuns(frames, { gapFrames = 120, maxFrames = 400 } = {}) {
  planCanonicalFrameDecode(frames);
  const runs = [];
  for (const frame of frames) {
    const current = runs.at(-1);
    if (current && frame - current.at(-1) <= gapFrames && current.length < maxFrames) current.push(frame); else runs.push([frame]);
  }
  return runs;
}

/**
 * Extracts exact canonical frames with one bounded seek+decode per run and returns output paths in frame order.
 * A run that yields the wrong number of images returns null for its frames; callers keep their own error wording.
 */
export async function extractCanonicalFrames({ videoPath, frames, directory, filter = '', extension = 'jpg', outputArgs = [], threads = 1, concurrency = 2, timeout = 120_000, signal }) {
  const runs = planCanonicalFrameRuns(frames), token = randomUUID().slice(0, 8);
  const parts = await mapLimit(runs, concurrency, async (selected, runIndex, runSignal) => {
    // A per-call token keeps earlier output in the same folder from being counted as this run's frames.
    const decode = planCanonicalFrameDecode(selected), prefix = `${token}-run${String(runIndex).padStart(4, '0')}-`;
    const threadArgs = threads ? ['-threads', String(threads)] : [];
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...threadArgs, ...decode.inputArgs, '-i', videoPath, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', `select=${decode.select}${filter ? `,${filter}` : ''}`, '-fps_mode', 'vfr', '-frames:v', String(selected.length), ...outputArgs, '-start_number', '0', ...threadArgs, join(directory, `${prefix}%06d.${extension}`)], { signal: runSignal, timeout });
    const pattern = new RegExp(`^${prefix}\\d{6}\\.${extension}$`);
    const produced = (await readdir(directory)).filter(name => pattern.test(name)).sort();
    return produced.length === selected.length ? produced.map(name => join(directory, name)) : selected.map(() => null);
  }, signal);
  return { paths: parts.flat(), runs: runs.length };
}
