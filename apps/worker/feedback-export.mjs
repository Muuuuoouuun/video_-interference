import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, stat, rename, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { ffmpegPath, run } from './engine.mjs';
import { planCanonicalFrameDecode } from './canonical-frames.mjs';
import { planRequestContextFrames } from './context-bundle.mjs';
import { drawingsSvg } from './drawings.mjs';
import { projectComment } from '../../packages/core/comment-projection.mjs';
import { projectDrawings, groupDrawings } from '../../packages/core/drawing-anchors.mjs';
import { feedbackCategory, FEEDBACK_CATEGORY_LABELS } from '../../packages/core/feedback-category.mjs';
import { isVisualOp, visualLayerId } from '../../packages/core/layer-snapshot.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const abort = signal => signal?.throwIfAborted();
const clock = frame => { const milliseconds = Math.round(frame / 30 * 1000); return `${String(Math.floor(milliseconds / 60000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`; };
const quote = text => (String(text).split('\n').map(line => `> ${line}`).join('\n'));
const rangesText = ranges => ranges.length ? ranges.map(range => range.frameOut - range.frameIn === 1 ? clock(range.frameIn) : `${clock(range.frameIn)}–${clock(range.frameOut)}`).join(', ') : '현재 영상에 표시할 구간 없음';

export function selectFeedbackComments(state, targetVersionId, commentIds) {
  if (!state?.project || !Array.isArray(state.versions) || !Array.isArray(state.comments)) throw fail('피드백을 내보낼 프로젝트를 찾지 못했습니다.', 409);
  const targetVersion = state.versions.find(version => version.id === targetVersionId);
  if (!targetVersion) throw fail('현재 프로젝트에서 기준 버전을 찾지 못했습니다.', 404);
  if (targetVersion.status !== 'ready') throw fail('완료된 버전을 기준으로 피드백을 내보내 주세요.', 409);
  if (commentIds !== undefined && (!Array.isArray(commentIds) || !commentIds.length || commentIds.some(id => typeof id !== 'string') || new Set(commentIds).size !== commentIds.length)) throw fail('내보낼 피드백 ID는 중복 없는 목록으로 지정해 주세요.');
  const visible = state.comments.filter(comment => !comment.deletedAt);
  const comments = commentIds === undefined ? visible : commentIds.map(id => visible.find(comment => comment.id === id));
  if (comments.some(comment => !comment)) throw fail('현재 프로젝트에서 선택한 피드백을 찾지 못했습니다.', 404);
  if (!comments.length) throw fail('먼저 시간에 연결된 피드백이나 메모를 저장해 주세요.', 409);
  if (comments.length > 300) throw fail('한 번에 최대 300개 피드백을 내보낼 수 있습니다. 일부를 선택해 나누어 내보내 주세요. 자료는 생략하지 않았습니다.', 413);
  return { targetVersion, comments: comments.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) };
}

function missingSourceRanges(ranges, timelineMap) {
  const missing = [];
  for (const range of ranges) {
    let cursor = range.frameIn;
    for (const segment of timelineMap) {
      if (segment.sourceOut <= cursor || segment.sourceIn >= range.frameOut) continue;
      if (segment.sourceIn > cursor) missing.push({ frameIn: cursor, frameOut: Math.min(segment.sourceIn, range.frameOut) });
      cursor = Math.max(cursor, Math.min(segment.sourceOut, range.frameOut));
    }
    if (cursor < range.frameOut) missing.push({ frameIn: cursor, frameOut: range.frameOut });
  }
  return missing;
}

const tableText = (text, limit = 120) => {
  const plain = String(text).replace(/\s+/g, ' ').trim(), excerpt = plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
  return excerpt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/([\[\]])/g, '\\$1');
};

