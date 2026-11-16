import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, stat, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { extractCanonicalFrames } from './canonical-frames.mjs';
import { mapLimit, mediaConcurrency } from './parallel.mjs';
import { writeZip } from './zip.mjs';
import { planRequestContextFrames } from './context-bundle.mjs';
import { prepareVersionOverview } from './overview.mjs';
import { HANDOFF_SCHEMA_VERSION, FRAME_CONVENTION, READING_GUIDE, clock, rangesText, inventoryFile, renderAnnotatedStill, composeSceneSheet, buildHandoffEntry, entryDigest, renderFeedbackJsonl, renderFeedbackVtt } from './handoff.mjs';
import { groupDrawings } from '../../packages/core/drawing-anchors.mjs';
import { projectComment } from '../../packages/core/comment-projection.mjs';
import { FEEDBACK_CATEGORY_LABELS } from '../../packages/core/feedback-category.mjs';
import { isVisualOp, visualLayerId } from '../../packages/core/layer-snapshot.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const abort = signal => signal?.throwIfAborted();
const quote = text => (String(text).split('\n').map(line => `> ${line}`).join('\n'));
const EXPORT_FILE = /^(?:scenes\/version-\d+\/frame-\d+\.jpg|annotations\/feedback-\d+\/frame-\d+\.jpg|sheets\/feedback-\d+\.jpg|overview\/grid\.jpg|attachments\/asset-\d+\.(?:png|m4a))$/;
const SHOT_TABLE_LIMIT = 40;
const STILL_FILTER = "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1";

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

const tableText = (text, limit = 120) => {
  const plain = String(text).replace(/\s+/g, ' ').trim(), excerpt = plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
  return excerpt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/([\[\]])/g, '\\$1');
};
const transcriptLabel = transcript => `${transcript.engine}${transcript.model ? ` · ${transcript.model}` : ''}${transcript.language ? ` · ${transcript.language}` : ''}`;

