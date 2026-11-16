import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { validateDrawings } from '../apps/worker/drawings.mjs';
import { interpretLocal, validateAiResponse } from '../apps/worker/interpreter.mjs';
import { createGraphic, ffmpegPath, run, renderVideo } from '../apps/worker/engine.mjs';
import { planRequestContextFrames, prepareRequestContextBundle } from '../apps/worker/context-bundle.mjs';
import { validateHandoffManifest } from '../scripts/handoff-schema.mjs';

const shape = (id = 'shape', frame) => ({ id, kind: 'rect', color: '#FF0000', fill: '#FF0000', region: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, points: [], ...(frame === undefined ? {} : { frame }) });
const comment = drawings => ({ id: 'request', versionId: 'original', frameIn: 0, frameOut: 60, contextFrame: 30, sourceRanges: [{ frameIn: 0, frameOut: 60 }], text: '이 그림 그대로 영상에 넣어줘', drawings, attachmentIds: [], createdAt: '2026-10-14T00:00:00Z' });

test('drawing frame metadata is optional, bounded and preserved without altering legacy objects', () => {
  const legacy = shape(), explicit = shape('explicit', 89), before = JSON.stringify([legacy, explicit]);
  assert.deepEqual(validateDrawings([legacy, explicit], { durationFrames: 90 }), [legacy, explicit]); assert.equal(JSON.stringify([legacy, explicit]), before);
  for (const frame of [-1, 0.5, NaN, Infinity, null, 90]) assert.throws(() => validateDrawings([shape('invalid', frame)], { durationFrames: 90 }), /프레임/);
});

test('local and cloud schemas hold multi-frame static insertion for an explicit one-scene copy', () => {
  const request = comment([shape('one', 10), shape('two', 40)]);
  for (const result of [interpretLocal(request, []), validateAiResponse({ ops: [{ type: 'overlay', params: { kind: 'drawing' } }] }, request, [])]) { assert.deepEqual(result.ops, []); assert.match(result.clarification, /한 장면/); }
  const same = comment([shape('legacy'), shape('same', 30)]);
  assert.deepEqual(interpretLocal(same, []).ops[0].params.drawings, same.drawings);
  assert.deepEqual(validateAiResponse({ ops: [{ type: 'overlay', params: { kind: 'drawing' } }] }, same, []).ops[0].params.drawings, same.drawings);
});

test('multi-scene regional visuals cannot choose the first region while temporal operations stay available', () => {
  const request = { ...comment([shape('one', 10), shape('two', 40)]), text: '2배속하고 자막: 확인' };
  const local = interpretLocal(request, []); assert.deepEqual(local.ops.map(op => op.type), ['speed']); assert.match(local.clarification, /임의로 선택/);
  const cloud = validateAiResponse({ ops: [{ type: 'speed', params: { factor: 2 } }, { type: 'subtitle', params: { text: '확인' } }, { type: 'overlay', params: { kind: 'box' } }] }, request, []);
  assert.deepEqual(cloud.ops.map(op => op.type), ['speed']); assert.equal(cloud.ops[0].region, undefined); assert.match(cloud.clarification, /임의로 선택/);
});

test('single-scene native insertion keeps geometry and reuses raster cache across frame metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-interference-frame-cache-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const asset = { durationFrames: 90, width: 320, height: 180, fps: 30, hasAudio: false }, drawings = [shape('a', 10), shape('b', 10)];
  const op = { id: 'drawing', type: 'overlay', status: 'approved', params: { kind: 'drawing', drawings }, sourceRanges: [{ frameIn: 0, frameOut: 60 }] };
  const first = await createGraphic(asset, op, join(directory, 'cache'));
  const second = await createGraphic(asset, { ...op, params: { ...op.params, drawings: drawings.map(drawing => ({ ...drawing, frame: 40 })) } }, join(directory, 'cache'));
  assert.equal(second.cacheHit, true); assert.equal(first.path, second.path);
  await assert.rejects(createGraphic(asset, { ...op, params: { ...op.params, drawings: [drawings[0], { ...drawings[1], frame: 40 }] } }, join(directory, 'cache')), /여러 장면/, 'a cache hit cannot bypass static multi-frame validation');
  const sourcePath = join(directory, 'source.mp4'), outputPath = join(directory, 'edited.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath]);
  await renderVideo({ asset, sourcePath, ops: [op], outputPath, workingDirectory: join(directory, 'job') });
  for (const [frame, expected] of [[30, 'red'], [75, 'blue']]) {
    const png = join(directory, `${frame}.png`); await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', outputPath, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', png]);
    const pixels = await sharp(png).removeAlpha().raw().toBuffer(), index = (60 * 320 + 100) * 3, rgb = [...pixels.subarray(index, index + 3)];
    assert.ok(expected === 'red' ? rgb[0] > 180 && rgb[2] < 30 : rgb[2] > 180 && rgb[0] < 30, `${expected} pixel at ${frame}: ${rgb}`);
  }
});

