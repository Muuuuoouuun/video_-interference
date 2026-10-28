import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, copyFile, stat, rm, readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { dirname, join, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { readJsonBody as bodyJson } from './request-body.mjs';
import { ingest, renderVideo, mapToSource, mapToOutput, probe, run, ffmpegPath, shutdownMediaProcesses } from './engine.mjs';
import { interpret, interpreterMode } from './interpreter.mjs';
import { validateDrawings } from './drawings.mjs';
import { groupDrawings } from '../../packages/core/drawing-anchors.mjs';
import { validateRenderSelection } from './render-validation.mjs';
import { prepareRequestContextBundle } from './context-bundle.mjs';
import { isVisualOp, visualLayerId } from '../../packages/core/layer-snapshot.mjs';
import { prepareFilmstrip, readFilmstripCache } from './filmstrip.mjs';
import { prepareFeedbackExport, selectFeedbackComments } from './feedback-export.mjs';
import { preparePremiereExport } from './premiere-export.mjs';
import { FEEDBACK_CATEGORIES } from '../../packages/core/feedback-category.mjs';
import { IMAGE_ATTACHMENT_LIMIT, VOICE_MAX_BYTES, VOICE_MAX_SECONDS } from '../../packages/core/comment-attachments.mjs';
import { transcribeVoice, transcriptionConfig } from './transcription.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const storageRoot = process.env.VI_STORAGE_ROOT || join(root, 'storage');
const port = Number(process.env.PORT || 4318);
const devPort = Number(process.env.VI_DEV_PORT || 4317);
const samplePath = process.env.VI_SAMPLE_PATH || join(root, 'fixtures/demo.mp4');
const store = openStore(storageRoot);
const { data, save } = store;
const uid = prefix => `${prefix}_${randomUUID().slice(0, 12)}`;
const now = () => new Date().toISOString();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
let importing = false, rendering = false, attaching = 0;
let shuttingDown = false;
const interpreting = new Set();
const jobControllers = new Map();
const interpretationControllers = new Map();
const requestTasks = new Set();
const renderTasks = new Map();
const initializationTasks = new Set();
const filmstripTasks = new Map();
const feedbackExportTasks = new Map();
let premiereExportInFlight = false;
const transcriptionControllers = new Map();
let filmstripTail = Promise.resolve();

await mkdir(join(storageRoot, 'media'), { recursive: true });
await mkdir(join(storageRoot, 'jobs'), { recursive: true });

function publicState() {
  const capabilities = { ffmpeg: true, interpreter: interpreterMode(), interpreterLabel: interpreterMode() === 'anthropic' ? 'Claude API 연결됨 · 승인 후 실행' : '로컬 규칙 해석 · AI API 미연결', transcription: Boolean(transcriptionConfig()), maxDurationSeconds: 600, fps: 30, supportedOps: ['cut', 'trim', 'speed', 'subtitle', 'overlay', 'audio', 'note'] };
  if (!data.state) return { empty: true, capabilities };
  const comments = data.state.comments.filter(comment => !comment.deletedAt), ids = new Set(comments.map(comment => comment.id));
  return { ...data.state, markers: data.state.markers ?? [], comments, deletedComments: data.state.comments.filter(comment => comment.deletedAt), ops: data.state.ops.filter(op => ids.has(op.commentId)), capabilities };
}

function requireProject() {
  if (shuttingDown) throw fail('앱을 종료하는 중입니다.', 503);
  if (importing) throw fail('새 영상을 가져오는 중입니다. 완료 후 요청을 저장해 주세요.', 409);
  if (!data.state) throw fail('먼저 영상을 열어 주세요.', 409);
}

function assertWorkspace(workspace) {
  requireProject();
  if (data.state !== workspace) throw fail('프로젝트가 변경됐습니다. 현재 영상에서 다시 요청해 주세요.', 409);
}

async function projectBody(req) {
  requireProject(); const workspace = data.state;
  const input = await bodyJson(req);
  assertWorkspace(workspace);
  return { input, workspace };
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value));
}

function safeName(req) {
  const value = req.headers['x-file-name'];
  if (!value || typeof value !== 'string') throw fail('x-file-name 헤더가 필요합니다.');
  let name; try { name = decodeURIComponent(value); } catch { throw fail('파일 이름을 해석하지 못했습니다.'); }
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) throw fail('파일 이름에 경로를 지정할 수 없습니다.');
  return basename(name).replace(/[\r\n]/g, '').slice(0, 180) || 'untitled';
}

async function receiveFile(req, path, maxBytes) {
  if (Number(req.headers['content-length'] || 0) > maxBytes) throw fail('파일 크기 제한을 초과했습니다.', 413);
  let total = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) { total += chunk.length; callback(total > maxBytes ? fail('파일 크기 제한을 초과했습니다.', 413) : null, chunk); } });
  try { await pipeline(req, limiter, createWriteStream(path, { flags: 'wx' })); if (!total) throw fail('빈 파일은 열 수 없습니다.'); }
  catch (error) { await rm(path, { force: true }); throw error; }
}

async function importAsset(sourcePath, name) {
  const assetId = uid('asset'), versionId = uid('version');
  const previewId = `${assetId}_preview`, thumbId = `${assetId}_thumb`;
  const previewPath = join(storageRoot, 'media', `${previewId}.mp4`), thumbPath = join(storageRoot, 'media', `${thumbId}.jpg`);
  let info;
  try { info = await ingest(sourcePath, previewPath, thumbPath); }
  catch (error) { await Promise.all([rm(previewPath, { force: true }), rm(thumbPath, { force: true })]); throw error; }
  if (shuttingDown) throw fail('앱을 종료하는 중입니다.', 503);
  if (data.state) {
    const archiveRoot = join(storageRoot, 'archives'); await mkdir(archiveRoot, { recursive: true });
    await writeFile(join(archiveRoot, `${data.state.project.id}-${Date.now()}.json`), JSON.stringify({ state: data.state, files: data.files, snapshots: data.snapshots }, null, 2));
  }
  if (shuttingDown) throw fail('앱을 종료하는 중입니다.', 503);
  const asset = { id: assetId, name, ...info, mediaUrl: `/media/${previewId}`, thumbnailUrl: `/media/${thumbId}` };
  const timelineMap = [{ sourceIn: 0, sourceOut: info.durationFrames, outputIn: 0, outputOut: info.durationFrames, speed: 1, volume: 1 }];
  const version = { id: versionId, assetId, number: 1, parentVersionId: null, durationFrames: info.durationFrames, mediaUrl: asset.mediaUrl, thumbnailUrl: asset.thumbnailUrl, opIds: [], appliedOpIds: [], timelineMap, createdAt: now(), status: 'ready', label: '원본' };
  data.state = { project: { id: uid('project'), name: name.replace(/\.[^.]+$/, ''), activeVersionId: versionId, createdAt: now() }, asset, versions: [version], comments: [], ops: [], jobs: [], attachments: [], markers: [] };
  data.files[assetId] = { sourcePath, previewPath, path: sourcePath, mimeType: 'application/octet-stream', name };
  data.files[previewId] = { path: previewPath, mimeType: 'video/mp4', name: `${data.state.project.name}.mp4` };
  data.files[thumbId] = { path: thumbPath, mimeType: 'image/jpeg', name: 'thumbnail.jpg' };
  data.snapshots[versionId] = [];
  save(); return { asset, version };
}

