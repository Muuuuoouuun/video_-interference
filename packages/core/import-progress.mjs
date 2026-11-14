const megabytes = bytes => `${(bytes / 1_000_000).toFixed(bytes >= 100_000_000 ? 0 : 1)}MB`;
const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

function remaining(progress, elapsedMs) {
  if (!(progress >= 0.05 && progress < 1 && elapsedMs >= 3000)) return '';
  const seconds = Math.round(elapsedMs * (1 - progress) / progress / 1000);
  return seconds < 60 ? ` · 약 ${Math.max(1, seconds)}초 남음` : ` · 약 ${Math.round(seconds / 60)}분 남음`;
}

/** Words for one import step. Upload bytes come from the browser; conversion progress comes from the worker. */
export function importProgressLabel({ stage, progress = 0, sentBytes = 0, totalBytes = 0, stageElapsedMs = 0 } = {}) {
  const value = clamp(progress), percent = Math.floor(value * 100);
  if (stage === 'receiving') {
    const detail = totalBytes ? `${megabytes(Math.min(sentBytes, totalBytes))} / ${megabytes(totalBytes)}` : '';
    return { step: 1, title: '영상 파일 받는 중', detail: `${detail}${remaining(value, stageElapsedMs)}`, percent, indeterminate: !totalBytes };
  }
  if (stage === 'converting' && value < 0.98) return { step: 2, title: '검토용 영상 만드는 중', detail: `30fps 검토본과 장면 전환 정보를 준비합니다${remaining(value, stageElapsedMs)}`, percent, indeterminate: value === 0 };
  return { step: 3, title: '마무리 중', detail: '썸네일과 프로젝트를 저장합니다', percent: 100, indeterminate: true };
}