export function renderFeedbackMarkdown(manifest) {
  const statusLabel = { present: '현재 버전에 남아 있음', partial: '일부 구간만 현재 버전에 남아 있음', deleted: '현재 버전에서 삭제된 구간', unavailable: '현재 위치를 확정할 수 없음' };
  const summaryTime = entry => entry.current.ranges.length ? `${rangesText(entry.current.ranges)}${entry.current.status === 'partial' ? ' · 일부 삭제' : ''}` : `작성 v${entry.authored.versionNumber} ${rangesText([entry.authored])} · ${entry.current.status === 'deleted' ? '현재 삭제' : '현재 위치 확인 필요'}`;
  const representative = entry => entry.scenes.find(scene => scene.frame === entry.authored.contextFrame) ?? entry.scenes[0];
  const lines = ['# 시간별 영상 피드백', '', `프로젝트: ${manifest.project.name}`, `기준: v${manifest.targetVersion.number} · ${manifest.targetVersion.label}`, '', '| 시간 | 장면 내용 | 피드백 요약 | 자료 |', '| --- | --- | --- | --- |'];
  for (let index = 0; index < manifest.feedback.length; index++) {
    const entry = manifest.feedback[index], still = representative(entry), annotated = entry.scenes.find(scene => scene.annotatedFile);
    const links = [...(still ? [`[스틸](${still.file})`] : []), ...(annotated ? [`[그림](${annotated.annotatedFile})`] : []), ...(entry.attachments.length ? [`[첨부 ${entry.attachments.length}개](#feedback-${index + 1}-materials)`] : [])];
    const summary = `${entry.kind === 'note' ? '메모 · ' : ''}${entry.feedback.original || (entry.scenes.some(scene => scene.annotatedFile) || entry.attachments.length ? '그림·첨부 확인' : '장면 기록')}`;
    const supplements = entry.feedback.supplements.length ? ` · 보완 ${entry.feedback.supplements.length}개` : '';
    lines.push(`| [${index + 1}. ${summaryTime(entry)}](#feedback-${index + 1}) | ${tableText(entry.sceneDescription.text || '스틸 참고', 90)} | ${tableText(summary)}${supplements} | ${links.join(' · ') || '아래 내용'} |`);
  }
  lines.push('', '검토 가능한 시간별 피드백 브리프입니다. 장면 설명은 사용자 기록이며 자동 영상 분석 결과가 아닙니다.', '이 자료는 로컬에서 만들었으며 원본·편집 영상 파일은 포함하지 않았습니다. 외부 전송·AI 해석·음성 전사는 실행하지 않았습니다.', '메모는 문맥 자료입니다. 삭제된 장면은 작성 당시 자료로 확인하고, 불분명한 요청은 확인 항목으로 남겨 주세요.', '');
  for (let index = 0; index < manifest.feedback.length; index++) {
    const entry = manifest.feedback[index], still = representative(entry);
    lines.push(`<a id="feedback-${index + 1}"></a>`, '', `## ${index + 1}. ${entry.kind === 'note' ? '메모' : '피드백'} · ${summaryTime(entry)}`, '', `작성 v${entry.authored.versionNumber}: ${rangesText([entry.authored])}`, `현재 v${manifest.targetVersion.number}: ${rangesText(entry.current.ranges)}`);
    if (entry.current.status !== 'present') lines.push(`상태: ${statusLabel[entry.current.status]}`);
    lines.push(`분야: ${FEEDBACK_CATEGORY_LABELS[entry.category] ?? (entry.kind === 'note' ? '메모' : '영상')}`);
    lines.push('', '### 장면 내용', '', entry.sceneDescription.text ? quote(entry.sceneDescription.text) : '별도 장면 설명 없음 · 아래 스틸 참고', '', '### 피드백', '', entry.feedback.original ? quote(entry.feedback.original) : '문자 피드백 없음 · 그림이나 첨부 자료 참고', '');
    for (let supplementIndex = 0; supplementIndex < entry.feedback.supplements.length; supplementIndex++) {
      const supplement = entry.feedback.supplements[supplementIndex];
      lines.push(`보완 ${supplementIndex + 1}`, '', quote(supplement.text), '');
    }
    lines.push(`<a id="feedback-${index + 1}-materials"></a>`, '', '### 자료', '');
    if (still) lines.push(`작성 당시 ${clock(still.frame)}`, '', `![작성 당시 장면](${still.file})`, '');
    for (const scene of entry.scenes.filter(scene => scene.annotatedFile)) lines.push(`요청 그림 · ${clock(scene.frame)}`, '', `![요청 그림과 장면](${scene.annotatedFile})`, '');
    const otherStills = entry.scenes.filter(scene => scene !== still);
    if (otherStills.length) lines.push(`다른 시점 스틸: ${otherStills.map(scene => `[${clock(scene.frame)}](${scene.file})`).join(' · ')}`, '');
    for (const attachment of entry.attachments) lines.push(`[${attachment.role === 'voice' ? '음성 메모 · 미전사' : attachment.role === 'insert' ? '삽입용 참고 이미지' : '참고 이미지'} · ${attachment.name.replace(/[\[\]\r\n]/g, ' ')}](${attachment.file})`, '');
  }
  lines.push('---', '', `자료 생성: ${manifest.createdAt}`, '정확한 프레임·그림 좌표·작성 이력은 [manifest.json](manifest.json)에 보존했습니다. 자료 링크는 함께 받은 ZIP 안에서 열 수 있습니다.');
  return lines.join('\n');
}