function createComment(input) {
  requireProject();
  const version = data.state.versions.find(v => v.id === input.versionId && v.status === 'ready');
  if (!version) throw fail('요청을 남길 버전을 찾지 못했습니다.');
  const frameIn = input.frameIn, frameOut = input.frameOut ?? Math.min(frameIn + 1, version.durationFrames);
  if (!Number.isInteger(frameIn) || !Number.isInteger(frameOut) || frameIn < 0 || frameOut <= frameIn || frameOut > version.durationFrames) throw fail('요청 구간이 영상 범위를 벗어났습니다.');
  const contextFrame = input.contextFrame ?? frameIn;
  if (!Number.isInteger(contextFrame) || contextFrame < 0 || contextFrame >= version.durationFrames) throw fail('화면 맥락 프레임이 영상 범위를 벗어났습니다.');
  const kind = input.kind ?? 'request';
  if (!['request', 'note'].includes(kind)) throw fail('댓글 종류는 request 또는 note로 지정해 주세요.');
  if (input.sceneDescription !== undefined && (typeof input.sceneDescription !== 'string' || input.sceneDescription.length > 500)) throw fail('장면 설명은 500자 이하로 작성해 주세요.');
  if (input.category !== undefined && !FEEDBACK_CATEGORIES.includes(input.category)) throw fail('피드백 분야를 확인해 주세요.');
  const sceneDescription = input.sceneDescription?.trim();
  if (typeof input.text !== 'string' || input.text.length > 5000) throw fail('요청 문구는 5,000자 이하로 작성해 주세요.');
  const attachments = Array.isArray(input.attachmentIds) ? input.attachmentIds : [];
  if (attachments.length > IMAGE_ATTACHMENT_LIMIT) throw fail(`한 피드백에 이미지는 최대 ${IMAGE_ATTACHMENT_LIMIT}개까지 첨부할 수 있습니다. 음성은 별도로 저장합니다.`);
  if (attachments.some(id => !data.state.attachments.some(a => a.id === id))) throw fail('첨부 파일을 찾지 못했습니다.');
  if (input.voiceAssetId && !data.state.attachments.some(a => a.id === input.voiceAssetId && a.role === 'voice')) throw fail('음성 메모를 찾지 못했습니다.');
  const drawings = validateDrawings(input.drawings, { durationFrames: version.durationFrames });
  if (!input.text.trim() && !input.voiceAssetId && !drawings.length && !attachments.length && !(kind === 'note' && sceneDescription)) throw fail('요청 문구나 음성·드로잉·첨부 자료를 추가해 주세요.');
  const comment = { id: uid('comment'), versionId: version.id, frameIn, frameOut, contextFrame, kind, ...(kind !== 'note' && input.category !== undefined ? { category: input.category } : {}), text: input.text.trim(), ...(sceneDescription ? { sceneDescription } : {}), drawings, attachmentIds: attachments, ...(input.voiceAssetId ? { voiceAssetId: input.voiceAssetId } : {}), status: 'received', createdAt: now(), sourceRanges: mapToSource(version.timelineMap, frameIn, frameOut) };
  data.state.comments.push(comment); save(); return comment;
}

function appendCommentSupplement(comment, input, workspace) {
  assertWorkspace(workspace);
  assertVisibleComment(comment);
  if (comment.layerChange) throw fail('그래픽 수정·제거 요청은 추가 지시로 바꿀 수 없습니다. 편집 값에서 수정해 주세요.', 409);
  if (interpreting.has(comment.id)) throw fail('이 요청을 해석 중입니다. 완료 후 추가 지시를 저장해 주세요.', 409);
  if (rendering || workspace.jobs.some(job => ['queued', 'running'].includes(job.status))) throw fail('렌더가 끝난 후 추가 지시를 저장해 주세요.', 409);
  if (comment.status === 'applied' || workspace.ops.some(op => op.commentId === comment.id && op.status === 'applied')) throw fail('이미 적용한 요청은 보완할 수 없습니다. 현재 버전에서 새 요청을 남겨 주세요.', 409);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'text') || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 5000) throw fail('추가 지시는 1~5,000자로 적어 주세요.');
  const text = input.text.trim(), supplements = comment.supplements || [];
  if (supplements.length >= 20) throw fail('한 요청에는 추가 지시를 최대 20개까지 저장할 수 있습니다.');
  if (comment.text.length + supplements.reduce((sum, item) => sum + item.text.length, 0) + text.length > 20_000) throw fail('원문과 추가 지시의 합계는 20,000자 이하여야 합니다.');
  // Only commit after locks and every size check pass. Original context and anchors stay intact.
  comment.supplements = [...supplements, { id: uid('supplement'), text, createdAt: now() }];
  workspace.ops = workspace.ops.filter(op => op.commentId !== comment.id);
  comment.status = 'received'; delete comment.clarification;
  save(); return comment;
}

function assertVisibleComment(comment) {
  if (comment.deletedAt) throw fail('삭제한 피드백입니다. 먼저 되돌려 주세요.', 404);
}

function assertCommentIdle(comment, workspace) {
  assertWorkspace(workspace);
  if (interpreting.has(comment.id)) throw fail('이 피드백의 해석이나 자료 준비가 진행 중입니다. 완료 후 다시 시도해 주세요.', 409);
  if (rendering || workspace.jobs.some(job => ['queued', 'running'].includes(job.status))) throw fail('렌더가 끝난 후 피드백을 변경해 주세요.', 409);
}

function hasAppliedComment(comment, workspace) {
  return comment.status === 'applied' || workspace.ops.some(op => op.commentId === comment.id && op.status === 'applied');
}

function editComment(comment, input, workspace) {
  assertVisibleComment(comment); assertCommentIdle(comment, workspace);
  if (comment.layerChange) throw fail('그래픽 수정·제거 요청은 편집 값에서 수정해 주세요.', 409);
  if (hasAppliedComment(comment, workspace)) throw fail('이미 적용한 피드백은 수정할 수 없습니다. 현재 버전에서 새 피드백을 남겨 주세요.', 409);
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key => !['text', 'sceneDescription', 'category'].includes(key))) throw fail('피드백 문구·장면 설명·분야만 수정할 수 있습니다.');
  if (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 5000)) throw fail('피드백 문구는 5,000자 이하로 작성해 주세요.');
  if (input.sceneDescription !== undefined && (typeof input.sceneDescription !== 'string' || input.sceneDescription.length > 500)) throw fail('장면 설명은 500자 이하로 작성해 주세요.');
  if (input.category !== undefined && (!FEEDBACK_CATEGORIES.includes(input.category) || comment.kind === 'note')) throw fail('피드백 분야를 확인해 주세요.');
  const text = input.text === undefined ? comment.text : input.text.trim();
  const sceneDescription = input.sceneDescription === undefined ? comment.sceneDescription : input.sceneDescription.trim();
  if (!text && !comment.voiceAssetId && !comment.drawings.length && !comment.attachmentIds.length && !(comment.kind === 'note' && sceneDescription)) throw fail('피드백 문구나 음성·드로잉·첨부 자료를 추가해 주세요.');
  if (text.length + (comment.supplements ?? []).reduce((sum, item) => sum + item.text.length, 0) > 20_000) throw fail('원문과 추가 지시의 합계는 20,000자 이하여야 합니다.');
  const contentChanged = text !== comment.text || (sceneDescription || '') !== (comment.sceneDescription || '');
  if (!contentChanged) {
    if (input.category !== undefined && input.category !== (comment.category ?? 'video')) { comment.category = input.category; save(); }
    return comment;
  }
  const editedAt = now();
  comment.revisions = [...(comment.revisions ?? []), { id: uid('revision'), text: comment.text, ...(comment.sceneDescription ? { sceneDescription: comment.sceneDescription } : {}), editedAt }];
  comment.text = text; comment.updatedAt = editedAt;
  if (input.category !== undefined) comment.category = input.category;
  if (sceneDescription) comment.sceneDescription = sceneDescription; else delete comment.sceneDescription;
  workspace.ops = workspace.ops.filter(op => op.commentId !== comment.id);
  comment.status = 'received'; delete comment.clarification;
  save(); return comment;
}

