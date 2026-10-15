import { mkdir, mkdtemp, readFile, writeFile, rename, rm, copyFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { ffmpegPath, run } from './engine.mjs';
import { planCanonicalFrameDecode } from './canonical-frames.mjs';
import { validateDrawings } from './drawings.mjs';
import { groupDrawings } from '../../packages/core/drawing-anchors.mjs';

/** Local preparation only: this module has no network client and does not call a model. */
export function planRequestContextFrames(comment, durationFrames) {
  if (!Number.isInteger(durationFrames) || durationFrames < 1 || !Number.isInteger(comment.frameIn) || !Number.isInteger(comment.frameOut) || comment.frameIn < 0 || comment.frameOut <= comment.frameIn || comment.frameOut > durationFrames) throw new Error('자료를 준비할 작성 버전의 구간이 유효하지 않습니다.');
  const drawings = validateDrawings(comment.drawings, { durationFrames }), contextFrame = comment.contextFrame ?? comment.frameIn;
  const groups = groupDrawings(drawings, contextFrame), frames = new Map();
  const add = (frame, role, drawingIds = []) => {
    if (!Number.isInteger(frame) || frame < 0 || frame >= durationFrames) throw new Error('자료를 준비할 그림 프레임이 작성 버전을 벗어났습니다.');
    const item = frames.get(frame) || { frame, roles: [], drawingIds: [] };
    if (!item.roles.includes(role)) item.roles.push(role);
    item.drawingIds.push(...drawingIds); frames.set(frame, item);
  };
  add(contextFrame, 'comment-context'); add(comment.frameIn, 'request-start');
  add(Math.floor((comment.frameIn + comment.frameOut - 1) / 2), 'request-middle'); add(comment.frameOut - 1, 'request-end');
  for (const group of groups) add(group.frame, 'drawing-context', group.drawings.map(drawing => drawing.id));
  return { drawings, drawingContexts: groups.map(group => ({ frame: group.frame, drawingIds: group.drawings.map(drawing => drawing.id) })), sceneFrames: [...frames.values()].sort((left, right) => left.frame - right.frame) };
}

export async function prepareRequestContextBundle(comment, { versionPath, durationFrames, directory, attachments = [], files = {}, layerContext, signal }) {
  signal?.throwIfAborted();
  const planned = planRequestContextFrames(comment, durationFrames);
  if (comment.layerChange && (!layerContext || layerContext.targetLayer?.id !== comment.layerChange.targetLayerId || layerContext.targetLayer?.op?.id !== comment.layerChange.targetOpId || !Array.isArray(layerContext.proposedOperations) || !layerContext.proposedOperations.length)) throw new Error('그래픽 변경 대상과 현재 수정안을 찾지 못했습니다. 자료는 생략하지 않았습니다.');
  const layerMetadata = comment.layerChange ? structuredClone({ layerChange: comment.layerChange, layerTarget: layerContext.targetLayer, proposedOperationsRole: 'current-edit-proposals', proposedOperations: layerContext.proposedOperations }) : {};
  const requestedIds = [...new Set([...comment.attachmentIds, ...(comment.voiceAssetId ? [comment.voiceAssetId] : [])])];
  const selectedAttachments = attachments.filter(attachment => requestedIds.includes(attachment.id));
  if (requestedIds.some(id => !selectedAttachments.some(attachment => attachment.id === id))) throw new Error('요청에 저장된 첨부 자료를 모두 찾을 수 없습니다. 자료는 생략하지 않았습니다.');
  if (comment.attachmentIds.length > 10) throw new Error('한 요청의 첨부 자료는 최대 10개여야 합니다. 자료는 생략하지 않았습니다.');
  await mkdir(directory, { recursive: true }); const bundleDirectory = await mkdtemp(join(directory, 'request-context-')); let completed = false;
  try {
    const decode = planCanonicalFrameDecode(planned.sceneFrames.map(item => item.frame));
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...decode.inputArgs, '-i', versionPath, '-map', '0:v:0', '-an', '-vf', `select=${decode.select},scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`, '-fps_mode', 'vfr', '-frames:v', String(planned.sceneFrames.length), '-q:v', '3', '-start_number', '0', join(bundleDirectory, '%02d.jpg')], { signal });
    const sharp = (await import('sharp')).default, sceneFrames = [];
    for (let index = 0; index < planned.sceneFrames.length; index++) {
      signal?.throwIfAborted(); const item = planned.sceneFrames[index], file = `scene-${item.frame}.jpg`;
      await rename(join(bundleDirectory, `${String(index).padStart(2, '0')}.jpg`), join(bundleDirectory, file));
      const bytes = await readFile(join(bundleDirectory, file)), metadata = await sharp(bytes).metadata();
      sceneFrames.push({ ...item, file, mimeType: 'image/jpeg', width: metadata.width, height: metadata.height, bytes: bytes.length });
    }
    const preparedAttachments = [];
    for (let index = 0; index < selectedAttachments.length; index++) {
      signal?.throwIfAborted(); const attachment = selectedAttachments[index];
      if (!attachment.mimeType.startsWith('image/')) {
        const original = files[attachment.id].originalPath;
        const audioTypes = { '.webm': 'audio/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };
        const extension = original ? extname(attachment.name).toLowerCase() : '.m4a', suffix = audioTypes[extension] ? extension : '.audio';
        const file = `attachment-${index}${suffix}`; await copyFile(original || files[attachment.id].path, join(bundleDirectory, file));
        preparedAttachments.push({ id: attachment.id, name: attachment.name, role: attachment.role, mimeType: original ? audioTypes[suffix] || 'application/octet-stream' : attachment.mimeType, imagePrepared: false, source: original ? 'original-upload' : 'normalized-audio', file, bytes: (await stat(join(bundleDirectory, file))).size }); continue;
      }
      const file = `attachment-${index}.png`;
      await sharp(files[attachment.id].normalizedPath).resize(640, 640, { fit: 'inside', withoutEnlargement: true }).png().toFile(join(bundleDirectory, file));
      const bytes = await readFile(join(bundleDirectory, file)), metadata = await sharp(bytes).metadata();
      preparedAttachments.push({ id: attachment.id, name: attachment.name, role: attachment.role, mimeType: 'image/png', imagePrepared: true, file, width: metadata.width, height: metadata.height, bytes: bytes.length });
    }
    const instructionHistory = [{ source: 'original', text: comment.text, createdAt: comment.createdAt }, ...(comment.supplements || []).map(item => ({ source: 'supplement', ...item }))];
    const manifest = { preparation: 'local-only', modelCalled: false, networkUsed: false, externalConnection: 'not-connected', commentId: comment.id, versionId: comment.versionId, sceneDescription: { source: comment.sceneDescription ? 'user' : 'not-provided', text: comment.sceneDescription ?? '' }, sourceRanges: structuredClone(comment.sourceRanges), ...layerMetadata, frameIn: comment.frameIn, frameOut: comment.frameOut, contextFrame: comment.contextFrame ?? comment.frameIn, ...(comment.voiceAssetId ? { voiceAssetId: comment.voiceAssetId } : {}), fps: 30, instructionHistory, latestInstruction: instructionHistory.at(-1).text, drawings: planned.drawings, drawingsRole: 'original-request-annotations', drawingContexts: planned.drawingContexts, sceneFrames, attachments: preparedAttachments, diagnostics: { ffmpegRuns: 1, sceneImageCount: sceneFrames.length, attachmentImageCount: preparedAttachments.filter(attachment => attachment.imagePrepared).length }, automaticTranscription: false };
    const manifestPath = join(bundleDirectory, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest, null, 2)); completed = true;
    return { directory: bundleDirectory, manifestPath, manifest };
  } finally { if (!completed) await rm(bundleDirectory, { recursive: true, force: true }); }
}