async function fileIdentity(path) {
  if (!path) throw fail('내보낼 자료 파일을 찾지 못했습니다.', 404);
  try { const info = await stat(path); if (!info.isFile() || !info.size) throw fail('내보낼 자료 파일이 비어 있거나 유효하지 않습니다.', 404); return { path, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }; }
  catch (error) { if (error.code === 'ENOENT') throw fail('내보낼 자료 파일을 찾지 못했습니다. 자료는 생략하지 않았습니다.', 404); throw error; }
}

/** Portable local brief: no video asset is copied and no model/network client is used. */
export async function prepareFeedbackExport({ state, targetVersionId, commentIds, files, directory, snapshots = {}, signal }) {
  abort(signal);
  const selection = selectFeedbackComments(state, targetVersionId, commentIds), selectedIds = new Set(selection.comments.map(comment => comment.id));
  const versionIds = new Set([targetVersionId, ...selection.comments.map(comment => comment.versionId)]);
  const attachmentIds = new Set(selection.comments.flatMap(comment => [...comment.attachmentIds, ...(comment.voiceAssetId ? [comment.voiceAssetId] : [])]));
  const snapshot = structuredClone({ project: state.project, versions: state.versions.filter(version => versionIds.has(version.id)), comments: selection.comments, attachments: state.attachments.filter(attachment => attachmentIds.has(attachment.id)), ops: (state.ops || []).filter(op => selectedIds.has(op.commentId)) });
  const fileIds = new Set([...attachmentIds, ...snapshot.versions.map(version => version.mediaUrl.split('/').at(-1))]);
  const fileSnapshot = structuredClone(Object.fromEntries([...fileIds].map(id => [id, files[id]])));
  const layerSnapshots = structuredClone(Object.fromEntries(snapshot.comments.filter(comment => comment.layerChange).map(comment => [comment.versionId, snapshots[comment.versionId]])));
  const { targetVersion, comments } = selectFeedbackComments(snapshot, targetVersionId, commentIds);
  const plans = [], sourceGroups = new Map(), attachmentRecords = new Map();
  for (const comment of comments) {
    const authored = snapshot.versions.find(version => version.id === comment.versionId && version.status === 'ready');
    if (!authored || authored.assetId !== targetVersion.assetId) throw fail('피드백 작성 버전의 영상을 찾지 못했습니다. 자료는 생략하지 않았습니다.', 409);
    if (comment.sceneDescription !== undefined && (typeof comment.sceneDescription !== 'string' || comment.sceneDescription.length > 500)) throw fail('장면 설명은 500자 이하여야 합니다.');
    if (!Array.isArray(comment.attachmentIds) || comment.attachmentIds.length > 10) throw fail('한 피드백의 첨부 자료는 최대 10개여야 합니다.');
    const plan = planRequestContextFrames(comment, authored.durationFrames), projection = projectComment(comment, authored, targetVersion);
    let group = sourceGroups.get(authored.id);
    if (!group) { group = { authored, frames: new Set(), videoPath: fileSnapshot[authored.mediaUrl.split('/').at(-1)]?.path }; sourceGroups.set(authored.id, group); }
    for (const scene of plan.sceneFrames) group.frames.add(scene.frame);
    const ids = [...new Set([...comment.attachmentIds, ...(comment.voiceAssetId ? [comment.voiceAssetId] : [])])];
    for (const id of ids) {
      const attachment = snapshot.attachments.find(item => item.id === id), file = fileSnapshot[id];
      if (!attachment || !file || !['reference', 'insert', 'voice'].includes(attachment.role) || (attachment.role === 'voice' ? !attachment.mimeType.startsWith('audio/') : !attachment.mimeType.startsWith('image/'))) throw fail('피드백에 저장된 참고 자료를 찾지 못했습니다. 자료는 생략하지 않았습니다.', 404);
      attachmentRecords.set(id, { attachment, path: attachment.role === 'voice' ? file.path : file.normalizedPath });
    }
    plans.push({ comment, authored, plan, projection, ids });
  }
  if ([...sourceGroups.values()].reduce((sum, group) => sum + group.frames.size, 0) > 1200 || attachmentRecords.size > 300) throw fail('한 자료 묶음은 최대 1,200개 장면과 300개 첨부를 지원합니다. 피드백을 나누어 선택해 주세요. 자료는 생략하지 않았습니다.', 413);
  plans.sort((a, b) => (a.projection.ranges[0]?.frameIn ?? Infinity) - (b.projection.ranges[0]?.frameIn ?? Infinity) || a.comment.createdAt.localeCompare(b.comment.createdAt) || a.comment.id.localeCompare(b.comment.id));
  const identities = [];
  for (const group of sourceGroups.values()) identities.push(await fileIdentity(group.videoPath));
  for (const record of attachmentRecords.values()) identities.push(await fileIdentity(record.path));
  const relevantOps = (snapshot.ops || []).filter(op => comments.some(comment => comment.id === op.commentId && comment.layerChange));
  const cacheKey = digest({ format: 'feedback-export-v3-categories', project: { id: snapshot.project.id, name: snapshot.project.name }, targetVersion, comments, authoredVersions: [...sourceGroups.values()].map(group => group.authored), identities, relevantOps, layers: comments.filter(comment => comment.layerChange).map(comment => layerSnapshots[comment.versionId]) });
  const finalDirectory = join(directory, cacheKey), manifestPath = join(finalDirectory, 'manifest.json'), markdownPath = join(finalDirectory, 'feedback.md'), archivePath = join(finalDirectory, 'feedback.zip');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.cacheKey === cacheKey && manifest.kind === 'video-feedback-handoff' && manifest.sourceVideoIncluded === false && manifest.renderedVideoIncluded === false && Array.isArray(manifest.files) && manifest.files.every(file => /^(?:scenes\/version-\d+\/frame-\d+\.jpg|annotations\/feedback-\d+\/frame-\d+\.png|attachments\/asset-\d+\.(?:png|m4a))$/.test(file.path))) {
      await fileIdentity(markdownPath); await fileIdentity(archivePath);
      for (const file of manifest.files) if ((await stat(join(finalDirectory, file.path))).size !== file.bytes) throw new Error('cached file changed');
      abort(signal);
      return { directory: finalDirectory, manifestPath, markdownPath, archivePath, manifest, commentCount: manifest.feedback.length, sceneCount: manifest.stats.sceneCount, cacheHit: true, diagnostics: { ffmpegRuns: 0, elapsedMs: 0 } };
    }
  } catch (error) { abort(signal); if (['EACCES', 'EPERM'].includes(error.code)) throw error; }
  await mkdir(directory, { recursive: true }); const work = await mkdtemp(join(directory, '.feedback-export-')), started = performance.now();
  let completed = false, ffmpegRuns = 0;
  try {
    const assets = [], sceneFiles = new Map(), attachmentFiles = new Map();
    const inventory = async (path, mimeType, role) => { const bytes = await readFile(join(work, path)); assets.push({ path, mimeType, role, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); };
    let versionIndex = 0;
    for (const [versionId, group] of sourceGroups) {
      abort(signal); const folder = `scenes/version-${String(++versionIndex).padStart(3, '0')}`; await mkdir(join(work, folder), { recursive: true });
      const frames = [...group.frames].sort((a, b) => a - b), decode = planCanonicalFrameDecode(frames);
      await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-threads', '1', ...decode.inputArgs, '-i', group.videoPath, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', `select=${decode.select},scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`, '-fps_mode', 'vfr', '-frames:v', String(frames.length), '-q:v', '2', '-start_number', '0', '-threads', '1', join(work, folder, '%06d.jpg')], { signal, timeout: 120_000 }); ffmpegRuns++;
      const actual = (await readdir(join(work, folder))).filter(name => /^\d{6}\.jpg$/.test(name)); if (actual.length !== frames.length) throw fail('작성 버전 길이와 스틸 개수가 맞지 않습니다. 자료는 생략하지 않았습니다.', 409);
      for (let index = 0; index < frames.length; index++) {
        const file = `${folder}/frame-${String(frames[index]).padStart(6, '0')}.jpg`;
        await rename(join(work, folder, `${String(index).padStart(6, '0')}.jpg`), join(work, file)); await inventory(file, 'image/jpeg', 'scene'); sceneFiles.set(`${versionId}:${frames[index]}`, file);
      }
    }
    let attachmentIndex = 0;
    for (const [id, record] of attachmentRecords) {
      abort(signal); const voice = record.attachment.role === 'voice', file = `attachments/asset-${String(++attachmentIndex).padStart(4, '0')}${voice ? '.m4a' : '.png'}`;
      await mkdir(join(work, 'attachments'), { recursive: true }); await copyFile(record.path, join(work, file)); await inventory(file, voice ? 'audio/mp4' : 'image/png', 'attachment');
      attachmentFiles.set(id, { id, name: record.attachment.name, role: record.attachment.role, mimeType: voice ? 'audio/mp4' : 'image/png', file, ...(voice ? { automaticTranscription: false, source: 'normalized-audio-only' } : {}) });
    }
    const feedback = [];
    for (let index = 0; index < plans.length; index++) {
      abort(signal); const { comment, authored, plan, projection, ids } = plans[index], scenes = [];
      const drawingsByFrame = new Map(groupDrawings(plan.drawings, comment.contextFrame ?? comment.frameIn).map(group => [group.frame, group.drawings]));
      for (const scene of plan.sceneFrames) {
        const file = sceneFiles.get(`${authored.id}:${scene.frame}`), drawings = drawingsByFrame.get(scene.frame); let annotatedFile;
        if (drawings?.length) {
          annotatedFile = `annotations/feedback-${String(index + 1).padStart(4, '0')}/frame-${String(scene.frame).padStart(6, '0')}.png`;
          await mkdir(join(work, `annotations/feedback-${String(index + 1).padStart(4, '0')}`), { recursive: true });
          const metadata = await sharp(join(work, file)).metadata();
          await sharp(join(work, file)).composite([{ input: Buffer.from(drawingsSvg(metadata.width, metadata.height, drawings)), left: 0, top: 0 }]).png().toFile(join(work, annotatedFile)); await inventory(annotatedFile, 'image/png', 'annotation');
        }
        scenes.push({ ...scene, file, ...(annotatedFile ? { annotatedFile } : {}) });
      }
      let layerMetadata = {};
      if (comment.layerChange) {
        const target = (layerSnapshots[comment.versionId] || []).find(op => isVisualOp(op) && visualLayerId(op) === comment.layerChange.targetLayerId && op.id === comment.layerChange.targetOpId);
        if (!target) throw fail('기존 그래픽 변경 대상 기록을 찾지 못했습니다. 자료는 생략하지 않았습니다.', 409);
        layerMetadata = { layerChange: comment.layerChange, layerTarget: target, proposedOperations: relevantOps.filter(op => op.commentId === comment.id) };
      }
      feedback.push({ id: comment.id, kind: comment.kind ?? 'request', category: feedbackCategory(comment), status: comment.status, createdAt: comment.createdAt, sceneDescription: { source: comment.sceneDescription ? 'user' : 'not-provided', text: comment.sceneDescription ?? '' }, feedback: { original: comment.text, supplements: comment.supplements ?? [] }, authored: { versionId: authored.id, versionNumber: authored.number, frameIn: comment.frameIn, frameOut: comment.frameOut, contextFrame: comment.contextFrame ?? comment.frameIn, sourceRanges: comment.sourceRanges }, current: { versionId: targetVersion.id, ...projection, deletedSourceRanges: missingSourceRanges(comment.sourceRanges, targetVersion.timelineMap) }, drawings: plan.drawings, drawingProjection: projectDrawings(comment, authored, targetVersion), scenes, attachments: ids.map(id => attachmentFiles.get(id)), ...layerMetadata });
    }
    const manifest = { schemaVersion: 1, kind: 'video-feedback-handoff', cacheKey, createdAt: new Date().toISOString(), localOnly: true, modelCalled: false, networkUsed: false, sourceVideoIncluded: false, renderedVideoIncluded: false, automaticTranscription: false, frameConvention: '30fps; half-open ranges [frameIn,frameOut)', project: { id: snapshot.project.id, name: snapshot.project.name }, targetVersion: { id: targetVersion.id, number: targetVersion.number, label: targetVersion.label, durationFrames: targetVersion.durationFrames, fps: 30 }, feedback, files: assets, stats: { commentCount: feedback.length, sceneCount: sceneFiles.size, annotationCount: assets.filter(file => file.role === 'annotation').length, attachmentCount: attachmentFiles.size, authoredVersionCount: sourceGroups.size }, diagnostics: { ffmpegRuns } };
    await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2)); await writeFile(join(work, 'feedback.md'), renderFeedbackMarkdown(manifest)); abort(signal);
    // Every entry is generated locally with portable relative paths; no source/edited video is added.
    const zipList = ['feedback.md', 'manifest.json', ...assets.map(asset => asset.path)].join('\n') + '\n';
    // zip's -@ input is supplied through a tiny subprocess, without a shell or interpolated command.
    await zipFiles(work, join(work, 'feedback.zip'), zipList, signal);
    abort(signal);
    await rm(finalDirectory, { recursive: true, force: true }); await rename(work, finalDirectory); completed = true;
    return { directory: finalDirectory, manifestPath, markdownPath, archivePath, manifest, commentCount: feedback.length, sceneCount: sceneFiles.size, cacheHit: false, diagnostics: { ffmpegRuns, elapsedMs: Math.round(performance.now() - started) } };
  } finally { if (!completed) await rm(work, { recursive: true, force: true }); }
}

async function zipFiles(directory, path, list, signal) {
  // The platform utility accepts explicit generated relative entry names; cwd keeps the archive portable.
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    abort(signal); const child = spawn('/usr/bin/zip', ['-q', path, '-@'], { cwd: directory, stdio: ['pipe', 'ignore', 'pipe'] }); let stderr = '', stopped = false, timer;
    const stop = () => { stopped = true; child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 1000); timer.unref(); };
    signal?.addEventListener('abort', stop, { once: true }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); }); child.stdin.on('error', () => {});
    child.once('error', error => { signal?.removeEventListener('abort', stop); clearTimeout(timer); reject(error); });
    child.once('close', code => { signal?.removeEventListener('abort', stop); clearTimeout(timer); stopped ? reject(signal.reason) : code === 0 ? resolve() : reject(new Error(`피드백 ZIP을 만들지 못했습니다: ${stderr}`)); });
    child.stdin.end(list);
  });
}
