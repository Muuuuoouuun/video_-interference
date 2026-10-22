/* Shared by the UXP panel and Node tests. No network, media decoding, or model calls. */
const TICKS_PER_SECOND = 254016000000;
const fail = message => { throw new Error(message); };
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const text = (s, max = 10000) => typeof s === 'string' && s.length <= max;

function validateBundle(bundle) {
  if (!bundle || bundle.kind !== 'video-interference-premiere' || bundle.schemaVersion !== 1 ||
      bundle.videoIncluded !== false || bundle.stillsIncluded !== false || bundle.snapshot !== 'full' ||
      !/^[a-f0-9]{24}$/.test(bundle.scope || '') || !text(bundle.project?.id, 100) ||
      !text(bundle.project?.name, 300) || !text(bundle.version?.id, 100) ||
      bundle.version?.fps !== 30 || !integer(bundle.version?.durationFrames, 1, 108000) ||
      !integer(bundle.canvas?.width, 1, 8192) || !integer(bundle.canvas?.height, 1, 8192) ||
      !Array.isArray(bundle.feedback) || bundle.feedback.length > 300) fail('지원하는 Premiere 연동 JSON이 아닙니다.');
  const ids = new Set();
  let overlayCount = 0, previewBytes = 0, rangeCount = 0;
  for (const entry of bundle.feedback) {
    if (!text(entry.id, 100) || !entry.id || ids.has(entry.id) ||
        !text(entry.text) || !text(entry.sceneDescription) || !Array.isArray(entry.supplements) ||
        entry.supplements.length > 100 || entry.supplements.some(s => !text(s.text)) ||
        !['present', 'partial', 'deleted', 'unavailable'].includes(entry.status) ||
        !Array.isArray(entry.ranges) || !Array.isArray(entry.overlays) ||
        entry.overlays.length > 30) fail('피드백 데이터가 유효하지 않습니다.');
    ids.add(entry.id);
    if (['deleted', 'unavailable'].includes(entry.status) && entry.ranges.length) fail('삭제된 장면에 위치를 지정할 수 없습니다.');
    for (const range of entry.ranges) {
      if (!integer(range.frameIn, 0, bundle.version.durationFrames - 1) ||
          !integer(range.frameOut, range.frameIn + 1, bundle.version.durationFrames)) fail('피드백 구간이 영상 범위를 벗어났습니다.');
      rangeCount++;
    }
    for (const overlay of entry.overlays) {
      overlayCount++;
      if (!['present', 'deleted', 'unavailable'].includes(overlay.status) ||
          (overlay.status === 'present' ? !integer(overlay.frame, 0, bundle.version.durationFrames - 1) : overlay.frame !== null) ||
          !integer(overlay.authoredFrame, 0, 108000) ||
          !Array.isArray(overlay.drawings) || overlay.drawings.length > 30 ||
          !/^overlays\/[0-9]{4}-[0-9]{2}\.png$/.test(overlay.file || '') ||
          !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(overlay.preview || '')) fail('도형 자료의 형식이 유효하지 않습니다.');
      previewBytes += overlay.preview.length;
    }
  }
  if (overlayCount > 300 || previewBytes > 32 * 1024 * 1024 || rangeCount > 2000) fail('연동 자료가 너무 큽니다. 피드백이나 그림 수를 줄여 주세요.');
  if (bundle.timelineOverlays !== undefined) {
    const timeline = bundle.timelineOverlays;
    if (timeline?.schemaVersion !== 1 || timeline.alpha !== 'straight' || timeline.pixelAspectRatio !== 1 ||
        !Array.isArray(timeline.segments) || timeline.segments.length > 600) fail('오버레이 구간 자료가 유효하지 않습니다.');
    let end = 0, bytes = 0;
    for (const segment of timeline.segments) {
      if (!integer(segment.frameIn, end, bundle.version.durationFrames - 1) ||
          !integer(segment.frameOut, segment.frameIn + 1, bundle.version.durationFrames) ||
          !/^[a-f0-9]{64}$/.test(segment.sha256 || '') || !integer(segment.bytes, 33, 128 * 1024 * 1024) ||
          segment.file !== `timeline-overlays/vi-${bundle.scope}-${segment.frameIn}-${segment.frameOut}-${segment.sha256}.png`) fail('오버레이 파일 또는 구간이 유효하지 않습니다.');
      end = segment.frameOut; bytes += segment.bytes;
    }
    if (bytes > 128 * 1024 * 1024) fail('오버레이 파일 합계가 너무 큽니다.');
  }
  return bundle;
}