function createMarker(input, workspace) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['versionId', 'frame'].includes(key))) throw fail('마커 형식이 유효하지 않습니다.');
  const version = workspace.versions.find(item => item.id === input.versionId && item.status === 'ready'); if (!version) throw fail('마커를 찍을 버전을 찾지 못했습니다.', 404);
  if (!Number.isInteger(input.frame) || input.frame < 0 || input.frame >= version.durationFrames) throw fail('마커 위치가 영상 범위를 벗어났습니다.');
  workspace.markers ??= [];
  // Repeated presses on one frame keep one marker.
  const existing = workspace.markers.find(item => item.versionId === version.id && item.frame === input.frame); if (existing) return existing;
  const marker = { id: uid('marker'), versionId: version.id, frame: input.frame, createdAt: now() };
  workspace.markers.push(marker); save(); return marker;
}

function deleteComment(comment, workspace) {
  assertCommentIdle(comment, workspace);
  if (comment.deletedAt) return comment;
  comment.deletedAt = now();
  // Keep applied operations and immutable snapshots. Layer revisions retain their manually
  // authored proposal, but removing/restoring one never restores an approval.
  workspace.ops = workspace.ops.filter(op => op.commentId !== comment.id || op.status === 'applied' || comment.layerChange);
  for (const op of workspace.ops) if (op.commentId === comment.id && op.status !== 'applied') op.status = 'proposed';
  if (!hasAppliedComment(comment, workspace)) { comment.status = comment.layerChange ? 'interpreted' : 'received'; delete comment.clarification; }
  save(); return comment;
}

function restoreComment(comment, workspace) {
  assertCommentIdle(comment, workspace);
  if (!comment.deletedAt) return comment;
  delete comment.deletedAt;
  save(); return comment;
}

function validateOpParameters(op, value, contextComment = data.state.comments.find(c => c.id === op.commentId)) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('편집 값 형식이 유효하지 않습니다.');
  const allowed = { cut: [], trim: [], speed: ['factor'], subtitle: ['text', 'kind', 'color'], overlay: ['text', 'kind', 'assetRef', 'color', 'drawings'], audio: ['volume'], note: [] }[op.type];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw fail('지원하지 않는 편집 값입니다.');
  const params = { ...op.params, ...value };
  if (op.type === 'speed' && (!Number.isFinite(params.factor) || params.factor < 0.25 || params.factor > 4)) throw fail('배속은 원본 기준 0.25~4배 사이로 지정해 주세요.');
  if (op.type === 'audio' && (!Number.isFinite(params.volume) || params.volume < 0 || params.volume > 2)) throw fail('음량은 0~200% 사이로 지정해 주세요.');
  if (op.type === 'subtitle' || (op.type === 'overlay' && params.kind === 'text')) {
    if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 300) throw fail('표시 문구는 1~300자로 적어 주세요.');
    params.text = params.text.trim();
  }
  if (params.color !== undefined && !/^#[a-f\d]{6}$/i.test(params.color)) throw fail('그래픽 색상 형식이 유효하지 않습니다.');
  if (op.type === 'subtitle' && params.kind !== 'text') throw fail('자막은 텍스트 종류만 지원합니다.');
  if (op.type === 'overlay') {
    if (!['image', 'text', 'box', 'drawing'].includes(params.kind)) throw fail('그래픽 종류가 유효하지 않습니다.');
    const comment = contextComment;
    if (params.kind === 'image' && !data.state.attachments.some(a => a.id === params.assetRef && comment?.attachmentIds.includes(a.id) && a.role === 'insert' && a.mimeType.startsWith('image/'))) throw fail('해당 요청에 첨부한 삽입 이미지만 사용할 수 있습니다.');
    if (params.kind === 'drawing') {
      const authored = data.state.versions.find(version => version.id === op.versionId);
      params.drawings = validateDrawings(params.drawings, { durationFrames: authored?.durationFrames });
      if (!params.drawings.length) throw fail('영상에 넣을 드로잉이 필요합니다.');
      if (groupDrawings(params.drawings, comment?.contextFrame ?? comment?.frameIn ?? op.frameIn).length > 1) throw fail('여러 장면의 그림은 함께 삽입할 수 없습니다. 한 장면의 그림을 새 요청에 복사해 삽입해 주세요.', 409);
    }
  }
  return params;
}

function validateOpRegion(op, region) {
  if (!['overlay', 'subtitle'].includes(op.type)) throw fail('화면 영역은 그래픽과 자막 요청에서만 지정할 수 있습니다.');
  if (!region || typeof region !== 'object' || Array.isArray(region) || Object.keys(region).some(key => !['x', 'y', 'w', 'h'].includes(key)) || ![region.x, region.y, region.w, region.h].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.w < 0.002 || region.h < 0.002 || region.x + region.w > 1 + 1e-9 || region.y + region.h > 1 + 1e-9) throw fail('화면 영역은 영상 안에서 너비와 높이 0.2% 이상이어야 합니다.');
  return { x: region.x, y: region.y, w: Math.min(region.w, 1 - region.x), h: Math.min(region.h, 1 - region.y) };
}

function versionLayers(versionId) {
  requireProject();
  const version = data.state.versions.find(item => item.id === versionId && item.status === 'ready');
  if (!version) throw fail('완료된 기준 버전을 찾지 못했습니다.', 404);
  const layers = (data.snapshots[version.id] || []).filter(isVisualOp).map(op => ({ id: visualLayerId(op), op: structuredClone(op), outputRanges: mapToOutput(version.timelineMap, op.sourceRanges) }));
  return { version, layers };
}

function createLayerChange(versionId, layerId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'targetOpId', 'params', 'region'].includes(key))) throw fail('그래픽 변경 요청 형식이 유효하지 않습니다.');
  if (!['replace', 'remove'].includes(input.action) || typeof input.targetOpId !== 'string') throw fail('변경 종류와 현재 그래픽 식별자가 필요합니다.');
  if (rendering) throw fail('렌더가 끝난 후 그래픽 변경을 요청해 주세요.', 409);
  const { version, layers } = versionLayers(versionId), layer = layers.find(item => item.id === layerId);
  if (!layer) throw fail('이 버전에서 그래픽을 찾지 못했습니다.', 404);
  if (layer.op.id !== input.targetOpId) throw fail('그래픽이 다른 내용으로 변경되었습니다. 현재 버전에서 다시 선택해 주세요.', 409);
  if (!layer.outputRanges.length) throw fail('이 그래픽의 구간이 현재 영상에 남아 있지 않습니다. 이전 버전에서 변경해 주세요.', 409);
  if (input.action === 'remove' && (input.params !== undefined || input.region !== undefined)) throw fail('제거 요청에는 편집 값을 지정할 수 없습니다.');
  if (input.action === 'replace' && input.params === undefined && input.region === undefined) throw fail('수정할 편집 값을 지정해 주세요.');
  const frameIn = Math.min(...layer.outputRanges.map(range => range.frameIn)), frameOut = Math.max(...layer.outputRanges.map(range => range.frameOut));
  const layerChange = { action: input.action, targetLayerId: layer.id, targetOpId: layer.op.id };
  const commentId = uid('comment'), createdAt = now();
  if (input.params !== undefined && (!input.params || typeof input.params !== 'object' || Array.isArray(input.params))) throw fail('편집 값 형식이 유효하지 않습니다.');
  const params = structuredClone(layer.op.params);
  // Drawings in the new proposal belong to the current version, while the parent retains its authored frames.
  const rebase = drawings => Array.isArray(drawings) ? drawings.map(drawing => ({ ...drawing, frame: frameIn })) : drawings;
  if (params.drawings) params.drawings = rebase(params.drawings);
  const candidateParams = input.params === undefined ? params : { ...params, ...input.params };
  if (candidateParams.drawings) candidateParams.drawings = rebase(candidateParams.drawings);
  const attachmentIds = candidateParams.kind === 'image' && candidateParams.assetRef ? [candidateParams.assetRef] : [];
  const comment = { id: commentId, versionId: version.id, frameIn, frameOut, contextFrame: frameIn, kind: 'request', text: `${layer.op.type === 'subtitle' ? '자막' : '그래픽'} ${input.action === 'remove' ? '제거' : '수정'}`, drawings: [], attachmentIds, status: 'interpreted', createdAt, sourceRanges: structuredClone(layer.op.sourceRanges), layerChange };
  const op = { ...structuredClone(layer.op), id: uid('op'), commentId, versionId: version.id, frameIn, frameOut, sourceRanges: structuredClone(layer.op.sourceRanges), params, status: 'proposed', aiNote: input.action === 'remove' ? '기존 그래픽을 다음 버전에서 제거합니다. 이전 버전은 유지됩니다.' : '기존 그래픽을 같은 쌓임 순서에서 수정합니다. 이전 버전은 유지됩니다.', createdAt, interpreter: 'manual', layerId: layer.id, layerChange: { ...layerChange } };
  op.params = validateOpParameters(op, candidateParams, comment);
  if (input.region !== undefined) op.region = validateOpRegion(op, input.region);
  if (op.params.kind === 'drawing') comment.drawings = structuredClone(op.params.drawings);
  data.state.comments.push(comment); data.state.ops.push(op); save();
  return { comment, op };
}

