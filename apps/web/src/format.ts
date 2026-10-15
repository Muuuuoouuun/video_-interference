export function time(frame: number, fps = 30) {
  const seconds = Math.max(0, frame) / fps;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}
export function duration(frame: number) { return `${(frame / 30).toFixed(1).replace(/\.0$/, '')}초`; }
