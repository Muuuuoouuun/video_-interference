import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { drawingsSvg } from './drawings.mjs';
import { projectComment } from '../../packages/core/comment-projection.mjs';
import { projectDrawings } from '../../packages/core/drawing-anchors.mjs';
import { describeDrawing, drawingBox } from '../../packages/core/drawing-text.mjs';

/** Shared, local-only building blocks for the feedback handoff and the per-request AI context bundle (format v2). */
export const HANDOFF_SCHEMA_VERSION = 2;
export const FRAME_CONVENTION = '30fps; half-open ranges [frameIn,frameOut)';
export const READING_GUIDE = 'feedback.jsonl 또는 manifest.json의 글을 먼저 읽고, 글로 판단할 수 없을 때만 sheets/의 피드백별 한 장 요약, 그다음 scenes/·annotations/의 개별 스틸을 여세요. 영상 전체 흐름은 overview/grid.jpg 한 장으로 확인합니다. 영상 파일은 포함하지 않습니다.';
export const CONTEXT_READING_GUIDE = 'manifest.json의 feedback[0] 글을 먼저 읽고, 글로 판단할 수 없을 때만 sheet.jpg 한 장 요약, 그다음 scene-*·annotation-* 개별 스틸을 여세요. 영상 파일은 포함하지 않습니다.';
const POINT_CUE_FRAMES = 60;