async function interpretComment(comment, workspace = data.state) {
  assertWorkspace(workspace);
  assertVisibleComment(comment);
  if (!workspace.comments.includes(comment)) throw fail('현재 프로젝트의 요청이 아닙니다.', 409);
  if (comment.layerChange) throw fail('그래픽 수정·제거 요청은 다시 해석하지 않습니다. 편집 값을 확인한 뒤 승인해 주세요.', 409);
  if ((comment.kind ?? 'request') === 'note') throw fail('메모는 편집 작업으로 실행하지 않습니다. 편집 요청으로 새 댓글을 남겨 주세요.', 409);
  if (interpreting.has(comment.id)) throw fail('이 요청을 이미 해석 중입니다. 완료 후 다시 시도해 주세요.', 409);
  const preserveApproved = () => {
    if (workspace.ops.some(op => op.commentId === comment.id && ['approved', 'applied'].includes(op.status))) throw fail('승인하거나 적용한 요청은 다시 해석할 수 없습니다. 새 요청을 남겨 주세요.', 409);
  };
  preserveApproved(); cancelFilmstrips('요청 자료 준비를 우선 실행합니다. 완료 후 시간축 썸네일을 다시 불러와 주세요.'); interpreting.add(comment.id);
  const controller = new AbortController(); interpretationControllers.set(comment.id, controller);
  try {
    const version = workspace.versions.find(v => v.id === comment.versionId);
    const mediaId = version.mediaUrl.split('/').at(-1);
    const result = await interpret(comment, { attachments: workspace.attachments, files: data.files, versionPath: data.files[mediaId].path, durationFrames: version.durationFrames, directory: join(storageRoot, 'jobs'), signal: controller.signal });
    assertWorkspace(workspace); preserveApproved();
    workspace.ops = workspace.ops.filter(op => op.commentId !== comment.id);
    workspace.ops.push(...result.ops);
    comment.status = result.clarification ? 'needs_clarification' : 'interpreted';
    if (result.clarification) comment.clarification = result.clarification; else delete comment.clarification;
    save(); return { ...result, comment };
  } finally { interpreting.delete(comment.id); interpretationControllers.delete(comment.id); }
}

async function prepareCommentContext(comment, workspace) {
  assertWorkspace(workspace);
  assertVisibleComment(comment);
  if (interpreting.has(comment.id)) throw fail('이 요청의 해석이나 자료 준비가 진행 중입니다. 완료 후 다시 시도해 주세요.', 409);
  const version = workspace.versions.find(item => item.id === comment.versionId && item.status === 'ready');
  if (!version) throw fail('요청을 작성한 완료 버전을 찾지 못했습니다.');
  cancelFilmstrips('요청 자료 준비를 우선 실행합니다. 완료 후 시간축 썸네일을 다시 불러와 주세요.');
  const controller = new AbortController(); interpreting.add(comment.id); interpretationControllers.set(comment.id, controller);
  let bundle, registeredIds = [];
  try {
    const mediaId = version.mediaUrl.split('/').at(-1);
    const layerContext = comment.layerChange ? { targetLayer: versionLayers(version.id).layers.find(layer => layer.id === comment.layerChange.targetLayerId), proposedOperations: workspace.ops.filter(op => op.commentId === comment.id).map(op => structuredClone(op)) } : undefined;
    bundle = await prepareRequestContextBundle(comment, { versionPath: data.files[mediaId].path, durationFrames: version.durationFrames, version, directory: join(storageRoot, 'jobs', 'context-bundles'), layerContext, attachments: workspace.attachments, files: data.files, signal: controller.signal });
    const records = {};
    for (const image of [...bundle.manifest.sceneFrames, ...bundle.manifest.attachments]) {
      const id = uid('context_file'); image.mediaUrl = `/media/${id}`;
      records[id] = { path: join(bundle.directory, image.file), mimeType: image.mimeType, name: image.file };
    }
    for (const file of bundle.manifest.files.filter(item => ['annotation', 'sheet'].includes(item.role))) records[uid('context_file')] = { path: join(bundle.directory, file.path), mimeType: file.mimeType, name: file.path };
    const manifestId = uid('context_manifest'); records[manifestId] = { path: bundle.manifestPath, mimeType: 'application/json; charset=utf-8', name: 'manifest.json' };
    await writeFile(bundle.manifestPath, JSON.stringify(bundle.manifest, null, 2));
    let archiveUrl;
    try {
      await access('/usr/bin/zip'); const archivePath = join(bundle.directory, 'context.zip');
      await run('/usr/bin/zip', ['-j', '-q', archivePath, ...Object.values(records).map(record => record.path)], { signal: controller.signal });
      const archiveId = uid('context_archive'); records[archiveId] = { path: archivePath, mimeType: 'application/zip', name: `${comment.id}-context.zip` }; archiveUrl = `/media/${archiveId}`;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    controller.signal.throwIfAborted(); assertWorkspace(workspace);
    registeredIds = Object.keys(records); Object.assign(data.files, records); save();
    process.stdout.write(`Local context bundle prepared for ${comment.id}: ${bundle.manifest.sceneFrames.length} scenes; external transmission: none\n`);
    return { manifestUrl: `/media/${manifestId}`, ...(archiveUrl ? { archiveUrl } : {}), sceneCount: bundle.manifest.sceneFrames.length, drawingSceneCount: bundle.manifest.drawingContexts.length, attachmentCount: bundle.manifest.attachments.length };
  } catch (error) { for (const id of registeredIds) delete data.files[id]; if (bundle) await rm(bundle.directory, { recursive: true, force: true }); throw error; }
  finally { interpreting.delete(comment.id); interpretationControllers.delete(comment.id); }
}

async function exportPremiere(input, workspace) {
  assertWorkspace(workspace);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => key !== 'versionId') || typeof input.versionId !== 'string') throw fail('연동 내보내기 형식이 유효하지 않습니다.');
  if (premiereExportInFlight) throw fail('Premiere 연동 자료를 준비 중입니다.', 409);
  premiereExportInFlight = true;
  let result, registeredIds = [];
  try {
    result = await preparePremiereExport(workspace, input.versionId, join(storageRoot, 'premiere-exports'));
    assertWorkspace(workspace);
    const id = uid('premiere');
    data.files[`${id}_json`] = { path: result.manifestPath, mimeType: 'application/json; charset=utf-8', name: 'premiere-feedback.json' };
    data.files[`${id}_zip`] = { path: result.archivePath, mimeType: 'application/zip', name: 'premiere-feedback.zip' };
    data.files[`${id}_plugin`] = { path: result.pluginArchivePath, mimeType: 'application/zip', name: 'premiere-panel.zip' };
    registeredIds = [`${id}_json`, `${id}_zip`, `${id}_plugin`];
    save();
    return { manifestUrl: `/media/${id}_json`, archiveUrl: `/media/${id}_zip`, pluginUrl: `/media/${id}_plugin`,
      commentCount: result.commentCount, overlayCount: result.overlayCount, unplacedCount: result.unplacedCount,
      timelineSegmentCount: result.timelineSegmentCount, skippedOverlayCount: result.skippedOverlayCount };
  } catch (error) {
    for (const id of registeredIds) delete data.files[id];
    if (result) await rm(result.directory, { recursive: true, force: true });
    throw error;
  } finally { premiereExportInFlight = false; }
}