function sequenceBinding(bundle, info, offsetSeconds = 0) {
  validateBundle(bundle);
  const frameSeconds = Number(info.timebase) / TICKS_PER_SECOND;
  if (!text(info.projectId, 100) || !info.projectId || !text(info.sequenceId, 100) || !info.sequenceId ||
      !Number.isFinite(frameSeconds) || frameSeconds < 1 / 240 || frameSeconds > 1 ||
      !Number.isFinite(info.endSeconds) || !Number.isFinite(offsetSeconds) || offsetSeconds < 0) fail('시퀀스 시간 정보를 확인해 주세요.');
  const offset = Math.round(offsetSeconds / frameSeconds) * frameSeconds;
  if (info.width !== bundle.canvas.width || info.height !== bundle.canvas.height) fail('영상과 시퀀스의 해상도가 다릅니다. 동일한 화면 크기의 시퀀스를 선택해 주세요.');
  if (info.endSeconds + frameSeconds < offset + bundle.version.durationFrames / 30) fail('시퀀스가 피드백 기준 영상보다 짧습니다. 시작 위치와 버전을 확인해 주세요.');
  return { ...info, scope: bundle.scope, offsetSeconds: offset, frameSeconds };
}

function assertBinding(binding, info) {
  if (!binding || ['projectId', 'sequenceId', 'timebase', 'width', 'height', 'endSeconds'].some(key => binding[key] !== info[key])) {
    fail('시퀀스 또는 길이·설정이 바뀌었습니다. 해당 영상 버전인지 확인하고 다시 연결해 주세요.');
  }
}

function sequenceSeconds(frame, binding) {
  return Math.round((frame / 30 + binding.offsetSeconds) / binding.frameSeconds) * binding.frameSeconds;
}

function markerPlan(bundle, binding) {
  validateBundle(bundle);
  if (binding.scope !== bundle.scope) fail('다른 영상 버전의 연결입니다. 시퀀스를 다시 연결해 주세요.');
  const prefix = `[VI:${bundle.scope}]`;
  const markers = [];
  for (const entry of bundle.feedback) entry.ranges.forEach((range, index) => {
    const startSeconds = sequenceSeconds(range.frameIn, binding);
    const durationSeconds = range.frameOut - range.frameIn === 1 ? 0 : sequenceSeconds(range.frameOut, binding) - startSeconds;
    if (durationSeconds < 0 || (range.frameOut - range.frameIn > 1 && durationSeconds === 0)) fail('이 시퀀스의 프레임레이트에서 너무 짧은 구간이 있습니다.');
    markers.push({
      name: `${prefix} ${entry.text.replace(/\s+/g, ' ').slice(0, 64) || '그림·메모'}`,
      comments: `${entry.sceneDescription ? `장면: ${entry.sceneDescription}\n\n` : ''}${entry.text}${entry.supplements.map(s => `\n\n추가: ${s.text}`).join('')}\n\n도형 ${entry.overlays.length}묶음 · Video Interference 패널에서 확인\n${prefix} ${entry.id} #${index + 1}`,
      startSeconds, durationSeconds,
    });
  });
  return { prefix, markers };
}

async function readSequenceInfo(project, sequence) {
  const [size, end, timebase] = await Promise.all([sequence.getFrameSize(), sequence.getEndTime(), sequence.getTimebase()]);
  return { projectId: project.guid.toString(), sequenceId: sequence.guid.toString(), name: sequence.name,
    width: size.width, height: size.height, endSeconds: end.seconds, timebase: String(timebase) };
}

async function syncMarkers(ppro, bundle, binding) {
  const project = await ppro.Project.getActiveProject();
  const sequence = project && await project.getActiveSequence();
  if (!sequence) fail('Premiere에서 시퀀스를 먼저 열어 주세요.');
  assertBinding(binding, await readSequenceInfo(project, sequence));
  const plan = markerPlan(bundle, binding);
  const collection = await ppro.Markers.getMarkers(sequence);
  const existing = await collection.getMarkers();
  // Only this project's exact exported version is owned. Other markers are untouched.
  const owned = existing.filter(marker => marker.getName().startsWith(`${plan.prefix} `) &&
    marker.getComments().includes(`\n${plan.prefix} `));
  if (!owned.length && !plan.markers.length) return { added: 0, replaced: 0 };
  let success = false;
  project.lockedAccess(() => {
    const actions = [
      ...owned.map(marker => collection.createRemoveMarkerAction(marker)),
      ...plan.markers.map(marker => collection.createAddMarkerAction(marker.name, 'Comment',
        ppro.TickTime.createWithSeconds(marker.startSeconds), ppro.TickTime.createWithSeconds(marker.durationSeconds), marker.comments)),
    ];
    success = project.executeTransaction(compound => { for (const action of actions) compound.addAction(action); }, 'Video Interference 피드백 갱신');
  });
  if (!success) fail('마커 갱신에 실패했습니다. Premiere에서 변경 상태를 확인해 주세요.');
  return { added: plan.markers.length, replaced: owned.length };
}

module.exports = { validateBundle, sequenceBinding, assertBinding, sequenceSeconds, markerPlan, readSequenceInfo, syncMarkers };