export const clock = frame => { const milliseconds = Math.round(frame / 30 * 1000); return `${String(Math.floor(milliseconds / 60000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`; };
export const rangesText = ranges => ranges.length ? ranges.map(range => range.frameOut - range.frameIn === 1 ? clock(range.frameIn) : `${clock(range.frameIn)}–${clock(range.frameOut)}`).join(', ') : '현재 영상에 표시할 구간 없음';
const roleTags = { 'comment-context': 'CTX', 'request-start': 'IN', 'request-middle': 'MID', 'request-end': 'OUT', 'drawing-context': 'DRAW' };
const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function missingSourceRanges(ranges, timelineMap) {
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

export async function inventoryFile(root, path, mimeType, role) {
  const bytes = await readFile(`${root}/${path}`);
  return { path, mimeType, role, bytes: bytes.length, sha256: sha256(bytes) };
}

/** Request drawings drawn over an authored still. JPEG keeps the handoff light; exact coordinates stay in JSON. */
export async function renderAnnotatedStill(stillPath, drawings, outputPath) {
  const metadata = await sharp(stillPath).metadata();
  await sharp(stillPath).composite([{ input: Buffer.from(drawingsSvg(metadata.width, metadata.height, drawings)), left: 0, top: 0 }]).jpeg({ quality: 90 }).toFile(outputPath);
}

/** One image per feedback: the context frame large, every other sampled frame below. Drawn frames use the annotated still. */
export async function composeSceneSheet(cells, contextFrame, outputPath) {
  if (!cells.length) throw new Error('한 장 요약에 넣을 장면이 없습니다.');
  const PAD = 8, WIDTH = 960, inner = WIDTH - PAD * 2, COLUMNS = 4;
  const first = await sharp(cells[0].path).metadata(), aspect = first.height / first.width;
  const fit = (maxWidth, maxHeight) => { let w = maxWidth, h = Math.round(maxWidth * aspect); if (h > maxHeight) { h = maxHeight; w = Math.round(maxHeight / aspect); } return { w, h }; };
  const heroIndex = Math.max(0, cells.findIndex(cell => cell.frame === contextFrame));
  // Captions sit in a band under each image so no label covers scene content or a request drawing.
  const HERO_BAND = 28, THUMB_BAND = 20;
  const hero = fit(inner, 600), thumbWidth = Math.floor((inner - PAD * (COLUMNS - 1)) / COLUMNS), thumb = fit(thumbWidth, thumbWidth);
  const ordered = [cells[heroIndex], ...cells.filter((_, index) => index !== heroIndex)];
  const placed = ordered.map((cell, index) => {
    if (!index) return { cell, x: PAD + Math.floor((inner - hero.w) / 2), y: PAD, band: HERO_BAND, ...hero };
    const slot = index - 1, column = slot % COLUMNS, row = Math.floor(slot / COLUMNS);
    return { cell, x: PAD + column * (thumbWidth + PAD) + Math.floor((thumbWidth - thumb.w) / 2), y: PAD + hero.h + HERO_BAND + PAD + row * (thumb.h + THUMB_BAND + PAD), band: THUMB_BAND, ...thumb };
  });
  const rows = Math.ceil((ordered.length - 1) / COLUMNS), height = PAD + hero.h + HERO_BAND + PAD + (rows ? rows * (thumb.h + THUMB_BAND + PAD) : 0);
  const layers = [];
  for (const item of placed) layers.push({ input: await sharp(item.cell.annotatedPath || item.cell.path).resize(item.w, item.h, { fit: 'fill' }).toBuffer(), left: item.x, top: item.y });
  const labels = placed.map(item => {
    const text = `${clock(item.cell.frame)} ${item.cell.roles.map(role => roleTags[role] || role).join(' ')}${item.cell.annotatedPath ? ' · MARKED' : ''}`;
    const size = item.band === HERO_BAND ? 16 : 11;
    return `<text x="${item.x + 2}" y="${item.y + item.h + size + 4}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${size}" fill="#e8e8e8">${escapeXml(text)}</text>`;
  }).join('');
  layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">${labels}</svg>`), left: 0, top: 0 });
  await sharp({ create: { width: WIDTH, height, channels: 3, background: '#202020' } }).composite(layers).jpeg({ quality: 85 }).toFile(outputPath);
  return { width: WIDTH, height, cells: placed.map(item => ({ frame: item.cell.frame, roles: item.cell.roles, annotated: Boolean(item.cell.annotatedPath), x: item.x, y: item.y, w: item.w, h: item.h })) };
}

/** The same entry shape for every handoff kind. `current` is the target version; a context bundle targets its own version. */
export function buildHandoffEntry({ number, comment, authored, target, plan, scenes, sheet, attachments, layerMetadata = {}, observations }) {
  const projection = projectComment(comment, authored, target);
  return {
    id: comment.id, number, kind: comment.kind ?? 'request', ...(comment.status ? { status: comment.status } : {}), ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
    sceneDescription: { source: comment.sceneDescription ? 'user' : 'not-provided', text: comment.sceneDescription ?? '' },
    feedback: { original: comment.text, supplements: comment.supplements ?? [] },
    authored: { versionId: authored.id, versionNumber: authored.number, frameIn: comment.frameIn, frameOut: comment.frameOut, contextFrame: comment.contextFrame ?? comment.frameIn, sourceRanges: comment.sourceRanges },
    current: { versionId: target.id, ...projection, deletedSourceRanges: missingSourceRanges(comment.sourceRanges, target.timelineMap) },
    drawings: plan.drawings,
    drawingProjection: projectDrawings({ ...comment, drawings: plan.drawings }, authored, target).map(({ drawing, authoredFrame, frame, status }) => ({ id: drawing.id, authoredFrame, frame, status, description: describeDrawing(drawing) })),
    scenes, ...(sheet ? { sheet } : {}), attachments,
    ...(observations?.length ? { observations } : {}),
    ...layerMetadata,
  };
}

/** Digest of what a model saw for one entry; a later export marks the observation stale when this changes. */
export function entryDigest(entry) {
  return sha256(JSON.stringify({ id: entry.id, kind: entry.kind, sceneDescription: entry.sceneDescription?.text ?? '', original: entry.feedback?.original ?? '', supplements: (entry.feedback?.supplements ?? []).map(item => item.text), authored: [entry.authored?.versionId, entry.authored?.frameIn, entry.authored?.frameOut, entry.authored?.contextFrame], frames: (entry.scenes ?? []).map(scene => scene.frame), drawings: entry.drawings ?? [] }));
}

const vttTime = frame => { const milliseconds = Math.max(0, Math.round(frame / 30 * 1000)); return `${String(Math.floor(milliseconds / 3_600_000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 60000) % 60).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`; };
const vttText = text => String(text).replace(/-->/g, '→').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
const oneLine = text => String(text).replace(/\s+/g, ' ').trim();
const transcriptOf = attachment => attachment.transcript?.text ? attachment.transcript : null;

function cueLines(entry) {
  const lines = [`[${entry.number}] ${entry.kind === 'note' ? '메모' : '피드백'}: ${oneLine(entry.feedback.original) || '(글 없음 · 그림·첨부 참고)'}`];
  for (const supplement of entry.feedback.supplements ?? []) lines.push(`보완: ${oneLine(supplement.text)}`);
  if (entry.sceneDescription?.text) lines.push(`장면: ${oneLine(entry.sceneDescription.text)}`);
  for (const drawing of entry.drawingProjection ?? []) lines.push(`그림 ${drawing.frame === null ? '(현재 장면 없음)' : clock(drawing.frame)}: ${drawing.description}`);
  for (const attachment of entry.attachments ?? []) if (attachment.role === 'voice') lines.push(transcriptOf(attachment) ? `음성(자동 받아쓰기): ${oneLine(attachment.transcript.text)}` : '음성 메모 · 미전사');
  return lines;
}

/** WebVTT on the target version's timeline. Deleted-scene feedback stays as NOTE blocks instead of moving elsewhere. */
export function renderFeedbackVtt(manifest) {
  const target = manifest.targetVersion, blocks = [`WEBVTT - 시간별 피드백 · 기준 v${target.number}`, '', 'NOTE', vttText(`기준 버전 v${target.number}(${target.label}) 화면 위에 피드백을 표시합니다. 한 시점 피드백은 보기 편하도록 최대 2초 동안 보여 줍니다. 정확한 프레임은 manifest.json을 따릅니다.`), ''];
  const placed = manifest.feedback.filter(entry => entry.current.ranges.length), missing = manifest.feedback.filter(entry => !entry.current.ranges.length);
  if (missing.length) {
    blocks.push('NOTE', vttText(`현재 버전에 위치가 없는 피드백 ${missing.length}개 (삭제됐거나 위치를 확정할 수 없음)`));
    for (const entry of missing) blocks.push(vttText(`[${entry.number}] 작성 v${entry.authored.versionNumber} ${rangesText([entry.authored])} · ${oneLine(entry.feedback.original) || '그림·첨부 참고'}`));
    blocks.push('');
  }
  const cues = [];
  for (const entry of placed) entry.current.ranges.forEach((range, index) => {
    const end = range.frameOut - range.frameIn === 1 ? Math.min(target.durationFrames, range.frameIn + POINT_CUE_FRAMES) : range.frameOut;
    cues.push({ start: range.frameIn, end: Math.max(end, range.frameIn + 1), id: `feedback-${entry.number}${entry.current.ranges.length > 1 ? `-${index + 1}` : ''}`, entry });
  });
  cues.sort((left, right) => left.start - right.start || left.entry.number - right.entry.number);
  for (const cue of cues) blocks.push(cue.id, `${vttTime(cue.start)} --> ${vttTime(cue.end)}`, vttText(cueLines(cue.entry).join('\n')), '');
  return blocks.join('\n');
}

const compactRanges = ranges => ranges.map(range => ({ in: range.frameIn, out: range.frameOut }));

/** One JSON object per line: a handoff header, then one line per feedback in reading order. Rounded boxes; exact values stay in manifest.json. */
export function renderFeedbackJsonl(manifest) {
  const target = manifest.targetVersion, overview = manifest.overview;
  const header = {
    type: 'handoff', kind: manifest.kind, schemaVersion: manifest.schemaVersion, project: manifest.project.name,
    target: { version: target.number, label: target.label, duration: clock(target.durationFrames), durationFrames: target.durationFrames, fps: 30 },
    conventions: `${manifest.frameConvention}; time strings are mm:ss.mmm`, guide: READING_GUIDE,
    ...(overview ? { overview: { grid: overview.grid.file, shotsEstimated: overview.shots.estimated, shots: overview.shots.list.map(shot => ({ n: shot.index, time: rangesText([shot]), frames: [shot.frameIn, shot.frameOut] })) } } : {}),
    counts: { feedback: manifest.feedback.length, ...manifest.stats },
    provenance: { localOnly: manifest.localOnly, modelCalled: manifest.modelCalled, networkUsed: manifest.networkUsed, sourceVideoIncluded: manifest.sourceVideoIncluded, renderedVideoIncluded: manifest.renderedVideoIncluded, sceneDescriptions: 'user', transcripts: 'asr (automatic, verify against audio)', observations: 'model (separate from user text)' },
  };
  const lines = [JSON.stringify(header)];
  for (const entry of manifest.feedback) {
    const context = entry.scenes.find(scene => scene.frame === entry.authored.contextFrame) ?? entry.scenes[0];
    lines.push(JSON.stringify({
      type: 'feedback', n: entry.number, id: entry.id, kind: entry.kind,
      time: { current: entry.current.ranges.length ? rangesText(entry.current.ranges) : null, authored: `v${entry.authored.versionNumber} ${rangesText([entry.authored])}`, status: entry.current.status, context: clock(entry.authored.contextFrame) },
      frames: { authored: { version: entry.authored.versionNumber, in: entry.authored.frameIn, out: entry.authored.frameOut, context: entry.authored.contextFrame }, current: compactRanges(entry.current.ranges), deletedSource: compactRanges(entry.current.deletedSourceRanges) },
      scene: entry.sceneDescription.text ? { text: entry.sceneDescription.text, source: 'user' } : null,
      feedback: entry.feedback.original, supplements: (entry.feedback.supplements ?? []).map(item => item.text),
      drawings: (entry.drawingProjection ?? []).map(projection => { const drawing = entry.drawings.find(item => item.id === projection.id); return { kind: drawing?.kind, color: drawing?.color, at: clock(projection.authoredFrame ?? entry.authored.contextFrame), current: projection.status === 'present' ? clock(projection.frame) : projection.status, where: projection.description, box: drawing ? drawingBox(drawing) : null }; }),
      voice: entry.attachments.filter(item => item.role === 'voice').map(item => ({ file: item.file, transcript: transcriptOf(item)?.text ?? null, ...(transcriptOf(item) ? { transcriptSource: `asr:${item.transcript.engine}`, language: item.transcript.language } : { note: '미전사' }) })),
      images: { sheet: entry.sheet?.file ?? null, context: context?.file ?? null, annotated: entry.scenes.filter(scene => scene.annotatedFile).map(scene => scene.annotatedFile), stills: entry.scenes.map(scene => scene.file) },
      references: entry.attachments.filter(item => item.role !== 'voice').map(item => ({ role: item.role, name: item.name, file: item.file })),
      ...(entry.observations?.length ? { observations: entry.observations.map(item => ({ source: 'model', provider: item.provider, model: item.model, stale: item.stale, observedScene: item.observedScene, feedbackSummary: item.feedbackSummary, questions: item.questions })) } : {}),
      ...(entry.layerChange ? { layerChange: entry.layerChange } : {}),
    }));
  }
  return `${lines.join('\n')}\n`;
}