async function exportFeedback(input, workspace) {
  assertWorkspace(workspace);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['versionId', 'commentIds'].includes(key))) throw fail('피드백 내보내기 형식이 유효하지 않습니다.');
  const { targetVersion, comments } = selectFeedbackComments(workspace, input.versionId, input.commentIds);
  const requestSnapshot = structuredClone({ ...workspace, comments, ops: workspace.ops.filter(op => comments.some(comment => comment.id === op.commentId)) });
  const fileSnapshot = { ...data.files }, snapshotSnapshot = { ...data.snapshots };
  const key = JSON.stringify({ versionId: targetVersion.id, comments, ops: workspace.ops.filter(op => comments.some(comment => comment.id === op.commentId)), projectName: workspace.project.name });
  if (feedbackExportTasks.has(key)) return feedbackExportTasks.get(key).promise;
  if (rendering || attaching || interpreting.size || feedbackExportTasks.size) throw fail('미디어 작업이나 다른 자료 내보내기가 끝난 뒤 다시 실행해 주세요.', 409);
  cancelFilmstrips('피드백 자료 준비를 우선 실행합니다. 완료 후 시간축 썸네일을 다시 불러와 주세요.');
  const controller = new AbortController();
  const promise = (async () => {
    try {
      const result = await prepareFeedbackExport({ state: requestSnapshot, targetVersionId: targetVersion.id, commentIds: comments.map(comment => comment.id), files: fileSnapshot, snapshots: snapshotSnapshot, directory: join(storageRoot, 'feedback-exports'), overviewDirectory: join(storageRoot, 'overviews'), signal: controller.signal });
      controller.signal.throwIfAborted(); assertWorkspace(workspace);
      const records = {}, prefix = `feedback_${result.manifest.cacheKey}`;
      records[`${prefix}_manifest`] = { path: result.manifestPath, mimeType: 'application/json; charset=utf-8', name: 'manifest.json' };
      records[`${prefix}_markdown`] = { path: result.markdownPath, mimeType: 'text/markdown; charset=utf-8', name: 'feedback.md' };
      records[`${prefix}_jsonl`] = { path: result.jsonlPath, mimeType: 'application/x-ndjson; charset=utf-8', name: 'feedback.jsonl' };
      records[`${prefix}_vtt`] = { path: result.vttPath, mimeType: 'text/vtt; charset=utf-8', name: 'feedback.vtt' };
      records[`${prefix}_archive`] = { path: result.archivePath, mimeType: 'application/zip', name: `${workspace.project.name}-feedback.zip` };
      Object.assign(data.files, records); save();
      return { manifestUrl: `/media/${prefix}_manifest`, markdownUrl: `/media/${prefix}_markdown`, jsonlUrl: `/media/${prefix}_jsonl`, vttUrl: `/media/${prefix}_vtt`, archiveUrl: `/media/${prefix}_archive`, commentCount: result.commentCount, sceneCount: result.sceneCount };
    } finally { feedbackExportTasks.delete(key); }
  })();
  feedbackExportTasks.set(key, { promise, controller });
  return promise;
}

/** Explicit, local-only speech-to-text for one voice memo. Saving or exporting never starts this. */
async function transcribeAttachment(id, workspace) {
  assertWorkspace(workspace);
  const attachment = workspace.attachments.find(item => item.id === id);
  if (!attachment) throw fail('첨부 자료를 찾지 못했습니다.', 404);
  if (attachment.role !== 'voice') throw fail('음성 메모만 받아쓸 수 있습니다.', 409);
  const config = transcriptionConfig();
  if (!config) throw fail('로컬 받아쓰기가 설정되지 않았습니다. WHISPER_CPP_PATH와 WHISPER_MODEL_PATH를 설정해 주세요.', 409);
  if (transcriptionControllers.has(id)) throw fail('이 음성을 이미 받아쓰는 중입니다.', 409);
  const audioPath = data.files[id]?.path; if (!audioPath) throw fail('음성 파일을 찾지 못했습니다.', 404);
  const controller = new AbortController(); transcriptionControllers.set(id, controller);
  try {
    const transcript = await transcribeVoice({ audioPath, directory: join(storageRoot, 'jobs'), config, signal: controller.signal });
    assertWorkspace(workspace);
    attachment.transcript = transcript; save();
    process.stdout.write(`Local transcription prepared for ${id}: ${transcript.segments.length} segments; external transmission: none\n`);
    return attachment;
  } finally { transcriptionControllers.delete(id); }
}

function cancelFilmstrips(message) {
  for (const item of filmstripTasks.values()) item.controller.abort(fail(message, 409));
}

async function versionFilmstrip(versionId) {
  requireProject(); const workspace = data.state;
  const version = workspace.versions.find(item => item.id === versionId);
  if (!version) throw fail('현재 프로젝트에서 썸네일을 만들 버전을 찾지 못했습니다.', 404);
  if (version.status !== 'ready') throw fail('완료된 버전의 시간축 썸네일만 열 수 있습니다.', 409);
  const mediaId = version.mediaUrl.split('/').at(-1), videoPath = data.files[mediaId]?.path;
  if (!videoPath) throw fail('이 버전의 영상 파일을 찾지 못했습니다.', 404);
  const options = { versionId, videoPath, durationFrames: version.durationFrames, directory: join(storageRoot, 'filmstrips') };
  const publish = result => {
    assertWorkspace(workspace);
    const id = `filmstrip_${result.cacheKey}`;
    if (!data.files[id]) { data.files[id] = { path: result.imagePath, mimeType: 'image/png', name: `${version.id}-filmstrip.png` }; save(); }
    return { versionId, durationFrames: version.durationFrames, fps: 30, imageUrl: `/media/${id}`, cellWidth: result.cellWidth, cellHeight: result.cellHeight, frames: result.frames };
  };
  const hit = await readFilmstripCache(options);
  assertWorkspace(workspace);
  if (hit) return publish(hit);
  if (filmstripTasks.has(versionId)) return filmstripTasks.get(versionId).promise;
  if (rendering || attaching || interpreting.size || feedbackExportTasks.size) throw fail('미디어 작업이 끝나면 시간축 썸네일을 다시 불러와 주세요.', 409);
  if (filmstripTasks.size >= 4) throw fail('다른 버전의 시간축 썸네일을 준비 중입니다. 잠시 후 다시 불러와 주세요.', 429);
  const controller = new AbortController(), previous = filmstripTail;
  const promise = (async () => {
    try {
      await previous.catch(() => {});
      controller.signal.throwIfAborted(); assertWorkspace(workspace);
      if (rendering || attaching || interpreting.size || feedbackExportTasks.size) throw fail('미디어 작업이 끝나면 시간축 썸네일을 다시 불러와 주세요.', 409);
      const result = await prepareFilmstrip({ ...options, signal: controller.signal });
      controller.signal.throwIfAborted();
      const manifest = publish(result);
      if (!result.cacheHit) process.stdout.write(`Filmstrip prepared for ${versionId}: ${result.frames.length} frames; native passes: ${result.diagnostics.decodePasses}\n`);
      return manifest;
    } catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
    finally { filmstripTasks.delete(versionId); }
  })();
  filmstripTasks.set(versionId, { promise, controller }); filmstripTail = promise.catch(() => {});
  return promise;
}

