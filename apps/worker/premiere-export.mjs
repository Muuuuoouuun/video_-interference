import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { projectComment } from '../../packages/core/comment-projection.mjs';
import { groupDrawings, projectDrawings } from '../../packages/core/drawing-anchors.mjs';
import { drawingsSvg, validateDrawings } from './drawings.mjs';
import bridge from '../../integrations/premiere/bridge.js';
import { overlayDisplayRanges, buildTimelineOverlays } from './premiere-overlay-export.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** Never accepts a video path or media file map. Pixels are rendered only from drawing geometry. */
export async function buildPremiereBundle(state, versionId) {
  const version = state?.versions?.find(item => item.id === versionId && item.status === 'ready');
  if (!version || !state.asset || !state.project) throw fail('완료된 영상 버전을 선택해 주세요.', 409);
  const comments = state.comments.filter(comment => !comment.deletedAt);
  if (comments.length > 300) throw fail('Premiere 연동은 최대 300개 피드백을 지원합니다.', 413);
  const canvas = { width: state.asset.width, height: state.asset.height };
  if (![canvas.width, canvas.height].every(value => Number.isInteger(value) && value > 0 && value <= 8192) ||
      canvas.width * canvas.height > 34_000_000) throw fail('영상 해상도가 연동 지원 범위를 벗어났습니다.');
  const bundle = {
    schemaVersion: 1, kind: 'video-interference-premiere', snapshot: 'full',
    scope: createHash('sha256').update(JSON.stringify([state.project.id, version.id])).digest('hex').slice(0, 24),
    createdAt: new Date().toISOString(), videoIncluded: false, stillsIncluded: false, modelCalled: false,
    project: { id: state.project.id, name: state.project.name },
    version: { id: version.id, number: version.number, label: version.label, durationFrames: version.durationFrames, fps: 30 },
    canvas, coordinateSpace: 'normalized; strokeWidth at width 1000; ranges [in,out); overlay frame is an annotation anchor, not an insertion duration',
    feedback: [],
  };
  let overlayCount = 0, previewBytes = 0;
  const pngs = [];
  for (const [index, comment] of comments.entries()) {
    const authored = state.versions.find(item => item.id === comment.versionId);
    if (!authored || authored.assetId !== version.assetId) throw fail('피드백 작성 버전을 확인할 수 없습니다.', 409);
    const drawings = validateDrawings(comment.drawings, { durationFrames: authored.durationFrames });
    const normalized = { ...comment, drawings };
    const projection = projectComment(normalized, authored, version);
    const projected = projectDrawings(normalized, authored, version);
    const entry = {
      id: comment.id, text: comment.text, sceneDescription: comment.sceneDescription || '',
      supplements: (comment.supplements || []).map(s => ({ text: s.text, createdAt: s.createdAt })),
      authored: { versionId: authored.id, frameIn: comment.frameIn, frameOut: comment.frameOut },
      status: projection.status,
      ranges: projection.ranges.map(({ frameIn, frameOut }) => ({ frameIn, frameOut })),
      overlays: [],
      excludedAttachmentCount: new Set([...(comment.attachmentIds || []), ...(comment.voiceAssetId ? [comment.voiceAssetId] : [])]).size,
    };
    const groups = groupDrawings(drawings, comment.contextFrame ?? comment.frameIn);
    for (const [groupIndex, group] of groups.entries()) {
      if (++overlayCount > 300) throw fail('그림 장면은 최대 300개까지 연동할 수 있습니다. 자료는 생략하지 않았습니다.', 413);
      const anchor = projected.find(item => item.authoredFrame === group.frame);
      const file = `overlays/${String(index + 1).padStart(4, '0')}-${String(groupIndex + 1).padStart(2, '0')}.png`;
      // Full-canvas transparent images retain placement when placed at 100% in the matching sequence.
      const png = await sharp(Buffer.from(drawingsSvg(canvas.width, canvas.height, group.drawings))).png().toBuffer();
      const thumbnail = await sharp(png).resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      const preview = `data:image/png;base64,${thumbnail.toString('base64')}`;
      previewBytes += preview.length;
      if (previewBytes > 32 * 1024 * 1024) throw fail('도형 이미지가 32MB를 넘었습니다. 그림 수를 줄여 주세요.', 413);
      pngs.push({ file, bytes: png });
      entry.overlays.push({ authoredFrame: group.frame, frame: anchor.frame, status: anchor.status,
        drawings: group.drawings, file, preview,
        displayRanges: overlayDisplayRanges(normalized, authored, version, groups, groupIndex, anchor.status) });
    }
    bundle.feedback.push(entry);
  }
  const timelinePngs = await buildTimelineOverlays(bundle, pngs);
  bridge.validateBundle(bundle);
  return { bundle, pngs, timelinePngs };
}

