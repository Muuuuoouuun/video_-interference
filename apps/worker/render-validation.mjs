import { compileTimeline, mapToOutput } from './engine.mjs';
import { resolveLayerSnapshot } from '../../packages/core/layer-snapshot.mjs';

const conflict = message => Object.assign(new Error(message), { status: 409 });
const overlaps = (a, b) => a.sourceRanges.some(left => b.sourceRanges.some(right => Math.max(left.frameIn, right.frameIn) < Math.min(left.frameOut, right.frameOut)));

/** Existing version operations may be superseded; only simultaneous new conflicting requests block. */
export function validateRenderSelection(durationFrames, inherited, selected) {
  const speeds = selected.filter(op => op.type === 'speed');
  for (let index = 0; index < speeds.length; index++) for (let other = index + 1; other < speeds.length; other++) {
    if (speeds[index].params.factor !== speeds[other].params.factor && overlaps(speeds[index], speeds[other])) throw conflict('동시에 승인한 배속 요청의 구간이 겹치고 배율이 다릅니다. 한 요청을 반려하거나 구간을 나눠 주세요.');
  }
  const snapshot = resolveLayerSnapshot(inherited, selected);
  const timelineMap = compileTimeline(durationFrames, snapshot);
  for (const op of selected) if (op.layerChange?.action !== 'remove' && ['subtitle', 'overlay', 'audio', 'speed'].includes(op.type) && !mapToOutput(timelineMap, op.sourceRanges).length) throw conflict('새 편집 요청의 구간이 최종 영상에 남지 않습니다. 삭제 요청과 선택 구간을 확인해 주세요.');
  return { snapshot, timelineMap };
}