async function seedSampleComments() {
  const versionId = data.state.project.activeVersionId, max = data.state.asset.durationFrames;
  if (max < 360) return;
  const speed = createComment({ versionId, frameIn: 150, frameOut: 270, text: '이 구간 2배속으로 빠르게 넘겨줘' });
  const subtitle = createComment({ versionId, frameIn: 270, frameOut: 360, text: '자막: 배움이 이어지는 순간' });
  await interpretComment(speed); await interpretComment(subtitle);
}

async function executeJob(job, version, snapshot, selected, controller) {
  rendering = true; job.status = 'running'; save();
  let lastProgress = 0;
  const outputPath = join(storageRoot, 'media', `${version.id}.mp4`), thumbnailPath = join(storageRoot, 'media', `${version.id}_thumb.jpg`);
  try {
    const result = await renderVideo({ asset: data.state.asset, sourcePath: data.files[data.state.asset.id].sourcePath, ops: snapshot, outputPath, thumbnailPath, workingDirectory: join(storageRoot, 'jobs', job.id), files: data.files, signal: controller.signal, onProgress: progress => { if (progress - lastProgress >= 0.025) { lastProgress = progress; job.progress = Math.round(progress * 100); save(); } } });
    controller.signal.throwIfAborted();
    Object.assign(version, { timelineMap: result.timelineMap, durationFrames: result.durationFrames, status: 'ready' });
    data.files[version.id] = { path: outputPath, mimeType: 'video/mp4', name: `${data.state.project.name}_v${version.number}.mp4` };
    data.files[`${version.id}_thumb`] = { path: thumbnailPath, mimeType: 'image/jpeg', name: 'thumbnail.jpg' };
    for (const op of selected) { op.status = 'applied'; const comment = data.state.comments.find(c => c.id === op.commentId); if (comment) comment.status = 'applied'; }
    job.status = 'completed'; job.progress = 100; job.completedAt = now();
  } catch (error) {
    let cleanupError;
    try { await Promise.all([rm(outputPath, { force: true }), rm(thumbnailPath, { force: true })]); } catch (failure) { cleanupError = failure.message; }
    // Publish completion only after incomplete output cleanup, so callers can immediately retry.
    job.status = controller.signal.aborted ? 'canceled' : 'failed'; job.error = controller.signal.aborted ? '사용자가 렌더를 취소했습니다.' : error.message;
    if (cleanupError) job.error += ` 임시 출력 파일 정리 실패: ${cleanupError}`;
    job.completedAt = now(); version.status = 'failed';
  }
  finally { jobControllers.delete(job.id); rendering = false; save(); }
}

function createRender(input) {
  requireProject();
  if (rendering || importing || feedbackExportTasks.size) throw fail('현재 미디어 작업이 진행 중입니다. 완료 후 다시 실행해 주세요.', 409);
  const parent = data.state.versions.find(v => v.id === input.parentVersionId && v.status === 'ready');
  if (!parent) throw fail('기준 버전을 찾지 못했습니다.');
  if (!Array.isArray(input.opIds) || !input.opIds.length || new Set(input.opIds).size !== input.opIds.length) throw fail('승인한 편집 요청을 선택해 주세요.');
  const selected = input.opIds.map(id => data.state.ops.find(op => op.id === id));
  if (selected.some(op => !op || op.versionId !== parent.id || op.status !== 'approved' || !data.state.comments.some(comment => comment.id === op.commentId && !comment.deletedAt))) throw fail('현재 버전에서 승인한 요청만 실행할 수 있습니다.');
  if (selected.some(op => op.type === 'note')) throw fail('메모는 렌더에 포함할 수 없습니다. 실행할 편집 요청만 선택해 주세요.', 409);
  const { snapshot, timelineMap } = validateRenderSelection(data.state.asset.durationFrames, data.snapshots[parent.id] || [], selected);
  for (const op of snapshot.filter(op => op.type === 'overlay' && op.params.kind === 'drawing')) {
    const comment = data.state.comments.find(item => item.id === op.commentId), authored = data.state.versions.find(item => item.id === op.versionId);
    const drawings = validateDrawings(op.params.drawings, { durationFrames: authored?.durationFrames });
    if (groupDrawings(drawings, comment?.contextFrame ?? comment?.frameIn ?? op.frameIn).length > 1) throw fail('여러 장면의 그림은 함께 삽입할 수 없습니다. 한 장면의 그림을 새 요청에 복사해 삽입해 주세요.', 409);
  }
  cancelFilmstrips('렌더를 우선 실행합니다. 완료 후 시간축 썸네일을 다시 불러와 주세요.');
  const versionId = uid('version');
  const version = { id: versionId, assetId: data.state.asset.id, number: Math.max(...data.state.versions.map(v => v.number)) + 1, parentVersionId: parent.id, durationFrames: timelineMap.at(-1).outputOut, mediaUrl: `/media/${versionId}`, thumbnailUrl: `/media/${versionId}_thumb`, opIds: snapshot.map(op => op.id), appliedOpIds: selected.map(op => op.id), timelineMap, createdAt: now(), status: 'rendering', label: `수정 ${data.state.versions.length}` };
  const job = { id: uid('job'), versionId, status: 'queued', progress: 0, createdAt: now() };
  data.state.versions.push(version); data.state.jobs.push(job); data.snapshots[versionId] = snapshot; save();
  const controller = new AbortController(); jobControllers.set(job.id, controller);
  const task = executeJob(job, version, snapshot, selected, controller); renderTasks.set(job.id, task);
  void task.finally(() => renderTasks.delete(job.id)).catch(() => {});
  return job;
}

async function streamFile(req, res, file, url) {
  const metadata = await stat(file.path), size = metadata.size;
  const headers = { 'content-type': file.mimeType, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600' };
  if (url.searchParams.get('download') === '1') headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(file.name || 'export.mp4')}`;
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const match = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (start > end || start >= size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
    status = 206; headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['content-length'] = end - start + 1; res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(file.path, { start, end }); req.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res);
}

function authorize(req) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `127.0.0.1:${devPort}`, `localhost:${devPort}`]);
  if (!allowedHosts.has(req.headers.host)) throw fail('허용하지 않는 호스트입니다.', 403);
  const origin = req.headers.origin;
  const allowedOrigins = new Set([...allowedHosts].map(host => `http://${host}`));
  if (origin && !allowedOrigins.has(origin)) throw fail('다른 사이트에서 앱에 접근할 수 없습니다.', 403);
  if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('다른 사이트에서 앱에 접근할 수 없습니다.', 403);
}