export function renderFeedbackMarkdown(manifest) {
  const statusLabel = { present: '현재 버전에 남아 있음', partial: '일부 구간만 현재 버전에 남아 있음', deleted: '현재 버전에서 삭제된 구간', unavailable: '현재 위치를 확정할 수 없음' };
  const summaryTime = entry => entry.current.ranges.length ? `${rangesText(entry.current.ranges)}${entry.current.status === 'partial' ? ' · 일부 삭제' : ''}` : `작성 v${entry.authored.versionNumber} ${rangesText([entry.authored])} · ${entry.current.status === 'deleted' ? '현재 삭제' : '현재 위치 확인 필요'}`;
  const representative = entry => entry.scenes.find(scene => scene.frame === entry.authored.contextFrame) ?? entry.scenes[0];
  const lines = ['# 시간별 영상 피드백', '', `프로젝트: ${manifest.project.name}`, `기준: v${manifest.targetVersion.number} · ${manifest.targetVersion.label}`];
  if (manifest.schemaVersion >= 2) lines.push(`AI·도구용: [feedback.jsonl](feedback.jsonl)은 한 줄에 피드백 하나를 담은 글 자료입니다. 글을 먼저 읽고, 이미지는 필요할 때 피드백별 한 장 요약 → 개별 스틸 순서로 여세요.`);
  const overview = manifest.overview;
  if (overview) {
    const shots = overview.shots.list;
    lines.push('', '## 영상 개요', '', `길이 ${clock(manifest.targetVersion.durationFrames)} · 자동 컷 감지 ${shots.length}개 구간(추정) · [전체 흐름 이미지 1장](${overview.grid.file})`, '', '| 구간 | 시간 |', '| --- | --- |');
    for (const shot of shots.slice(0, SHOT_TABLE_LIMIT)) lines.push(`| ${shot.index} | ${rangesText([shot])} |`);
    if (shots.length > SHOT_TABLE_LIMIT) lines.push('', `구간이 많아 처음 ${SHOT_TABLE_LIMIT}개만 표로 보였습니다. 전체 ${shots.length}개는 manifest.json의 overview.shots에 있습니다.`);
    lines.push('', '컷 구간은 화면 변화량으로 추정한 값입니다. 피드백 시점과 장면 내용은 사용자 기록을 따릅니다.');
  }
  lines.push('', '| 시간 | 장면 내용 | 피드백 요약 | 자료 |', '| --- | --- | --- | --- |');
  for (let index = 0; index < manifest.feedback.length; index++) {
    const entry = manifest.feedback[index], still = representative(entry), annotated = entry.scenes.find(scene => scene.annotatedFile);
    const links = [...(entry.sheet ? [`[한 장 요약](${entry.sheet.file})`] : []), ...(still ? [`[스틸](${still.file})`] : []), ...(annotated ? [`[그림](${annotated.annotatedFile})`] : []), ...(entry.attachments.length ? [`[첨부 ${entry.attachments.length}개](#feedback-${index + 1}-materials)`] : [])];
    const summary = `${entry.kind === 'note' ? '메모 · ' : ''}${entry.feedback.original || (entry.scenes.some(scene => scene.annotatedFile) || entry.attachments.length ? '그림·첨부 확인' : '장면 기록')}`;
    const supplements = entry.feedback.supplements.length ? ` · 보완 ${entry.feedback.supplements.length}개` : '';
    lines.push(`| [${index + 1}. ${summaryTime(entry)}](#feedback-${index + 1}) | ${tableText(entry.sceneDescription.text || '스틸 참고', 90)} | ${tableText(summary)}${supplements} | ${links.join(' · ') || '아래 내용'} |`);
  }
  const transcripts = manifest.feedback.flatMap(entry => entry.attachments.filter(attachment => attachment.transcript?.text)), observed = manifest.feedback.some(entry => entry.observations?.length);
  lines.push('', '검토 가능한 시간별 피드백 브리프입니다. 장면 설명은 사용자 기록이며 자동 영상 분석 결과가 아닙니다.', '이 자료는 로컬에서 만들었으며 원본·편집 영상 파일은 포함하지 않았습니다. 외부 전송·AI 해석·음성 전사는 실행하지 않았습니다.');
  if (transcripts.length) lines.push(`음성 받아쓰기 ${transcripts.length}개는 사용자가 앱에서 따로 실행한 로컬 자동 결과입니다. 원본 음성과 다를 수 있습니다.`);
  if (observed) lines.push('‘AI 관찰’은 사용자가 별도로 실행한 모델 결과를 붙인 것입니다. 사용자 기록이 아니며 원문을 대신하지 않습니다.');
  lines.push('메모는 문맥 자료입니다. 삭제된 장면은 작성 당시 자료로 확인하고, 불분명한 요청은 확인 항목으로 남겨 주세요.', '');
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
    if (entry.drawingProjection?.length) {
      lines.push('### 그림 표시', '');
      for (const drawing of entry.drawingProjection) lines.push(`- 작성 ${clock(drawing.authoredFrame ?? entry.authored.contextFrame)} · ${drawing.description}${drawing.status === 'present' ? ` · 현재 ${clock(drawing.frame)}` : drawing.status === 'deleted' ? ' · 현재 버전에서 삭제된 장면' : ' · 현재 위치 확인 필요'}`);
      lines.push('');
    }
    for (const observation of entry.observations ?? []) {
      lines.push(`### AI 관찰 · ${observation.provider} ${observation.model} (모델 결과, 사용자 기록 아님${observation.stale ? ' · 이후 피드백이 바뀌어 이전 자료 기준' : ''})`, '', quote(observation.observedScene), '', `이해한 요청: ${observation.feedbackSummary.replace(/\n/g, ' ')}`, '');
      if (observation.questions.length) lines.push(...observation.questions.map(question => `- 확인: ${question.replace(/\n/g, ' ')}`), '');
    }
    lines.push(`<a id="feedback-${index + 1}-materials"></a>`, '', '### 자료', '');
    if (entry.sheet) lines.push(`[피드백 한 장 요약](${entry.sheet.file}) · 기준 장면을 크게, 다른 시점을 아래에 모았습니다.`, '');
    if (still) lines.push(`작성 당시 ${clock(still.frame)}`, '', `![작성 당시 장면](${still.file})`, '');
    for (const scene of entry.scenes.filter(scene => scene.annotatedFile)) lines.push(`요청 그림 · ${clock(scene.frame)}`, '', `![요청 그림과 장면](${scene.annotatedFile})`, '');
    const otherStills = entry.scenes.filter(scene => scene !== still);
    if (otherStills.length) lines.push(`다른 시점 스틸: ${otherStills.map(scene => `[${clock(scene.frame)}](${scene.file})`).join(' · ')}`, '');
    for (const attachment of entry.attachments) {
      const name = attachment.name.replace(/[\[\]\r\n]/g, ' ');
      if (attachment.role === 'voice' && attachment.transcript?.text) lines.push(`[음성 메모 · 자동 받아쓰기 · ${name}](${attachment.file})`, '', quote(attachment.transcript.text), '', `받아쓰기: ${transcriptLabel(attachment.transcript)} 로컬 자동 결과 · 원본 음성과 대조 필요`, '');
      else lines.push(`[${attachment.role === 'voice' ? '음성 메모 · 미전사' : attachment.role === 'insert' ? '삽입용 참고 이미지' : '참고 이미지'} · ${name}](${attachment.file})`, '');
    }
  }
  lines.push('---', '', `자료 생성: ${manifest.createdAt}`, '정확한 프레임·그림 좌표·작성 이력은 [manifest.json](manifest.json)에 보존했습니다. 자료 링크는 함께 받은 ZIP 안에서 열 수 있습니다.');
  return lines.join('\n');
}

