import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { ffmpegPath, ingest, mapToSource, renderVideo, run } from '../apps/worker/engine.mjs';

const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const codeFiles = ['apps/worker/feedback-export.mjs', 'apps/worker/handoff.mjs', 'apps/worker/overview.mjs', 'apps/worker/scene-scores.mjs', 'apps/worker/canonical-frames.mjs', 'apps/worker/parallel.mjs', 'apps/worker/zip.mjs', 'apps/worker/drawings.mjs', 'packages/core/comment-projection.mjs', 'packages/core/drawing-anchors.mjs', 'packages/core/drawing-text.mjs'];

/** Local fixture only: preserve the supplied video and never touch the live application project. */
export async function verifyFeedbackExport({ sourcePath, directory }) {
  sourcePath = resolve(sourcePath); directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  assert.ok(!(await realpath(sourcePath)).startsWith(`${await realpath(directory)}${sep}`), 'Use a QA output directory separate from the original source.');
  const { prepareFeedbackExport } = await import('../apps/worker/feedback-export.mjs');
  const codeHashes = Object.fromEntries(await Promise.all(codeFiles.map(async path => [path, await hash(new URL(`../${path}`, import.meta.url))])));
  const sourceHash = await hash(sourcePath), canonicalPath = join(directory, 'canonical.mp4');
  const asset = await ingest(sourcePath, canonicalPath, join(directory, 'thumbnail.jpg'));
  assert.ok(asset.durationFrames >= 180, 'The fixture requires at least six seconds.');
  const op = (id, type, frameIn, frameOut, params = {}) => ({ id, type, sourceRanges: [{ frameIn, frameOut }], params, status: 'approved' });
  const ops = [op('trim', 'trim', 0, 180), op('cut', 'cut', 30, 60), op('speed', 'speed', 90, 150, { factor: 2 })];
  const editedPath = join(directory, 'edited.mp4');
  const rendered = await renderVideo({ asset, sourcePath, ops, outputPath: editedPath, workingDirectory: join(directory, 'render') });
  assert.equal(rendered.durationFrames, 120);
  const versions = [
    { id: 'version_original', assetId: 'asset_qa', number: 1, parentVersionId: null, durationFrames: asset.durationFrames, mediaUrl: '/media/original_video', thumbnailUrl: '/media/thumbnail', opIds: [], timelineMap: [{ sourceIn: 0, sourceOut: asset.durationFrames, outputIn: 0, outputOut: asset.durationFrames, speed: 1, volume: 1 }], status: 'ready', label: '원본', createdAt: '2026-10-14T00:00:00Z' },
    { id: 'version_edited', assetId: 'asset_qa', number: 2, parentVersionId: 'version_original', durationFrames: rendered.durationFrames, mediaUrl: '/media/edited_video', thumbnailUrl: '/media/thumbnail', opIds: ops.map(item => item.id), timelineMap: rendered.timelineMap, status: 'ready', label: '컷과 배속 결과', createdAt: '2026-10-14T00:01:00Z' },
  ];
  const rectangle = (id, frame, color, x, y) => ({ id, frame, kind: 'rect', color, fill: color, strokeWidth: 2, points: [{ x, y }, { x: x + .2, y: y + .2 }] });
  const comment = (id, version, frameIn, frameOut, contextFrame, text, sceneDescription, drawings) => ({ id, versionId: version.id, frameIn, frameOut, contextFrame, kind: 'request', text, sceneDescription, drawings, attachmentIds: ['reference_image'], sourceRanges: mapToSource(version.timelineMap, frameIn, frameOut), status: 'received', createdAt: '2026-10-14T00:02:00Z' });
  const comments = [
    comment('feedback_original', versions[0], 60, 90, 75, '학습 포인트를 강조해 주세요.', '여러 학습 화면이 한 화면에 모인 장면.', [rectangle('original-red', 75, '#ff0000', .1, .1)]),
    comment('feedback_edited', versions[1], 60, 90, 75, '빠르게 지나가는 부분의 자막 위치를 아래로 옮겨 주세요.', '컷 뒤에 빨라진 장면을 검토하는 중.', [rectangle('edited-blue', 75, '#0000ff', .6, .1)]),
    comment('feedback_deleted', versions[0], 30, 60, 45, '이 장면의 제목을 더 짧게 해 주세요.', '현재 버전에서는 삭제됐지만 원본에서 다시 확인할 장면.', [rectangle('deleted-yellow', 45, '#ffff00', .1, .6)]),
  ];
  comments[0].supplements = [{ id: 'followup', text: '표시한 부분만 참고하고 원본 색은 유지해 주세요.', createdAt: '2026-10-14T00:03:00Z' }];
  const referencePath = join(directory, 'reference.png');
  await sharp({ create: { width: 48, height: 48, channels: 4, background: '#ff00ff' } }).png().toFile(referencePath);
  const files = {
    asset_qa: { sourcePath, path: sourcePath, name: 'source.mp4', mimeType: 'video/mp4' },
    original_video: { path: canonicalPath, name: 'original.mp4', mimeType: 'video/mp4' },
    edited_video: { path: editedPath, name: 'edited.mp4', mimeType: 'video/mp4' },
    reference_image: { path: referencePath, normalizedPath: referencePath, name: '참고 이미지.png', mimeType: 'image/png' },
  };
  const state = { project: { id: 'project_feedback_qa', name: '장면과 피드백 전달 검증', activeVersionId: versions[1].id, createdAt: '2026-10-14T00:00:00Z' }, asset: { id: 'asset_qa', name: 'local-test.mp4', ...asset }, versions, comments, ops: [], jobs: [], attachments: [{ id: 'reference_image', name: '참고 이미지.png', role: 'reference', mimeType: 'image/png', mediaUrl: '/media/reference_image', createdAt: '2026-10-14T00:00:00Z' }] };
  const stateBefore = JSON.stringify(state), canonicalHash = await hash(canonicalPath), editedHash = await hash(editedPath);
  const priorFetch = globalThis.fetch; let networkCalls = 0, result;
  globalThis.fetch = () => { networkCalls++; throw new Error('Feedback export must not make a network request.'); };
  try { result = await prepareFeedbackExport({ state, targetVersionId: versions[1].id, files, directory: join(directory, 'exports'), snapshots: { [versions[0].id]: [], [versions[1].id]: ops } }); }
  finally { globalThis.fetch = priorFetch; }
  assert.equal(networkCalls, 0);
  const { manifest } = result;
  assert.equal(manifest.kind, 'video-feedback-handoff');
  assert.equal(manifest.localOnly, true); assert.equal(manifest.networkUsed, false); assert.equal(manifest.modelCalled, false);
  assert.equal(manifest.sourceVideoIncluded, false); assert.equal(manifest.renderedVideoIncluded, false);
  assert.equal(result.commentCount, 3);
  assert.equal(manifest.feedback.length, 3);
  assert.deepEqual(JSON.parse(await readFile(result.manifestPath, 'utf8')), manifest);
  const byId = new Map(manifest.feedback.map(item => [item.id, item]));
  const first = byId.get('feedback_original'), edited = byId.get('feedback_edited'), deleted = byId.get('feedback_deleted');
  for (const original of comments) {
    const item = byId.get(original.id);
    assert.equal(item.sceneDescription.source, 'user'); assert.equal(item.sceneDescription.text, original.sceneDescription);
    assert.equal(item.feedback.original, original.text);
    assert.equal(item.authored.versionId, original.versionId); assert.equal(item.authored.frameIn, original.frameIn); assert.equal(item.authored.frameOut, original.frameOut); assert.equal(item.authored.contextFrame, original.contextFrame);
    assert.deepEqual(item.authored.sourceRanges, original.sourceRanges); assert.deepEqual(item.drawings, original.drawings);
  }
  assert.equal(first.current.status, 'present'); assert.equal(first.current.contextFrame, 45);
  assert.deepEqual(first.current.ranges.map(({ frameIn, frameOut }) => ({ frameIn, frameOut })), [{ frameIn: 30, frameOut: 60 }]);
  assert.equal(edited.current.status, 'present'); assert.equal(edited.current.contextFrame, 75);
  assert.deepEqual(edited.current.ranges.map(({ frameIn, frameOut }) => ({ frameIn, frameOut })), [{ frameIn: 60, frameOut: 90 }]);
  assert.equal(deleted.current.status, 'deleted'); assert.equal(deleted.current.contextFrame, null); assert.deepEqual(deleted.current.ranges, []);
  assert.deepEqual(deleted.current.deletedSourceRanges, [{ frameIn: 30, frameOut: 60 }]);
  assert.deepEqual([first, edited, deleted].map(item => item.drawingProjection.map(({ frame, status }) => ({ frame, status }))), [[{ frame: 45, status: 'present' }], [{ frame: 75, status: 'present' }], [{ frame: null, status: 'deleted' }]]);

  const paths = new Set();
  const collectPaths = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['file', 'annotatedFile'].includes(key) && typeof child === 'string') paths.add(child);
      else if (child && typeof child === 'object') collectPaths(child);
    }
  };
  collectPaths(manifest);
  assert.ok(paths.size > 6);
  for (const path of paths) { assert.ok(!isAbsolute(path) && !path.split('/').includes('..') && !path.includes('\\'), `Non-portable path: ${path}`); assert.ok((await stat(join(result.directory, path))).size > 0); }
  const markdown = await readFile(result.markdownPath, 'utf8'), json = JSON.stringify(manifest);
  for (const input of comments) { assert.ok(markdown.includes(input.text), `Markdown omitted feedback ${input.id}`); assert.ok(markdown.includes(input.sceneDescription), `Markdown omitted scene content ${input.id}`); }
  assert.ok(markdown.includes(comments[0].supplements[0].text));
  const sections = markdown.split(/\n## \d+\./).slice(1);
  const section = id => sections[manifest.feedback.findIndex(item => item.id === id)];
  assert.ok(markdown.indexOf('| 시간 | 장면 내용 | 피드백 요약 | 자료 |') < markdown.indexOf('검토 가능한 시간별 피드백 브리프'));
  assert.ok(!markdown.includes('피드백 ID:') && !markdown.includes(' · frame '), 'Technical IDs and frame values belong in the manifest, not the reading flow.');
  assert.ok(section(first.id).includes('현재 v2: 00:01.000–00:02.000'));
  assert.ok(section(first.id).includes('작성 v1: 00:02.000–00:03.000'));
  assert.ok(section(edited.id).includes('현재 v2: 00:02.000–00:03.000'));
  assert.ok(section(edited.id).includes('작성 v2: 00:02.000–00:03.000'));
  assert.ok(section(deleted.id).includes('현재 v2: 현재 영상에 표시할 구간 없음'));
  assert.ok(section(deleted.id).includes('작성 v1: 00:01.000–00:02.000'));
  assert.ok(section(deleted.id).includes('현재 버전에서 삭제된 구간'));
  for (const text of [markdown, json]) { assert.ok(!text.includes(sourcePath) && !text.includes(directory) && !text.includes('/Users/') && !text.includes('/Volumes/'), 'Export documents cannot depend on local absolute paths.'); assert.ok(!text.includes('/media/'), 'Export links must stay usable after unzipping on another machine.'); }
  const archiveEntries = (await run('/usr/bin/unzip', ['-Z1', result.archivePath])).trim().split('\n').filter(Boolean);
  assert.ok(archiveEntries.includes('feedback.md') && archiveEntries.includes('manifest.json'));
  assert.ok(archiveEntries.every(path => !isAbsolute(path) && !path.split('/').includes('..')));
  assert.ok(archiveEntries.every(path => !/\.(?:mp4|mov|mkv|avi|mxf|webm)$/i.test(path)), 'No original or edited video may be included in the handoff.');
  for (const path of paths) assert.ok(archiveEntries.includes(path), `ZIP omitted ${path}`);
  const unpacked = await mkdtemp(join(directory, 'portable-unpacked-'));
  await run('/usr/bin/unzip', ['-q', result.archivePath, '-d', unpacked]);
  assert.deepEqual(JSON.parse(await readFile(join(unpacked, 'manifest.json'), 'utf8')), manifest);
  assert.equal(await readFile(join(unpacked, 'feedback.md'), 'utf8'), markdown);
  for (const path of paths) assert.equal(await hash(join(unpacked, path)), await hash(join(result.directory, path)));
  const annotatedChecks = [];
  for (const [item, center, expected] of [[first, [.2, .2], [255, 0, 0]], [edited, [.7, .2], [0, 0, 255]], [deleted, [.2, .7], [255, 255, 0]]]) {
    const scene = item.scenes.find(scene => scene.frame === item.authored.contextFrame && scene.annotatedFile);
    assert.ok(scene, `Authored drawing scene is required even when deleted in the target: ${item.id}`);
    const path = join(unpacked, scene.annotatedFile), metadata = await sharp(path).metadata();
    const reference = join(directory, `${item.id}-authored-reference.png`), authoredPath = item.authored.versionId === versions[0].id ? canonicalPath : editedPath;
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', authoredPath, '-vf', `select=eq(n\\,${scene.frame}),scale=${metadata.width}:${metadata.height},setsar=1`, '-frames:v', '1', reference]);
    const [referencePixels, exportedPixels] = await Promise.all([sharp(reference).removeAlpha().raw().toBuffer(), sharp(join(unpacked, scene.file)).removeAlpha().raw().toBuffer()]);
    const sceneMeanAbsoluteError = referencePixels.reduce((sum, value, index) => sum + Math.abs(value - exportedPixels[index]), 0) / referencePixels.length;
    assert.ok(sceneMeanAbsoluteError < 8, `Authored still belongs to the wrong video/frame for ${item.id}: ${sceneMeanAbsoluteError}`);
    const rgb = [...await sharp(path).extract({ left: Math.floor(metadata.width * center[0]), top: Math.floor(metadata.height * center[1]), width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
    const unmarkedRgb = [...await sharp(join(unpacked, scene.file)).extract({ left: Math.floor(metadata.width * center[0]), top: Math.floor(metadata.height * center[1]), width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
    assert.ok(rgb.every((value, index) => Math.abs(value - expected[index]) < 40), `Annotation missing or misplaced in ${item.id}: ${rgb}`);
    assert.ok(rgb.reduce((sum, value, index) => sum + Math.abs(value - unmarkedRgb[index]), 0) > 50, 'The annotation fixture must visibly change the unmarked still.');
    annotatedChecks.push({ feedbackId: item.id, authoredFrame: scene.frame, annotatedFile: scene.annotatedFile, rgb, unmarkedRgb, sceneMeanAbsoluteError });
  }
  const textChecks = await verifyTextOutputs({ result, manifest, markdown, archiveEntries, unpacked, deletedId: deleted.id });
  assert.equal(JSON.stringify(state), stateBefore); assert.equal(await hash(sourcePath), sourceHash); assert.equal(await hash(canonicalPath), canonicalHash); assert.equal(await hash(editedPath), editedHash);
  for (const path of codeFiles) assert.equal(await hash(new URL(`../${path}`, import.meta.url)), codeHashes[path], `Checked module changed during verification: ${path}`);
  const report = { checkedAt: new Date().toISOString(), sourcePath, sourceHash, sourcePreserved: true, versionsPreserved: true, statePreserved: true, fetchCalls: networkCalls, codeHashes, archivePath: result.archivePath, manifestPath: result.manifestPath, markdownPath: result.markdownPath, unpacked, archiveEntries, commentCount: result.commentCount, sceneCount: result.sceneCount, annotatedChecks, textChecks, diagnostics: result.diagnostics, projections: manifest.feedback.map(({ id, authored, current }) => ({ id, authored, current })), scope: 'Isolated local feedback ZIP, authored context, current range projection, scene descriptions and annotated still pixels. No video is exported; no external AI or browser interaction is used. Scene descriptions are explicit fixture input, not generated recognition.' };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

/** Format v2: schema, one-line-per-feedback JSONL, WebVTT cues, per-feedback sheets, version overview and drawing sentences. */
async function verifyTextOutputs({ result, manifest, markdown, archiveEntries, unpacked, deletedId }) {
  const { validateHandoffManifest } = await import('./handoff-schema.mjs');
  await validateHandoffManifest(manifest);
  for (const name of ['feedback.jsonl', 'feedback.vtt']) { assert.ok(archiveEntries.includes(name), `ZIP omitted ${name}`); assert.equal(await readFile(join(unpacked, name), 'utf8'), await readFile(join(result.directory, name), 'utf8')); }
  const lines = (await readFile(result.jsonlPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].type, 'handoff'); assert.equal(lines[0].target.durationFrames, manifest.targetVersion.durationFrames); assert.equal(lines.length, manifest.feedback.length + 1);
  manifest.feedback.forEach((entry, index) => {
    const line = lines[index + 1];
    assert.equal(line.type, 'feedback'); assert.equal(line.n, index + 1); assert.equal(entry.number, index + 1); assert.equal(line.id, entry.id);
    assert.equal(line.feedback, entry.feedback.original); assert.deepEqual(line.supplements, entry.feedback.supplements.map(item => item.text));
    assert.equal(line.scene?.text ?? '', entry.sceneDescription.text); assert.equal(line.images.sheet, entry.sheet.file);
    assert.equal(line.drawings.length, entry.drawings.length); for (const drawing of line.drawings) { assert.match(drawing.where, /화면 .+ · 가로 \d+–\d+%, 세로 \d+–\d+%/); assert.equal(drawing.box.length, 4); }
    assert.ok(entry.drawingProjection.every(item => markdown.includes(item.description)), 'Drawing sentences belong in the reading document.');
    assert.equal(entry.sheet.cells.length, entry.scenes.length); assert.equal(entry.sheet.cells[0].frame, entry.authored.contextFrame);
    assert.equal(entry.sheet.cells.filter(cell => cell.annotated).length, entry.scenes.filter(scene => scene.annotatedFile).length);
  });
  const sheetSizes = [];
  for (const entry of manifest.feedback) { const metadata = await sharp(join(unpacked, entry.sheet.file)).metadata(); assert.equal(metadata.width, entry.sheet.width); assert.equal(metadata.height, entry.sheet.height); sheetSizes.push(metadata.size); }
  const grid = await sharp(join(unpacked, manifest.overview.grid.file)).metadata(); assert.equal(grid.width, manifest.overview.grid.width); assert.equal(grid.height, manifest.overview.grid.height);
  const shots = manifest.overview.shots.list; assert.equal(shots[0].frameIn, 0); assert.equal(shots.at(-1).frameOut, manifest.targetVersion.durationFrames); assert.ok(shots.every((shot, index) => !index || shot.frameIn === shots[index - 1].frameOut));
  const vtt = await readFile(result.vttPath, 'utf8');
  assert.ok(vtt.startsWith('WEBVTT')); assert.ok(!/\n\n\n/.test(vtt));
  const cues = [...vtt.matchAll(/^(feedback-\d+(?:-\d+)?)\n(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})$/gm)].map(match => ({ id: match[1], start: match[2], end: match[3] }));
  const placed = manifest.feedback.filter(entry => entry.current.ranges.length);
  assert.equal(cues.length, placed.reduce((sum, entry) => sum + entry.current.ranges.length, 0));
  const deletedEntry = manifest.feedback.find(entry => entry.id === deletedId); assert.ok(!cues.some(cue => cue.id === `feedback-${deletedEntry.number}`)); assert.match(vtt, new RegExp(`NOTE[\\s\\S]*\\[${deletedEntry.number}\\] 작성 v1`));
  return { jsonlLines: lines.length, vttCues: cues, sheetBytes: sheetSizes, overviewShots: shots.length, schema: 'schema/feedback-handoff.schema.json' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], 'Usage: node scripts/verify-feedback-export.mjs SOURCE.mp4 [OUTPUT_DIRECTORY]');
  const report = await verifyFeedbackExport({ sourcePath: process.argv[2], directory: process.argv[3] || 'storage/qa/feedback-export' });
  console.log(JSON.stringify({ archivePath: report.archivePath, comments: report.commentCount, scenes: report.sceneCount, sourcePreserved: report.sourcePreserved, annotatedChecks: report.annotatedChecks, projections: report.projections }, null, 2));
}