async function handleRequest(req, res) {
  try {
    if (shuttingDown) throw fail('앱을 종료하는 중입니다.', 503);
    authorize(req);
    const url = new URL(req.url, `http://127.0.0.1:${port}`), path = url.pathname;
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, publicState());
    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, fps: 30, interpreter: interpreterMode() });
    if (req.method === 'PATCH' && path === '/api/project') {
      const { input, workspace } = await projectBody(req);
      assertWorkspace(workspace);
      if (!workspace.versions.some(v => v.id === input.activeVersionId && v.status === 'ready')) throw fail('완료된 버전만 열 수 있습니다.');
      workspace.project.activeVersionId = input.activeVersionId; save(); return json(res, 200, workspace.project);
    }
    if (req.method === 'POST' && path === '/api/feedback-exports') { const { input, workspace } = await projectBody(req); return json(res, 200, await exportFeedback(input, workspace)); }
    if (req.method === 'POST' && path === '/api/premiere-exports') { const { input, workspace } = await projectBody(req); return json(res, 200, await exportPremiere(input, workspace)); }
    const filmstripMatch = path.match(/^\/api\/versions\/([\w-]+)\/filmstrip$/);
    if (req.method === 'GET' && filmstripMatch) return json(res, 200, await versionFilmstrip(filmstripMatch[1]));
    const layersMatch = path.match(/^\/api\/versions\/([\w-]+)\/layers$/);
    if (req.method === 'GET' && layersMatch) return json(res, 200, { layers: versionLayers(layersMatch[1]).layers });
    const layerChangeMatch = path.match(/^\/api\/versions\/([\w-]+)\/layers\/([\w-]+)\/changes$/);
    if (req.method === 'POST' && layerChangeMatch) {
      const { input, workspace } = await projectBody(req); assertWorkspace(workspace);
      return json(res, 201, createLayerChange(layerChangeMatch[1], layerChangeMatch[2], input));
    }
    if (req.method === 'POST' && path === '/api/assets') {
      if (importing || rendering || attaching || interpreting.size || feedbackExportTasks.size || transcriptionControllers.size) throw fail('미디어 업로드·해석·렌더·받아쓰기가 끝난 후 새 영상을 열어 주세요.', 409);
      const name = safeName(req); if (!/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(name)) throw fail('MP4, MOV, M4V, WebM, MKV, AVI 영상을 지원합니다.');
      const sourcePath = join(storageRoot, 'media', `${uid('source')}${extname(name).toLowerCase()}`);
      importing = true; cancelFilmstrips('새 영상 열기를 우선 실행합니다. 현재 영상에서 썸네일을 다시 불러와 주세요.');
      try { await receiveFile(req, sourcePath, 2_000_000_000); return json(res, 201, await importAsset(sourcePath, name)); }
      catch (error) { await rm(sourcePath, { force: true }); throw error; }
      finally { importing = false; }
    }
    if (req.method === 'POST' && path === '/api/attachments') {
      requireProject();
      const workspace = data.state;
      const name = safeName(req), role = req.headers['x-asset-role'];
      if (!['reference', 'insert', 'voice'].includes(role)) throw fail('첨부 용도를 reference, insert, voice 중에서 지정해 주세요.');
      const attachmentId = uid('attachment'), uploadPath = join(storageRoot, 'media', `${attachmentId}-upload${extname(name).slice(0, 12)}`);
      let normalizedPath;
      attaching++; cancelFilmstrips('첨부 자료 준비를 우선 실행합니다. 완료 후 시간축 썸네일을 다시 불러와 주세요.');
      try {
        await receiveFile(req, uploadPath, role === 'voice' ? VOICE_MAX_BYTES : 50_000_000);
        let path = uploadPath, mimeType;
        if (role === 'voice') {
          const info = await probe(uploadPath); if (!info.streams.some(s => s.codec_type === 'audio')) throw fail('재생 가능한 음성 파일이 필요합니다.');
          if (Number(info.format.duration) > VOICE_MAX_SECONDS) throw fail('음성 메모는 10분 이하여야 합니다.');
          path = normalizedPath = join(storageRoot, 'media', `${attachmentId}.m4a`); await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', uploadPath, '-vn', '-c:a', 'aac', '-ar', '48000', path]); mimeType = 'audio/mp4';
        } else {
          const sharp = (await import('sharp')).default;
          const image = sharp(uploadPath, { limitInputPixels: 40_000_000 }); const metadata = await image.metadata();
          if (!['jpeg', 'png', 'webp', 'gif', 'heif', 'avif'].includes(metadata.format)) throw fail('PNG, JPEG, WebP, GIF, HEIF, AVIF 이미지를 지원합니다.');
          path = normalizedPath = join(storageRoot, 'media', `${attachmentId}.png`); await image.rotate().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).png().toFile(path); mimeType = 'image/png';
        }
        assertWorkspace(workspace);
        data.files[attachmentId] = { path, originalPath: uploadPath, normalizedPath: role === 'voice' ? undefined : path, mimeType, name };
        const attachment = { id: attachmentId, name, role, mimeType, mediaUrl: `/media/${attachmentId}`, createdAt: now() }; workspace.attachments.push(attachment); save();
        return json(res, 201, attachment);
      } catch (error) { await Promise.all([rm(uploadPath, { force: true }), ...(normalizedPath ? [rm(normalizedPath, { force: true })] : [])]); throw error; }
      finally { attaching--; }
    }
    if (req.method === 'POST' && path === '/api/markers') { const { input, workspace } = await projectBody(req); return json(res, 201, createMarker(input, workspace)); }
    const markerMatch = path.match(/^\/api\/markers\/([\w-]+)$/);
    if (req.method === 'DELETE' && markerMatch) {
      requireProject(); const workspace = data.state;
      const markers = workspace.markers ?? [], index = markers.findIndex(item => item.id === markerMatch[1]);
      if (index < 0) throw fail('마커를 찾지 못했습니다.', 404);
      const [removed] = markers.splice(index, 1); save(); return json(res, 200, removed);
    }
    const transcribeMatch = path.match(/^\/api\/attachments\/([\w-]+)\/transcribe$/);
    if (req.method === 'POST' && transcribeMatch) {
      const { input, workspace } = await projectBody(req);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw fail('받아쓰기에는 추가 값이 필요하지 않습니다.');
      return json(res, 200, await transcribeAttachment(transcribeMatch[1], workspace));
    }
    if (req.method === 'POST' && path === '/api/comments') { const { input, workspace } = await projectBody(req); assertWorkspace(workspace); return json(res, 201, createComment(input)); }
    const commentMatch = path.match(/^\/api\/comments\/([\w-]+)$/);
    if (req.method === 'PATCH' && commentMatch) {
      const { input, workspace } = await projectBody(req);
      const comment = workspace.comments.find(item => item.id === commentMatch[1]); if (!comment) throw fail('피드백을 찾지 못했습니다.', 404);
      return json(res, 200, editComment(comment, input, workspace));
    }
    if (req.method === 'DELETE' && commentMatch) {
      requireProject(); const workspace = data.state;
      const comment = workspace.comments.find(item => item.id === commentMatch[1]); if (!comment) throw fail('피드백을 찾지 못했습니다.', 404);
      return json(res, 200, deleteComment(comment, workspace));
    }
    const restoreMatch = path.match(/^\/api\/comments\/([\w-]+)\/restore$/);
    if (req.method === 'POST' && restoreMatch) {
      const { input, workspace } = await projectBody(req);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw fail('피드백 복원에는 추가 값이 필요하지 않습니다.');
      const comment = workspace.comments.find(item => item.id === restoreMatch[1]); if (!comment) throw fail('피드백을 찾지 못했습니다.', 404);
      return json(res, 200, restoreComment(comment, workspace));
    }
    const supplementMatch = path.match(/^\/api\/comments\/([\w-]+)\/supplements$/);
    if (req.method === 'POST' && supplementMatch) {
      const { input, workspace } = await projectBody(req);
      const comment = workspace.comments.find(item => item.id === supplementMatch[1]); if (!comment) throw fail('요청을 찾지 못했습니다.', 404);
      return json(res, 200, appendCommentSupplement(comment, input, workspace));
    }
    const contextMatch = path.match(/^\/api\/comments\/([\w-]+)\/context-bundle$/);
    if (req.method === 'POST' && contextMatch) {
      const { workspace } = await projectBody(req);
      const comment = workspace.comments.find(item => item.id === contextMatch[1]); if (!comment) throw fail('요청을 찾지 못했습니다.', 404);
      return json(res, 200, await prepareCommentContext(comment, workspace));
    }
    const interpretMatch = path.match(/^\/api\/comments\/([\w-]+)\/interpret$/);
    if (req.method === 'POST' && interpretMatch) {
      const { workspace } = await projectBody(req); assertWorkspace(workspace);
      const comment = workspace.comments.find(c => c.id === interpretMatch[1]); if (!comment) throw fail('요청을 찾지 못했습니다.', 404);
      return json(res, 200, await interpretComment(comment, workspace));
    }
    const opMatch = path.match(/^\/api\/ops\/([\w-]+)$/);
    if (req.method === 'PATCH' && opMatch) {
      const { input, workspace } = await projectBody(req); assertWorkspace(workspace);
      const op = workspace.ops.find(o => o.id === opMatch[1]); if (!op) throw fail('편집 제안을 찾지 못했습니다.', 404);
      const owner = workspace.comments.find(comment => comment.id === op.commentId);
      if (!owner || owner.deletedAt) throw fail('삭제한 피드백의 편집 제안은 변경할 수 없습니다.', 404);
      if (!['approved', 'rejected', 'proposed'].includes(input.status)) throw fail('제안, 승인 또는 반려 상태가 필요합니다.');
      if (op.status === 'applied') throw fail('이미 적용한 요청은 수정할 수 없습니다. 이전 버전을 열어 새 요청을 남겨 주세요.', 409);
      if (data.state.jobs.some(job => ['queued', 'running'].includes(job.status) && (data.state.versions.find(version => version.id === job.versionId)?.appliedOpIds?.includes(op.id) || data.snapshots[job.versionId]?.some(item => item.id === op.id)))) throw fail('렌더 중인 요청은 수정할 수 없습니다.', 409);
      if (op.layerChange && interpreting.has(op.commentId)) throw fail('이 요청의 로컬 자료를 준비 중입니다. 완료 후 수정해 주세요.', 409);
      if (op.layerChange?.action === 'remove' && (input.params !== undefined || input.region !== undefined)) throw fail('제거 요청에는 편집 값을 지정할 수 없습니다.', 409);
      if (Object.keys(input).some(key => !['status', 'params', 'region'].includes(key))) throw fail('지원하지 않는 편집 필드입니다.');
      const params = input.params === undefined ? op.params : validateOpParameters(op, input.params);
      const region = input.region === undefined ? op.region : validateOpRegion(op, input.region);
      const status = input.params !== undefined || input.region !== undefined ? 'proposed' : input.status;
      // Commit only after every supplied field passes validation; failed edits retain prior approval.
      Object.assign(op, { params, status, ...(region ? { region } : {}) });
      const comment = workspace.comments.find(c => c.id === op.commentId); if (comment) comment.status = op.status === 'approved' ? 'approved' : 'interpreted';
      save(); return json(res, 200, op);
    }
    if (req.method === 'POST' && path === '/api/render') { const { input, workspace } = await projectBody(req); assertWorkspace(workspace); return json(res, 202, createRender(input)); }
    const cancelMatch = path.match(/^\/api\/jobs\/([\w-]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const { workspace } = await projectBody(req); assertWorkspace(workspace);
      const job = workspace.jobs.find(item => item.id === cancelMatch[1]);
      if (!job) throw fail('렌더 작업을 찾지 못했습니다.', 404);
      const controller = jobControllers.get(job.id);
      if (!['queued', 'running'].includes(job.status) || !controller || controller.signal.aborted) throw fail('진행 중인 렌더만 취소할 수 있습니다.', 409);
      job.cancelRequested = true; controller.abort(new DOMException('사용자가 렌더를 취소했습니다.', 'AbortError')); save();
      return json(res, 202, job);
    }
    const jobMatch = path.match(/^\/api\/jobs\/([\w-]+)$/);
    if (req.method === 'GET' && jobMatch) { const job = data.state?.jobs.find(j => j.id === jobMatch[1]); if (!job) throw fail('렌더 작업을 찾지 못했습니다.', 404); return json(res, 200, job); }
    const mediaMatch = path.match(/^\/media\/([\w-]+)$/);
    if (['GET', 'HEAD'].includes(req.method) && mediaMatch) { const file = data.files[mediaMatch[1]]; if (!file?.path) throw fail('미디어를 찾지 못했습니다.', 404); return await streamFile(req, res, file, url); }
    if (req.method === 'GET' && !path.startsWith('/api') && !path.startsWith('/media')) {
      const dist = join(root, 'dist'); let target = resolve(dist, `.${path}`);
      if (!target.startsWith(`${dist}/`) && target !== dist) throw fail('파일을 찾지 못했습니다.', 404);
      try { if ((await stat(target)).isDirectory()) target = join(target, 'index.html'); await access(target); } catch { target = join(dist, 'index.html'); }
      try { const content = await readFile(target); const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }[extname(target)] || 'application/octet-stream';
        // Vite names /assets/ files by content hash; fonts change only with a release. The page itself always revalidates.
        const cache = target.startsWith(join(dist, 'assets/')) ? 'public, max-age=31536000, immutable' : target.startsWith(join(dist, 'fonts/')) ? 'public, max-age=604800' : 'no-cache';
        res.writeHead(200, { 'content-type': mime, 'cache-control': cache, 'x-content-type-options': 'nosniff' }); return res.end(content); } catch { throw fail('개발 화면은 http://localhost:4317 에서 열어 주세요.', 404); }
    }
    throw fail('경로를 찾지 못했습니다.', 404);
  } catch (error) { if (!res.headersSent && !res.destroyed) json(res, error.status || 400, { error: error.message }); }
}