test('local bundle retains all thirty drawing scenes, range samples and ten images in one native extraction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-interference-local-context-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=3', '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=red:t=fill:enable='gte(n,30)*lt(n,60)',drawbox=x=0:y=0:w=iw:h=ih:color=green:t=fill:enable='gte(n,60)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath]);
  const attachments = [], files = {};
  for (let index = 0; index < 10; index++) { const id = `image-${index}`, path = join(directory, `${id}.png`); await sharp({ create: { width: 20, height: 20, channels: 4, background: '#FF00FF' } }).png().toFile(path); attachments.push({ id, name: `${id}.png`, role: index % 2 ? 'insert' : 'reference', mimeType: 'image/png' }); files[id] = { normalizedPath: path }; }
  const request = { ...comment(Array.from({ length: 30 }, (_, frame) => shape(`drawing-${frame}`, frame))), frameIn: 40, frameOut: 60, contextFrame: 80, text: '각 장면의 표시를 참고해줘', attachmentIds: attachments.map(item => item.id), supplements: [{ id: 'extra', text: '우선 참고 자료만 정리', createdAt: '2026-10-14T00:01:00Z' }] }, before = JSON.stringify(request);
  const plan = planRequestContextFrames(request, 90); assert.equal(plan.sceneFrames.length, 34);
  await assert.rejects(prepareRequestContextBundle(request, { versionPath: sourcePath, durationFrames: 90, directory, attachments: attachments.slice(1), files }), /자료는 생략하지 않았습니다/);
  const describedRequest = { ...request, sceneDescription: '사용자가 직접 기록한 장면 설명' };
  const { manifest, directory: bundleDirectory, manifestPath } = await prepareRequestContextBundle(describedRequest, { versionPath: sourcePath, durationFrames: 90, directory, attachments, files });
  assert.deepEqual(manifest.sceneDescription, { source: 'user', text: describedRequest.sceneDescription });
  assert.equal(manifest.modelCalled, false); assert.equal(manifest.networkUsed, false); assert.equal(manifest.preparation, 'local-only'); assert.equal(manifest.diagnostics.ffmpegRuns, 1); assert.equal(manifest.diagnostics.sceneImageCount + manifest.diagnostics.attachmentImageCount, 44);
  assert.deepEqual(manifest.drawings, request.drawings); assert.equal(manifest.drawingContexts.length, 30); assert.equal(manifest.latestInstruction, request.supplements[0].text); assert.equal(JSON.stringify(request), before);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), manifest);
  await validateHandoffManifest(manifest);
  const [entry] = manifest.feedback;
  assert.equal(manifest.kind, 'video-feedback-context'); assert.equal(manifest.schemaVersion, 2); assert.equal(entry.id, request.id); assert.deepEqual(entry.drawings, request.drawings);
  assert.deepEqual(entry.feedback, { original: request.text, supplements: request.supplements }); assert.deepEqual(entry.sceneDescription, manifest.sceneDescription);
  assert.equal(entry.scenes.length, 34); assert.equal(entry.scenes.filter(scene => scene.annotatedFile).length, 30); assert.equal(manifest.diagnostics.annotationImageCount, 30);
  assert.equal(entry.drawingProjection.length, 30); assert.ok(entry.drawingProjection.every(item => /화면 /.test(item.description)));
  assert.equal(entry.sheet.cells.length, 34); assert.equal(entry.sheet.cells[0].frame, 80);
  for (const file of manifest.files) assert.equal(createHash('sha256').update(await readFile(join(bundleDirectory, file.path))).digest('hex'), file.sha256);
  for (const item of [...manifest.sceneFrames, ...manifest.attachments]) { assert.ok(item.width <= 640 && item.height <= 640); assert.ok((await readFile(join(bundleDirectory, item.file))).length > 0); }
  for (const [frame, expected] of [[0, 'blue'], [49, 'red'], [80, 'green']]) { const { data } = await sharp(join(bundleDirectory, `scene-${frame}.jpg`)).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const rgb = [...data.subarray(0, 3)]; assert.ok(expected === 'blue' ? rgb[2] > 180 : expected === 'red' ? rgb[0] > 180 : rgb[1] > 80, `${expected} actual still at ${frame}: ${rgb}`); }
  const voiceOriginal = join(directory, 'voice.webm'), voiceBytes = Buffer.from('original voice upload bytes'); await writeFile(voiceOriginal, voiceBytes);
  const voiced = await prepareRequestContextBundle({ ...request, attachmentIds: [], voiceAssetId: 'voice' }, { versionPath: sourcePath, durationFrames: 90, directory, attachments: [{ id: 'voice', name: 'voice.webm', role: 'voice', mimeType: 'audio/mp4' }], files: { voice: { path: 'unused-normalized-path', originalPath: voiceOriginal } } });
  assert.equal(voiced.manifest.automaticTranscription, false); assert.equal(voiced.manifest.attachments[0].source, 'original-upload'); assert.equal(voiced.manifest.attachments[0].mimeType, 'audio/webm'); assert.deepEqual(await readFile(join(voiced.directory, voiced.manifest.attachments[0].file)), voiceBytes);
});

test('extended drawing contexts stop before the existing external adapter and truthfully report no model call', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-interference-context-offline-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const control = join(directory, 'control'), interpreterUrl = new URL('../apps/worker/interpreter.mjs', import.meta.url).href;
  const script = `const {interpret}=await import(process.env.VI_INTERPRETER_URL); const comment=${JSON.stringify(comment([shape('one', 10), shape('two', 40)]))}; const result=await interpret(comment,{attachments:[],files:{},versionPath:'unused',directory:'unused'}); process.stdout.write(JSON.stringify(result));`;
  const child = spawn(process.execPath, ['--import', new URL('./engine-fetch-stub.mjs', import.meta.url).pathname, '--input-type=module', '-e', script], { env: { ...process.env, VI_INTERPRETER_URL: interpreterUrl, VI_TEST_FETCH_CONTROL: control, ANTHROPIC_API_KEY: 'offline-stub-only', ANTHROPIC_MODEL: 'offline-stub-only' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('offline adapter test timed out')); }, 5000); child.once('exit', code => { clearTimeout(timer); resolve(code); }); }); assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout); assert.equal(result.mode, 'local-rules'); assert.deepEqual(result.ops, []); assert.match(result.clarification, /호출하지 않았습니다/); assert.deepEqual(await readdir(control), []);
});