export async function preparePremiereExport(state, versionId, directory) {
  // Freeze before the first asynchronous rasterization so comments cannot mix revisions.
  const { bundle, pngs, timelinePngs } = await buildPremiereBundle(structuredClone(state), versionId);
  await mkdir(directory, { recursive: true });
  const work = await mkdtemp(join(directory, 'handoff-'));
  try {
    const manifestPath = join(work, 'premiere-feedback.json'), archivePath = join(work, 'premiere-feedback.zip');
    const pluginArchivePath = join(work, 'premiere-panel.zip');
    const serialized = JSON.stringify(bundle, null, 2);
    if (Buffer.byteLength(serialized) > 48 * 1024 * 1024) throw fail('연동 데이터가 너무 큽니다.', 413);
    await writeFile(manifestPath, serialized);
    if (pngs.length) await mkdir(join(work, 'overlays'));
    for (const png of pngs) await writeFile(join(work, png.file), png.bytes);
    if (timelinePngs.length) await mkdir(join(work, 'timeline-overlays'));
    for (const png of timelinePngs) await writeFile(join(work, png.file), png.bytes);
    await writeFile(join(work, 'README.txt'), `Video Interference → Premiere

1. 이 묶음을 프로젝트와 함께 보관할 폴더에 압축 해제합니다.
2. Premiere 패널에서 '오버레이 묶음 폴더 열기'로 이 폴더를 선택합니다.
3. 같은 편집 버전·해상도의 정사각형 픽셀 시퀀스를 연결합니다.
4. 영상 위에 빈 영상 트랙을 준비하고 '파일·배치 확인' → '오버레이 적용'을 누릅니다.
5. 댓글은 '마커 갱신'으로 별도 반영합니다.

영상·스틸·참고 이미지·음성은 포함하지 않습니다. AI 호출은 없습니다.
댓글 IN–OUT 구간 동안 투명 PNG를 표시하며, 다음 그림 시점에 교체합니다.
시점 댓글은 한 프레임입니다. 겹치는 그림은 한 캔버스에 합칩니다.
삭제된 장면 또는 댓글 구간 밖의 그림은 자료에 남기지만 트랙에 배치하지 않습니다.
PNG는 원래 영상 전체 크기입니다. 같은 크기 시퀀스의 기본 중앙 위치·100% 배율로 좌표를 맞춥니다.
Premiere에서 편집 가능한 벡터 도형으로 변환하지 않습니다.
다시 적용하면 같은 버전의 전용 트랙 오버레이만 교체합니다.
적용 후 폴더를 이동·삭제하면 Premiere에서 오프라인 미디어가 됩니다.
시퀀스를 다시 편집한 뒤에는 새 기준 영상으로 다시 검토하세요.
실제 Premiere 호스트 검증은 아직 필요합니다.
`);
    const zip = (output, entries) => new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/zip', ['-q', output, '-@'], { cwd: work, stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.stdin.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`연동 묶음을 만들지 못했습니다: ${stderr.slice(0, 500)}`)));
      child.stdin.end(entries.join('\n') + '\n');
    });
    await zip(archivePath, ['premiere-feedback.json', 'README.txt', ...pngs.map(item => item.file), ...timelinePngs.map(item => item.file)]);
    // Package the small offline panel separately; no build tool or npm install is needed by the recipient.
    const pluginFiles = ['manifest.json', 'index.html', 'main.js', 'bridge.js', 'overlays.js', 'sha256.js', 'style.css', 'README.md'];
    await mkdir(join(work, 'premiere-panel'));
    for (const name of pluginFiles) await copyFile(new URL(`../../integrations/premiere/${name}`, import.meta.url), join(work, 'premiere-panel', name));
    await zip(pluginArchivePath, pluginFiles.map(name => `premiere-panel/${name}`));
    return { directory: work, manifestPath, archivePath, pluginArchivePath, commentCount: bundle.feedback.length, overlayCount: pngs.length,
      unplacedCount: bundle.feedback.filter(entry => !entry.ranges.length).length,
      timelineSegmentCount: bundle.timelineOverlays.segments.length, skippedOverlayCount: bundle.timelineOverlays.skippedGroups };
  } catch (error) { await rm(work, { recursive: true, force: true }); throw error; }
}