const server = http.createServer((req, res) => {
  const task = handleRequest(req, res); requestTasks.add(task);
  void task.finally(() => requestTasks.delete(task)).catch(() => {});
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server.listening) server.close();
  server.closeAllConnections();
  const reason = new DOMException('앱 종료로 작업을 중단했습니다.', 'AbortError');
  cancelFilmstrips('앱을 종료하는 중입니다.');
  for (const item of feedbackExportTasks.values()) item.controller.abort(reason);
  for (const controller of interpretationControllers.values()) controller.abort(reason);
  for (const controller of transcriptionControllers.values()) controller.abort(reason);
  for (const [id, controller] of jobControllers) {
    const job = data.state?.jobs.find(item => item.id === id); if (job) job.cancelRequested = true;
    controller.abort(reason);
  }
  let timer;
  const bounded = new Promise(resolve => { timer = setTimeout(resolve, 3000); });
  const drained = (async () => {
    await shutdownMediaProcesses();
    await Promise.allSettled([...requestTasks, ...renderTasks.values(), ...initializationTasks, ...[...filmstripTasks.values()].map(item => item.promise), ...[...feedbackExportTasks.values()].map(item => item.promise)]);
  })();
  await Promise.race([drained, bounded]); clearTimeout(timer);
  store.close(); process.exit(0);
}

// Register before optional sample ingest, so quitting during startup also stops native children.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(); });

if (!data.state) {
  const startup = (async () => {
    try {
      await access(samplePath);
      const copied = join(storageRoot, 'media', `${uid('source')}.mp4`); await copyFile(samplePath, copied);
      await importAsset(copied, '인터랙티브 수업.mp4'); await seedSampleComments();
    } catch (error) {
      if (error.code !== 'ENOENT' && !shuttingDown) process.stderr.write(`샘플을 준비하지 못했습니다. 영상 열기를 사용할 수 있습니다: ${error.message}\n`);
    }
  })();
  initializationTasks.add(startup);
  try { await startup; } finally { initializationTasks.delete(startup); }
}

if (!shuttingDown) server.listen(port, '127.0.0.1', () => process.stdout.write(`Video Interference worker ready: http://127.0.0.1:${port}\n`));
