/**
 * Scene-change scores on small area-averaged frames. Every frame passes through and its score is written by the
 * metadata filter, so a side branch never starves FFmpeg's progress reports the way a frame-dropping select does.
 */
export const SHOT_THRESHOLD = 0.3;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

/** Two escaping levels: the filter option value, then the filtergraph description. Arguments never pass through a shell. */
export const escapeFilterPath = path => String(path).replace(/[\\':]/g, '\\$&').replace(/[\\'[\],;]/g, '\\$&');

export function sceneScoreFilter(path) {
  if (!path || String(path).includes('\0') || /[\r\n]/.test(path)) throw failure('장면 전환 기록 파일 경로가 유효하지 않습니다.', 500);
  return `scale=160:90:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=area,select=gte(scene\\,0),metadata=mode=print:key=lavfi.scene_score:file=${escapeFilterPath(path)}`;
}

/** Cut frames are canonical 30 fps indexes whose score exceeds the threshold (the same rule as select=gt(scene,0.3)). */
export function parseSceneScores(text, durationFrames) {
  const cuts = new Set(); let frame = null;
  for (const line of String(text).split('\n')) {
    const timed = /^frame:\d+\s+pts:\S+\s+pts_time:(\S+)/.exec(line);
    if (timed) { const seconds = Number(timed[1]); frame = Number.isFinite(seconds) ? Math.round(seconds * 30) : null; continue; }
    const scored = /^lavfi\.scene_score=(\S+)/.exec(line);
    if (scored && frame !== null && Number(scored[1]) > SHOT_THRESHOLD && frame > 0 && frame < durationFrames) cuts.add(frame);
  }
  if (frame === null && String(text).trim()) throw failure('장면 전환 기록을 읽지 못했습니다.', 500);
  return [...cuts].sort((left, right) => left - right);
}