async function fileIdentity(path) {
  if (!path) throw fail('내보낼 자료 파일을 찾지 못했습니다.', 404);
  try { const info = await stat(path); if (!info.isFile() || !info.size) throw fail('내보낼 자료 파일이 비어 있거나 유효하지 않습니다.', 404); return { path, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }; }
  catch (error) { if (error.code === 'ENOENT') throw fail('내보낼 자료 파일을 찾지 못했습니다. 자료는 생략하지 않았습니다.', 404); throw error; }
}

const bounded = (value, limit) => typeof value === 'string' && value.length <= limit;
/** Model observations come from an explicit separate run (see scripts/test-gemini-feedback.mjs); they are never generated here. */
function validObservationSets(observations) {
  if (observations === undefined) return [];
  if (!Array.isArray(observations) || observations.length > 20) throw fail('AI 관찰 자료 형식이 유효하지 않습니다.');
  for (const set of observations) {
    if (!set || typeof set !== 'object' || !bounded(set.provider, 40) || !bounded(set.model, 120) || !bounded(set.createdAt, 64) || !Array.isArray(set.items) || set.items.length > 300) throw fail('AI 관찰 자료 형식이 유효하지 않습니다.');
    for (const item of set.items) if (!item || !bounded(item.id, 160) || !bounded(item.entryDigest, 64) || !bounded(item.observedScene, 4000) || !bounded(item.feedbackSummary, 8000) || !Array.isArray(item.questions) || item.questions.some(question => !bounded(question, 1000)) || !Array.isArray(item.evidenceFrames) || item.evidenceFrames.some(frame => !Number.isSafeInteger(frame) || frame < 0)) throw fail('AI 관찰 항목 형식이 유효하지 않습니다.');
  }
  return observations;
}

/** Portable local brief: no video asset is copied and no model/network client is used. */
export async function prepareFeedbackExport({ state, targetVersionId, commentIds, files, directory, overviewDirectory = join(directory, '.overviews'), snapshots = {}, observations, signal }) {
  abort(signal);
  const observationSets = structuredClone(validObservationSets(observations));
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
    const plan = planRequestContextFrames(comment, authored.durationFrames);
    let group = sourceGroups.get(authored.id);
    if (!group) { group = { authored, frames: new Set(), videoPath: fileSnapshot[authored.mediaUrl.split('/').at(-1)]?.path }; sourceGroups.set(authored.id, group); }
    for (const scene of plan.sceneFrames) group.frames.add(scene.frame);
    const ids = [...new Set([...comment.attachmentIds, ...(comment.voiceAssetId ? [comment.voiceAssetId] : [])])];
    for (const id of ids) {
      const attachment = snapshot.attachments.find(item => item.id === id), file = fileSnapshot[id];
      if (!attachment || !file || !['reference', 'insert', 'voice'].includes(attachment.role) || (attachment.role === 'voice' ? !attachment.mimeType.startsWith('audio/') : !attachment.mimeType.startsWith('image/'))) throw fail('피드백에 저장된 참고 자료를 찾지 못했습니다. 자료는 생략하지 않았습니다.', 404);
      attachmentRecords.set(id, { attachment, path: attachment.role === 'voice' ? file.path : file.normalizedPath });
    }
    plans.push({ comment, authored, plan, projection: projectComment(comment, authored, targetVersion), ids });
  }
  if ([...sourceGroups.values()].reduce((sum, group) => sum + group.frames.size, 0) > 1200 || attachmentRecords.size > 300) throw fail('한 자료 묶음은 최대 1,200개 장면과 300개 첨부를 지원합니다. 피드백을 나누어 선택해 주세요. 자료는 생략하지 않았습니다.', 413);
  plans.sort((a, b) => (a.projection.ranges[0]?.frameIn ?? Infinity) - (b.projection.ranges[0]?.frameIn ?? Infinity) || a.comment.createdAt.localeCompare(b.comment.createdAt) || a.comment.id.localeCompare(b.comment.id));
  const targetVideoPath = fileSnapshot[targetVersion.mediaUrl.split('/').at(-1)]?.path;
  const identities = [await fileIdentity(targetVideoPath)];
  for (const group of sourceGroups.values()) identities.push(await fileIdentity(group.videoPath));
  for (const record of attachmentRecords.values()) identities.push(await fileIdentity(record.path));
  const relevantOps = (snapshot.ops || []).filter(op => comments.some(comment => comment.id === op.commentId && comment.layerChange));
  const transcripts = [...attachmentRecords.values()].map(record => record.attachment.transcript ?? null);
  const cacheKey = digest({ format: 'feedback-export-v4-ai-handoff-categories', project: { id: snapshot.project.id, name: snapshot.project.name }, targetVersion, comments, authoredVersions: [...sourceGroups.values()].map(group => group.authored), identities, relevantOps, transcripts, observations: observationSets, layers: comments.filter(comment => comment.layerChange).map(comment => layerSnapshots[comment.versionId]) });
  const finalDirectory = join(directory, cacheKey), manifestPath = join(finalDirectory, 'manifest.json'), markdownPath = join(finalDirectory, 'feedback.md'), jsonlPath = join(finalDirectory, 'feedback.jsonl'), vttPath = join(finalDirectory, 'feedback.vtt'), archivePath = join(finalDirectory, 'feedback.zip');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.cacheKey === cacheKey && manifest.kind === 'video-feedback-handoff' && manifest.schemaVersion === HANDOFF_SCHEMA_VERSION && manifest.sourceVideoIncluded === false && manifest.renderedVideoIncluded === false && Array.isArray(manifest.files) && manifest.files.every(file => EXPORT_FILE.test(file.path))) {
      for (const path of [markdownPath, jsonlPath, vttPath, archivePath]) await fileIdentity(path);
      for (const file of manifest.files) if ((await stat(join(finalDirectory, file.path))).size !== file.bytes) throw new Error('cached file changed');
      abort(signal);
      return { directory: finalDirectory, manifestPath, markdownPath, jsonlPath, vttPath, archivePath, manifest, commentCount: manifest.feedback.length, sceneCount: manifest.stats.sceneCount, cacheHit: true, diagnostics: { ffmpegRuns: 0, elapsedMs: 0 } };
    }
  } catch (error) { abort(signal); if (['EACCES', 'EPERM'].includes(error.code)) throw error; }
  await mkdir(directory, { recursive: true }); const work = await mkdtemp(join(directory, '.feedback-export-')), started = performance.now();
  let completed = false;
  try {
    const workers = mediaConcurrency(), sceneFiles = new Map(), attachmentFiles = new Map(), timings = {};
    const groups = [...sourceGroups].map(([versionId, group], index) => ({ versionId, group, folder: `scenes/version-${String(index + 1).padStart(3, '0')}` }));
    for (const { folder } of groups) await mkdir(join(work, folder), { recursive: true });
    const extractStills = async ({ versionId, group, folder }, taskSignal) => {
      const frames = [...group.frames].sort((a, b) => a - b), name = frame => `frame-${String(frame).padStart(6, '0')}.jpg`;
      // Stills depend only on the version file and frame, so a re-export decodes just the frames it has not seen.
      const cacheDirectory = join(directory, '.stills', digest({ format: 'feedback-still-v1', filter: STILL_FILTER, quality: 2, video: await fileIdentity(group.videoPath) }));
      await mkdir(cacheDirectory, { recursive: true });
      const cached = new Set((await mapLimit(frames, 16, async frame => { try { return (await stat(join(cacheDirectory, name(frame)))).size > 0 ? frame : null; } catch { return null; } }, taskSignal)).filter(frame => frame !== null));
      const missing = frames.filter(frame => !cached.has(frame));
      let runs = 0;
      if (missing.length) {
        const extracted = await extractCanonicalFrames({ videoPath: group.videoPath, frames: missing, directory: join(work, folder), filter: STILL_FILTER, outputArgs: ['-q:v', '2'], threads: 1, concurrency: workers, timeout: 120_000, signal: taskSignal });
        if (extracted.paths.some(path => !path)) throw fail('작성 버전 길이와 스틸 개수가 맞지 않습니다. 자료는 생략하지 않았습니다.', 409);
        runs = extracted.runs;
        await mapLimit(missing, workers * 2, async (frame, index) => {
          const target = join(work, folder, name(frame)); await rename(extracted.paths[index], target);
          const partial = join(cacheDirectory, `.${name(frame)}.${process.pid}.partial`);
          try { await copyFile(target, partial, constants.COPYFILE_FICLONE); await rename(partial, join(cacheDirectory, name(frame))); } catch { await rm(partial, { force: true }); }
        }, taskSignal);
      }
      await mapLimit([...cached], workers * 2, async frame => copyFile(join(cacheDirectory, name(frame)), join(work, folder, name(frame)), constants.COPYFILE_FICLONE), taskSignal);
      const files = frames.map(frame => `${folder}/${name(frame)}`);
      frames.forEach((frame, index) => sceneFiles.set(`${versionId}:${frame}`, files[index]));
      return { files, runs, cacheHits: cached.size };
    };
    // Scene stills and the target-version overview are independent native work, so they run side by side.
    const stage = performance.now();
    const native = await mapLimit([...groups.map(group => signal => extractStills(group, signal)), signal => prepareVersionOverview({ versionId: targetVersion.id, videoPath: targetVideoPath, durationFrames: targetVersion.durationFrames, directory: overviewDirectory, signal })], groups.length + 1, (task, index, taskSignal) => task(taskSignal), signal);
    const stills = native.slice(0, -1), overviewResult = native.at(-1), stillRuns = stills.reduce((sum, item) => sum + item.runs, 0), stillCacheHits = stills.reduce((sum, item) => sum + item.cacheHits, 0);
    timings.nativeMs = Math.round(performance.now() - stage);
    abort(signal);
    await mkdir(join(work, 'overview'), { recursive: true }); await copyFile(overviewResult.imagePath, join(work, 'overview/grid.jpg'));
    const attachmentJobs = [...attachmentRecords].map(([id, record], index) => ({ id, record, voice: record.attachment.role === 'voice', file: `attachments/asset-${String(index + 1).padStart(4, '0')}${record.attachment.role === 'voice' ? '.m4a' : '.png'}` }));
    if (attachmentJobs.length) await mkdir(join(work, 'attachments'), { recursive: true });
    await mapLimit(attachmentJobs, workers, async ({ record, file }, index, taskSignal) => { taskSignal.throwIfAborted(); await copyFile(record.path, join(work, file)); }, signal);
    for (const { id, record, voice, file } of attachmentJobs) {
      const transcript = voice && record.attachment.transcript?.text ? { transcript: structuredClone(record.attachment.transcript) } : {};
      attachmentFiles.set(id, { id, name: record.attachment.name, role: record.attachment.role, mimeType: voice ? 'audio/mp4' : 'image/png', file, ...(voice ? { automaticTranscription: Boolean(transcript.transcript), source: 'normalized-audio-only', ...transcript } : {}) });
    }
    // Annotated stills and one-sheet summaries only read their own entry's files; numbering stays in reading order.
    const imageStage = performance.now();
    await mkdir(join(work, 'sheets'), { recursive: true });
    const rendered = await mapLimit(plans, workers, async ({ comment, authored, plan }, index, taskSignal) => {
      taskSignal.throwIfAborted();
      const number = index + 1, scenes = [], cells = [], files = [];
      const drawingsByFrame = new Map(groupDrawings(plan.drawings, comment.contextFrame ?? comment.frameIn).map(group => [group.frame, group.drawings]));
      for (const scene of plan.sceneFrames) {
        const file = sceneFiles.get(`${authored.id}:${scene.frame}`), drawings = drawingsByFrame.get(scene.frame); let annotatedFile;
        if (drawings?.length) {
          const folder = `annotations/feedback-${String(number).padStart(4, '0')}`;
          annotatedFile = `${folder}/frame-${String(scene.frame).padStart(6, '0')}.jpg`;
          await mkdir(join(work, folder), { recursive: true });
          await renderAnnotatedStill(join(work, file), drawings, join(work, annotatedFile)); files.push({ path: annotatedFile, role: 'annotation' });
        }
        scenes.push({ ...scene, file, ...(annotatedFile ? { annotatedFile } : {}) });
        cells.push({ frame: scene.frame, roles: scene.roles, path: join(work, file), ...(annotatedFile ? { annotatedPath: join(work, annotatedFile) } : {}) });
      }
      taskSignal.throwIfAborted();
      const sheetFile = `sheets/feedback-${String(number).padStart(4, '0')}.jpg`;
      const sheet = { file: sheetFile, ...await composeSceneSheet(cells, comment.contextFrame ?? comment.frameIn, join(work, sheetFile)) }; files.push({ path: sheetFile, role: 'sheet' });
      return { scenes, sheet, files };
    }, signal);
    timings.imagesMs = Math.round(performance.now() - imageStage);
    abort(signal);
    // Inventory order matches reading order: scenes, overview, attachments, then each entry's annotations and sheet.
    const listed = [...stills.flatMap(item => item.files.map(path => ({ path, mimeType: 'image/jpeg', role: 'scene' }))), { path: 'overview/grid.jpg', mimeType: 'image/jpeg', role: 'overview' }, ...attachmentJobs.map(job => ({ path: job.file, mimeType: job.voice ? 'audio/mp4' : 'image/png', role: 'attachment' })), ...rendered.flatMap(item => item.files.map(file => ({ ...file, mimeType: 'image/jpeg' })))];
    const assets = await mapLimit(listed, workers * 2, async ({ path, mimeType, role }) => inventoryFile(work, path, mimeType, role), signal);
    const feedback = [], observedIds = new Set(observationSets.flatMap(set => set.items.map(item => item.id)));
    for (let index = 0; index < plans.length; index++) {
      const { comment, authored, plan, ids } = plans[index], { scenes, sheet } = rendered[index], number = index + 1;
      let layerMetadata = {};
      if (comment.layerChange) {
        const target = (layerSnapshots[comment.versionId] || []).find(op => isVisualOp(op) && visualLayerId(op) === comment.layerChange.targetLayerId && op.id === comment.layerChange.targetOpId);
        if (!target) throw fail('기존 그래픽 변경 대상 기록을 찾지 못했습니다. 자료는 생략하지 않았습니다.', 409);
        layerMetadata = { layerChange: comment.layerChange, layerTarget: target, proposedOperations: relevantOps.filter(op => op.commentId === comment.id) };
      }
      const entry = buildHandoffEntry({ number, comment, authored, target: targetVersion, plan, scenes, sheet, attachments: ids.map(id => attachmentFiles.get(id)), layerMetadata });
      const entryObservations = observationSets.flatMap(set => set.items.filter(item => item.id === entry.id).map(item => ({ source: 'model', provider: set.provider, model: set.model, createdAt: set.createdAt, stale: item.entryDigest !== entryDigest(entry), observedScene: item.observedScene, feedbackSummary: item.feedbackSummary, questions: item.questions, evidenceFrames: item.evidenceFrames })));
      feedback.push(entryObservations.length ? { ...entry, observations: entryObservations } : entry);
    }
    const unmatchedObservations = [...observedIds].filter(id => !feedback.some(entry => entry.id === id)).length;
    const overview = { versionId: targetVersion.id, versionNumber: targetVersion.number, durationFrames: targetVersion.durationFrames, grid: { file: 'overview/grid.jpg', ...overviewResult.grid }, shots: overviewResult.shots };
    const stats = { commentCount: feedback.length, sceneCount: sceneFiles.size, annotationCount: assets.filter(file => file.role === 'annotation').length, sheetCount: feedback.length, attachmentCount: attachmentFiles.size, authoredVersionCount: sourceGroups.size, shotCount: overview.shots.list.length, transcriptCount: [...attachmentFiles.values()].filter(item => item.transcript).length, observationCount: feedback.reduce((sum, entry) => sum + (entry.observations?.length ?? 0), 0), unmatchedObservationCount: unmatchedObservations };
    const manifest = { schemaVersion: HANDOFF_SCHEMA_VERSION, kind: 'video-feedback-handoff', cacheKey, createdAt: new Date().toISOString(), localOnly: true, modelCalled: false, networkUsed: false, sourceVideoIncluded: false, renderedVideoIncluded: false, automaticTranscription: false, modelObservationsIncluded: stats.observationCount > 0, frameConvention: FRAME_CONVENTION, guide: READING_GUIDE, project: { id: snapshot.project.id, name: snapshot.project.name }, targetVersion: { id: targetVersion.id, number: targetVersion.number, label: targetVersion.label, durationFrames: targetVersion.durationFrames, fps: 30 }, overview, feedback, files: assets, stats, diagnostics: { ffmpegRuns: stillRuns + overviewResult.diagnostics.ffmpegRuns, stillRuns, stillCacheHits, overviewRuns: overviewResult.diagnostics.ffmpegRuns, overviewCacheHit: overviewResult.cacheHit, ...(overviewResult.shots.source ? { shotSource: overviewResult.shots.source } : {}) } };
    await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2)); await writeFile(join(work, 'feedback.md'), renderFeedbackMarkdown(manifest));
    await writeFile(join(work, 'feedback.jsonl'), renderFeedbackJsonl(manifest)); await writeFile(join(work, 'feedback.vtt'), renderFeedbackVtt(manifest)); abort(signal);
    // Every entry is generated locally with portable relative paths; no source/edited video is added.
    const zipStage = performance.now();
    await writeZip(work, join(work, 'feedback.zip'), ['feedback.md', 'feedback.jsonl', 'feedback.vtt', 'manifest.json', ...assets.map(asset => asset.path)], { signal });
    timings.zipMs = Math.round(performance.now() - zipStage);
    abort(signal);
    await rm(finalDirectory, { recursive: true, force: true }); await rename(work, finalDirectory); completed = true;
    return { directory: finalDirectory, manifestPath, markdownPath, jsonlPath, vttPath, archivePath, manifest, commentCount: feedback.length, sceneCount: sceneFiles.size, cacheHit: false, diagnostics: { ...manifest.diagnostics, ...timings, elapsedMs: Math.round(performance.now() - started) } };
  } finally { if (!completed) await rm(work, { recursive: true, force: true }); }
}
