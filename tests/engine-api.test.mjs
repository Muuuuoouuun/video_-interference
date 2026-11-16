import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, readdir, stat, rm, writeFile, access, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegPath, ffprobePath, run } from '../apps/worker/engine.mjs';
import { validateHandoffManifest } from '../scripts/handoff-schema.mjs';
import { fakeWhisper } from './fake-whisper.mjs';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { IMAGE_ATTACHMENT_LIMIT, commentAttachmentInput } from '../packages/core/comment-attachments.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = 'http://127.0.0.1:4319';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

await test('loopback API preserves approvals, versions, media boundaries and imported project archives', { timeout: 120_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'video-interference-api-'));
  const samplePath = join(storage, 'bootstrap-demo.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=13', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=13', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', samplePath]);
  const child = spawn(process.execPath, ['apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: '4319', VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: samplePath, ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', chunk => { log += chunk.toString(); }); child.stderr.on('data', chunk => { log += chunk.toString(); });
  t.after(async () => { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref(); }); await rm(storage, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`worker failed: ${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (attempt === 199) throw new Error(`worker readiness timed out: ${log}`);
    await pause(100);
  }
  const request = async (path, method = 'GET', value) => {
    const response = await fetch(`${base}${path}`, { method, ...(value === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) });
    return { response, value: await response.json() };
  };
  const state = (await request('/api/state')).value;
  assert.equal(state.project.name, '인터랙티브 수업'); assert.equal(state.comments.length, 2); assert.equal(state.ops.length, 2); assert.equal(state.asset.fps, 30); assert.equal(state.capabilities.interpreter, 'local-rules');
  assert.ok(state.comments.every(comment => comment.contextFrame === comment.frameIn), 'omitted context defaults to the range start');
  assert.ok(state.comments.every(comment => comment.kind === 'request'), 'legacy callers without kind create editing requests');
  const note = (await request('/api/comments', 'POST', { versionId: state.versions[0].id, frameIn: 0, frameOut: 30, kind: 'note', text: '2배속으로 바꾸고 그림을 영상에 넣어' })).value;
  assert.equal(note.kind, 'note'); assert.equal((await request(`/api/comments/${note.id}/interpret`, 'POST', {})).response.status, 409);
  assert.equal((await request('/api/state')).value.ops.filter(item => item.commentId === note.id).length, 0, 'stored notes do not silently create executable operations');
  const koreanPatch = { text: '후반 장면의 한글 피드백 🎬', sceneDescription: '정확한 시점의 장면' };
  const patchBytes = Buffer.from(JSON.stringify(koreanPatch)), split = patchBytes.indexOf(Buffer.from('후')) + 1;
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/comments/${note.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { try { resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
      res.on('error', reject);
    });
    req.on('error', reject); req.setNoDelay(true); req.write(patchBytes.subarray(0, split));
    setTimeout(() => req.end(patchBytes.subarray(split)), 20);
  });
  assert.equal(chunked.status, 200); assert.equal(chunked.value.text, koreanPatch.text);
  assert.equal((await request('/api/state')).value.comments.find(item => item.id === note.id).sceneDescription, koreanPatch.sceneDescription);
  const koreanDb = new DatabaseSync(join(storage, 'project.sqlite'), { readOnly: true });
  try { assert.equal(JSON.parse(koreanDb.prepare('SELECT data FROM workspace WHERE id = 1').get().data).state.comments.find(item => item.id === note.id).text, koreanPatch.text, 'split Korean bytes persist intact in SQLite'); }
  finally { koreanDb.close(); }
  assert.equal((await request('/api/comments', 'POST', { versionId: state.versions[0].id, frameIn: 0, frameOut: 30, kind: 'unknown', text: 'invalid kind' })).response.status, 400);
  // Premiere exports transfer only feedback + PNGs, including a self-contained panel ZIP.
  const premiere = await request('/api/premiere-exports', 'POST', { versionId: state.versions[0].id });
  assert.equal(premiere.response.status, 200);
  assert.equal(premiere.value.commentCount, (await request('/api/state')).value.comments.length);
  assert.ok(Number.isInteger(premiere.value.timelineSegmentCount));
  assert.ok(Number.isInteger(premiere.value.skippedOverlayCount));
  const handoff = await (await fetch(`${base}${premiere.value.manifestUrl}`)).json();
  assert.equal(handoff.videoIncluded, false); assert.equal(handoff.stillsIncluded, false);
  assert.equal(handoff.timelineOverlays.segments.length, premiere.value.timelineSegmentCount);
  for (const key of ['archiveUrl', 'pluginUrl']) {
    const response = await fetch(`${base}${premiere.value[key]}?download=1`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  }
  assert.equal((await request('/api/premiere-exports', 'POST', { versionId: state.versions[0].id, video: true })).response.status, 400);
  const original = state.versions[0], speed = state.ops.find(op => op.type === 'speed');
  const unapproved = await request('/api/render', 'POST', { parentVersionId: original.id, opIds: [speed.id] }); assert.equal(unapproved.response.status, 400);
  await request(`/api/ops/${speed.id}`, 'PATCH', { status: 'approved' });
  const reset = await request(`/api/ops/${speed.id}`, 'PATCH', { status: 'proposed' }); assert.equal(reset.value.status, 'proposed');
  await request(`/api/ops/${speed.id}`, 'PATCH', { status: 'approved' });
  const edited = await request(`/api/ops/${speed.id}`, 'PATCH', { status: 'approved', params: { factor: 1.5 } }); assert.equal(edited.value.status, 'proposed'); assert.equal(edited.value.params.factor, 1.5);
  const badParams = await request(`/api/ops/${speed.id}`, 'PATCH', { status: 'proposed', params: { factor: 100, command: 'rm' } }); assert.equal(badParams.response.status, 400);
  await request(`/api/ops/${speed.id}`, 'PATCH', { status: 'proposed', params: { factor: 2 } });
  await request(`/api/ops/${speed.id}`, 'PATCH', { status: 'approved' });
  const legacyNoteComment = (await request('/api/comments', 'POST', { versionId: original.id, frameIn: 0, frameOut: 30, text: '메모: 나중에 확인' })).value;
  const legacyNoteOp = (await request(`/api/comments/${legacyNoteComment.id}/interpret`, 'POST', {})).value.ops[0]; assert.equal(legacyNoteOp.type, 'note');
  await request(`/api/ops/${legacyNoteOp.id}`, 'PATCH', { status: 'approved' });
  assert.equal((await request('/api/render', 'POST', { parentVersionId: original.id, opIds: [speed.id, legacyNoteOp.id] })).response.status, 409, 'legacy note operations cannot enter a mixed execution batch');
  const conflictingComment = (await request('/api/comments', 'POST', { versionId: original.id, frameIn: 180, frameOut: 300, text: '이 구간 3배속' })).value;
  const conflictingSpeed = (await request(`/api/comments/${conflictingComment.id}/interpret`, 'POST', {})).value.ops[0];
  await request(`/api/ops/${conflictingSpeed.id}`, 'PATCH', { status: 'approved' });
  assert.equal((await request('/api/render', 'POST', { parentVersionId: original.id, opIds: [speed.id, conflictingSpeed.id] })).response.status, 409);
  await request(`/api/ops/${conflictingSpeed.id}`, 'PATCH', { status: 'rejected' });
  const removedComment = (await request('/api/comments', 'POST', { versionId: original.id, frameIn: 270, frameOut: 360, text: '이 구간 삭제' })).value;
  const removedCut = (await request(`/api/comments/${removedComment.id}/interpret`, 'POST', {})).value.ops[0];
  const selectedSubtitle = state.ops.find(item => item.type === 'subtitle');
  await request(`/api/ops/${removedCut.id}`, 'PATCH', { status: 'approved' }); await request(`/api/ops/${selectedSubtitle.id}`, 'PATCH', { status: 'approved' });
  assert.equal((await request('/api/render', 'POST', { parentVersionId: original.id, opIds: [removedCut.id, selectedSubtitle.id] })).response.status, 409);
  assert.equal((await request('/api/state')).value.jobs.length, 0, 'conflicting plans do not create render jobs');
  await request(`/api/ops/${removedCut.id}`, 'PATCH', { status: 'rejected' }); await request(`/api/ops/${selectedSubtitle.id}`, 'PATCH', { status: 'proposed' });
  const started = await request('/api/render', 'POST', { parentVersionId: original.id, opIds: [speed.id] }); assert.equal(started.response.status, 202);
  const waitJob = async id => {
    for (let attempt = 0; attempt < 450; attempt++) {
      const job = (await request(`/api/jobs/${id}`)).value;
      if (job.status === 'failed') throw new Error(job.error);
      if (job.status === 'completed') return job;
      await pause(100);
    }
    throw new Error('render timed out');
  };
  const finished = await waitJob(started.value.id); assert.equal(finished.progress, 100);
  const afterRender = (await request('/api/state')).value, revised = afterRender.versions.find(v => v.id === finished.versionId);
  assert.equal(revised.durationFrames, original.durationFrames - 60); assert.equal(afterRender.project.activeVersionId, original.id);
  const immutable = await request(`/api/ops/${speed.id}`, 'PATCH', { status: 'proposed', params: { factor: 3 } }); assert.equal(immutable.response.status, 409);
  assert.equal((await request('/api/project', 'PATCH', { activeVersionId: revised.id })).response.status, 200);
  for (const contextFrame of [-1, 0.5, revised.durationFrames]) {
    const invalidContext = await request('/api/comments', 'POST', { versionId: revised.id, frameIn: 210, frameOut: 240, contextFrame, text: '맥락 프레임 검증' });
    assert.equal(invalidContext.response.status, 400);
  }
  const comment = (await request('/api/comments', 'POST', { versionId: revised.id, frameIn: 210, frameOut: 240, contextFrame: 100, text: '자막: 원본 장면에 고정' })).value;
  assert.equal(comment.contextFrame, 100, 'drawing context can be outside the selected editing range');
  assert.deepEqual(comment.sourceRanges, [{ frameIn: 270, frameOut: 300 }]);
  const interpreted = (await request(`/api/comments/${comment.id}/interpret`, 'POST', {})).value;
  assert.equal(interpreted.comment.contextFrame, 100);
  assert.equal(interpreted.mode, 'local-rules'); assert.equal(interpreted.ops[0].type, 'subtitle');
  await request(`/api/ops/${interpreted.ops[0].id}`, 'PATCH', { status: 'approved' });
  const startedChild = await request('/api/render', 'POST', { parentVersionId: revised.id, opIds: [interpreted.ops[0].id] });
  const finishedChild = await waitJob(startedChild.value.id), childState = (await request('/api/state')).value;
  const latest = childState.versions.find(v => v.id === finishedChild.versionId);
  assert.equal(childState.comments.find(item => item.id === comment.id).contextFrame, 100);
  assert.equal(latest.durationFrames, revised.durationFrames); assert.equal(latest.opIds.length, 2);
  const originalSubtitle = state.ops.find(op => op.type === 'subtitle'); await request(`/api/ops/${originalSubtitle.id}`, 'PATCH', { status: 'approved' });
  assert.equal((await request('/api/render', 'POST', { parentVersionId: latest.id, opIds: [originalSubtitle.id] })).response.status, 400);
  const drawings = [{ id: 'ink', kind: 'rect', color: '#0000FF', fill: '#0000FF', opacity: 0.75, strokeWidth: 6, points: [{ x: 0.1, y: 0.1 }, { x: 0.35, y: 0.5 }] }];
  const drawingComment = (await request('/api/comments', 'POST', { versionId: latest.id, frameIn: 0, frameOut: 60, contextFrame: 100, text: '이 그림과 도형 그대로 영상에 넣어줘', drawings })).value;
  assert.deepEqual(drawingComment.drawings, drawings);
  const drawingResult = (await request(`/api/comments/${drawingComment.id}/interpret`, 'POST', {})).value;
  const drawingOp = drawingResult.ops[0]; assert.equal(drawingOp.params.kind, 'drawing'); assert.deepEqual(drawingOp.params.drawings, drawings); assert.equal(drawingOp.status, 'proposed');
  assert.equal((await request('/api/render', 'POST', { parentVersionId: latest.id, opIds: [drawingOp.id] })).response.status, 400, 'drawing insertion also needs approval');
  for (const invalid of [{ ...drawings[0], opacity: 1.1 }, { ...drawings[0], fill: 'url(file:///etc/passwd)' }, { ...drawings[0], kind: 'line', points: [] }]) assert.equal((await request('/api/comments', 'POST', { versionId: latest.id, frameIn: 0, frameOut: 60, text: '검증', drawings: [invalid] })).response.status, 400);
  const attachmentBytes = await sharp({ create: { width: 40, height: 40, channels: 4, background: '#FFFF00' } }).png().toBuffer();
  const attachmentResponse = await fetch(`${base}/api/attachments`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent('노란 이미지.png'), 'x-asset-role': 'insert', 'content-type': 'image/png' }, body: attachmentBytes });
  assert.equal(attachmentResponse.status, 201); const attachment = await attachmentResponse.json();
  for (const kind of ['request', 'note']) {
    const attachmentOnly = await request('/api/comments', 'POST', { versionId: latest.id, frameIn: 0, frameOut: 60, text: '', kind, attachmentIds: [attachment.id] });
    assert.equal(attachmentOnly.response.status, 201); assert.equal(attachmentOnly.value.text, ''); assert.deepEqual(attachmentOnly.value.attachmentIds, [attachment.id]);
    assert.equal((await request('/api/state')).value.ops.filter(item => item.commentId === attachmentOnly.value.id).length, 0, 'saving attachments alone does not interpret them or insert them into video');
  }
  const imageComment = (await request('/api/comments', 'POST', { versionId: latest.id, frameIn: 0, frameOut: 60, text: '이 이미지를 영상에 넣어줘', attachmentIds: [attachment.id], drawings: [{ id: 'region', kind: 'rect', color: '#DFFF00', points: [], region: { x: 0.1, y: 0.1, w: 0.25, h: 0.4 } }] })).value;
  const imageOp = (await request(`/api/comments/${imageComment.id}/interpret`, 'POST', {})).value.ops[0];
  await request(`/api/ops/${imageOp.id}`, 'PATCH', { status: 'approved' });
  const invalidEdit = await request(`/api/ops/${imageOp.id}`, 'PATCH', { status: 'proposed', params: { kind: 'text', text: 'must not be committed' }, region: { x: 0.9, y: 0.1, w: 0.2, h: 0.2 } }); assert.equal(invalidEdit.response.status, 400);
  const retained = (await request('/api/state')).value.ops.find(item => item.id === imageOp.id);
  assert.equal(retained.status, 'approved'); assert.equal(retained.params.kind, 'image'); assert.deepEqual(retained.region, imageOp.region, 'failed region edit keeps all prior fields and approval');
  const placement = { x: 0.7, y: 0.1, w: 0.2, h: 0.2 };
  const placed = await request(`/api/ops/${imageOp.id}`, 'PATCH', { status: 'approved', region: placement }); assert.equal(placed.value.status, 'proposed'); assert.deepEqual(placed.value.region, placement);
  assert.equal((await request(`/api/ops/${originalSubtitle.id}`, 'PATCH', { status: 'proposed', region: { x: 0, y: 0, w: 0.001, h: 0.2 } })).response.status, 400);
  await request(`/api/ops/${drawingOp.id}`, 'PATCH', { status: 'approved' }); await request(`/api/ops/${imageOp.id}`, 'PATCH', { status: 'approved' });
  const graphicsStarted = await request('/api/render', 'POST', { parentVersionId: latest.id, opIds: [drawingOp.id, imageOp.id] }); assert.equal(graphicsStarted.response.status, 202);
  const graphicsFinished = await waitJob(graphicsStarted.value.id);
  const graphicsPath = join(storage, 'media', `${graphicsFinished.versionId}.mp4`), stillPath = join(storage, 'placed-frame.png');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', graphicsPath, '-vf', 'select=eq(n\\,15)', '-frames:v', '1', stillPath]);
  const pixels = await sharp(stillPath).removeAlpha().raw().toBuffer();
  const pixel = (x, y) => [...pixels.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
  const placedPixel = pixel(256, 36), drawingPixel = pixel(64, 45); assert.ok(placedPixel[0] > 220 && placedPixel[1] > 220 && placedPixel[2] < 30, `image must move to approved location: ${placedPixel}`); assert.ok(drawingPixel[2] > 175, `source drawing remains in original location: ${drawingPixel}`);
  assert.equal((await request(`/api/ops/${drawingOp.id}`, 'PATCH', { status: 'proposed', params: { kind: 'drawing', drawings: [{ ...drawings[0], color: '#000000' }] } })).response.status, 409);
  const snapshotDb = new DatabaseSync(join(storage, 'project.sqlite'), { readOnly: true });
  const persisted = JSON.parse(snapshotDb.prepare('SELECT data FROM workspace WHERE id = 1').get().data); snapshotDb.close();
  assert.deepEqual(persisted.snapshots[graphicsFinished.versionId].find(item => item.id === drawingOp.id).params.drawings, drawings, 'approved render snapshot preserves complete drawing geometry and styles');
  const graphicsVersion = (await request('/api/state')).value.versions.find(item => item.id === graphicsFinished.versionId);
  const cancellationComment = (await request('/api/comments', 'POST', { versionId: graphicsVersion.id, frameIn: 0, frameOut: graphicsVersion.durationFrames, text: '이 구간 0.25배속' })).value;
  const cancellationOp = (await request(`/api/comments/${cancellationComment.id}/interpret`, 'POST', {})).value.ops[0];
  await request(`/api/ops/${cancellationOp.id}`, 'PATCH', { status: 'approved' });
  const sourcePath = persisted.files[state.asset.id].sourcePath;
  const sourceHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  const toCancel = (await request('/api/render', 'POST', { parentVersionId: graphicsVersion.id, opIds: [cancellationOp.id] })).value;
  const cancelResponse = await request(`/api/jobs/${toCancel.id}/cancel`, 'POST', {}); assert.equal(cancelResponse.response.status, 202); assert.equal(cancelResponse.value.cancelRequested, true);
  let canceled;
  for (let attempt = 0; attempt < 100; attempt++) { const job = (await request(`/api/jobs/${toCancel.id}`)).value; if (job.status === 'canceled') { canceled = job; break; } assert.notEqual(job.status, 'completed'); await pause(50); }
  assert.equal(canceled?.status, 'canceled');
  const afterCancel = (await request('/api/state')).value;
  assert.equal(afterCancel.ops.find(item => item.id === cancellationOp.id).status, 'approved'); assert.equal(afterCancel.versions.find(item => item.id === toCancel.versionId).status, 'failed');
  assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sourceHash, 'cancellation preserves original source bytes');
  await assert.rejects(access(join(storage, 'media', `${toCancel.versionId}.mp4`)));
  await assert.rejects(access(join(storage, 'media', `${toCancel.versionId}_thumb.jpg`)));
  assert.equal((await request(`/api/jobs/${toCancel.id}/cancel`, 'POST', {})).response.status, 409);
  assert.equal((await request(`/api/jobs/${finishedChild.id}/cancel`, 'POST', {})).response.status, 409);
  const ranged = await fetch(`${base}${latest.mediaUrl}`, { headers: { range: 'bytes=0-31' } }); assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 32);
  const suffix = await fetch(`${base}${latest.mediaUrl}`, { headers: { range: 'bytes=-16' } }); assert.equal(suffix.status, 206); assert.equal((await suffix.arrayBuffer()).byteLength, 16);
  assert.equal((await fetch(`${base}${latest.mediaUrl}`, { headers: { range: 'bytes=999999999999-' } })).status, 416);
  assert.equal((await fetch(`${base}/api/state`, { headers: { origin: 'https://evil.example' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => http.get(`${base}/api/state`, { headers: { host: 'evil.example:4319' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${base}/media/%2e%2e%2fetc%2fpasswd`)).status, 404);
  const invalidName = await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent('../outside.mp4') }, body: Buffer.from('invalid') }); assert.equal(invalidName.status, 400);
  const fixture = join(storage, 'import-fixture.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=yellow:s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture]);
  const oldMediaFile = join(storage, 'media', `${original.mediaUrl.split('/').at(-1)}.mp4`);
  const imported = await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent('새 영상.mp4'), 'content-type': 'video/mp4' }, body: await readFile(fixture) }); assert.equal(imported.status, 201);
  const finalState = (await request('/api/state')).value; assert.equal(finalState.project.name, '새 영상'); assert.equal(finalState.asset.durationFrames, 60); assert.equal(finalState.comments.length, 0);
  const archives = await readdir(join(storage, 'archives')); assert.equal(archives.length, 1);
  const archived = JSON.parse(await readFile(join(storage, 'archives', archives[0]), 'utf8')); assert.equal(archived.state.project.id, state.project.id);
  assert.ok((await stat(oldMediaFile)).size > 0);
});

await test('repository without an optional demo boots empty and accepts its first video', { timeout: 30_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'video-interference-empty-api-'));
  const child = spawn(process.execPath, ['apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: '4319', VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: join(storage, 'no-such-demo.mp4'), ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', chunk => { log += chunk.toString(); }); child.stderr.on('data', chunk => { log += chunk.toString(); });
  t.after(async () => { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref(); }); await rm(storage, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`empty worker failed: ${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (attempt === 99) throw new Error(`empty worker readiness timed out: ${log}`);
    await pause(100);
  }
  const before = await (await fetch(`${base}/api/state`)).json(); assert.equal(before.empty, true); assert.equal(before.capabilities.fps, 30); assert.equal(before.capabilities.interpreter, 'local-rules');
  const premature = await fetch(`${base}/api/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId: 'none', frameIn: 0, text: '삭제' }) }); assert.equal(premature.status, 409);
  const fixture = join(storage, 'first.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture]);
  const imported = await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent('첫 영상.mp4'), 'content-type': 'video/mp4' }, body: await readFile(fixture) }); assert.equal(imported.status, 201);
  const after = await (await fetch(`${base}/api/state`)).json(); assert.equal(after.empty, undefined); assert.equal(after.project.name, '첫 영상'); assert.equal(after.asset.durationFrames, 60); assert.equal(after.versions.length, 1); assert.equal(after.comments.length, 0);
});

await test('pending workspace writes cannot cross imports or overwrite an approved interpretation', { timeout: 60_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'video-interference-workspace-races-'));
  const control = join(storage, 'offline-fetch');
  const stubPath = fileURLToPath(new URL('./engine-fetch-stub.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--import', stubPath, 'apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: '4319', VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: join(storage, 'missing-demo.mp4'), ANTHROPIC_API_KEY: 'offline-stub-only', ANTHROPIC_MODEL: 'offline-stub-only', VI_TEST_FETCH_CONTROL: control }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', chunk => { log += chunk.toString(); }); child.stderr.on('data', chunk => { log += chunk.toString(); });
  const openRequests = [];
  t.after(async () => {
    for (const request of openRequests) request.destroy();
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref(); });
    await rm(storage, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`race worker failed: ${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (attempt === 99) throw new Error(`race worker readiness timed out: ${log}`);
    await pause(50);
  }
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  const source = join(storage, 'source.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  const sourceBytes = await readFile(source);
  const importSource = async () => {
    const response = await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent('독립 프로젝트.mp4'), 'content-type': 'video/mp4' }, body: sourceBytes });
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await importSource()).status, 201);
  const firstState = (await request('/api/state')).value;
  // Expect/Continue confirms the server has entered its request handler before the test advances.
  const partial = async (path, headers, bytes) => {
    let resolveResponse, rejectResponse;
    const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; }); response.catch(() => {});
    const req = http.request(`${base}${path}`, { method: 'POST', headers: { ...headers, expect: '100-continue', 'content-length': String(bytes.length) } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk.toString(); }); res.on('end', () => { try { resolveResponse({ status: res.statusCode, value: JSON.parse(body) }); } catch (error) { rejectResponse(error); } });
    });
    openRequests.push(req); req.on('error', rejectResponse);
    const accepted = new Promise((resolve, reject) => { req.once('continue', resolve); req.once('error', reject); });
    req.flushHeaders(); await accepted;
    const middle = Math.max(1, Math.floor(bytes.length / 2)); req.write(bytes.subarray(0, middle));
    return { response, finish: () => req.end(bytes.subarray(middle)) };
  };
  const imageBytes = await sharp({ create: { width: 40, height: 40, channels: 4, background: '#FF00FF' } }).png().toBuffer();
  const uploading = await partial('/api/attachments', { 'x-file-name': encodeURIComponent('반만 보낸 이미지.png'), 'x-asset-role': 'reference', 'content-type': 'image/png' }, imageBytes);
  assert.equal((await importSource()).status, 409, 'source import cannot replace a project while its attachment body is incomplete');
  uploading.finish(); const uploaded = await uploading.response; assert.equal(uploaded.status, 201);
  const attachedState = (await request('/api/state')).value; assert.equal(attachedState.project.id, firstState.project.id); assert.ok(attachedState.attachments.some(item => item.id === uploaded.value.id));
  const oldComment = (await request('/api/comments', 'POST', { versionId: attachedState.versions[0].id, frameIn: 0, frameOut: 30, text: '이 구간 2배속' })).value;
  const importing = await partial('/api/assets', { 'x-file-name': encodeURIComponent('천천히 보낸 영상.mp4'), 'content-type': 'video/mp4' }, sourceBytes);
  const mutations = [
    ['/api/comments', 'POST', { versionId: attachedState.versions[0].id, frameIn: 0, frameOut: 30, text: '저장 금지' }],
    [`/api/comments/${oldComment.id}/interpret`, 'POST', {}],
    [`/api/comments/${oldComment.id}/supplements`, 'POST', { text: '늦은 추가 지시' }],
    [`/api/comments/${oldComment.id}`, 'PATCH', { text: '늦은 수정' }],
    [`/api/comments/${oldComment.id}`, 'DELETE', {}],
    [`/api/comments/${oldComment.id}/restore`, 'POST', {}],
    [`/api/comments/${oldComment.id}/context-bundle`, 'POST', {}],
    ['/api/project', 'PATCH', { activeVersionId: attachedState.versions[0].id }],
    ['/api/render', 'POST', { parentVersionId: attachedState.versions[0].id, opIds: ['none'] }],
    ['/api/ops/none', 'PATCH', { status: 'approved' }]
  ];
  for (const [path, method, body] of mutations) assert.equal((await request(path, method, body)).status, 409, `${path} must wait for import completion`);
  const blockedAttachment = await fetch(`${base}/api/attachments`, { method: 'POST', headers: { 'x-file-name': 'blocked.png', 'x-asset-role': 'reference' }, body: imageBytes }); assert.equal(blockedAttachment.status, 409);
  assert.equal((await request('/api/state')).value.project.id, attachedState.project.id, 'read requests continue while importing');
  assert.equal((await fetch(`${base}${attachedState.asset.mediaUrl}`, { method: 'HEAD' })).status, 200);
  importing.finish(); assert.equal((await importing.response).status, 201);
  const secondState = (await request('/api/state')).value; assert.notEqual(secondState.project.id, attachedState.project.id); assert.equal(secondState.attachments.length, 0);
  // A JSON body that started in one project must not be committed after another project loads.
  const delayedJson = Buffer.from(JSON.stringify({ versionId: secondState.versions[0].id, frameIn: 0, frameOut: 30, text: '늦게 도착한 요청' }));
  const staleComment = await partial('/api/comments', { 'content-type': 'application/json' }, delayedJson);
  assert.equal((await importSource()).status, 201); staleComment.finish(); assert.equal((await staleComment.response).status, 409);
  assert.equal((await request('/api/state')).value.comments.length, 0);
  const state = (await request('/api/state')).value;
  const comment = (await request('/api/comments', 'POST', { versionId: state.versions[0].id, frameIn: 0, frameOut: 30, text: '이 구간 2배속' })).value;
  const savedSupplement = await request(`/api/comments/${comment.id}/supplements`, 'POST', { text: '자막: 깊어지는 배움' }); assert.equal(savedSupplement.status, 200);
  const awaitStub = async call => { for (let i = 0; i < 400; i++) { try { await access(join(control, `call-${call}.json`)); return; } catch {} await pause(10); } throw new Error('Offline AI stub did not receive interpretation.'); };
  const firstInterpretation = request(`/api/comments/${comment.id}/interpret`, 'POST', {}); await awaitStub(1);
  assert.equal((await request(`/api/comments/${comment.id}/context-bundle`, 'POST', {})).status, 409, 'local preparation shares the same comment lock as interpretation');
  assert.equal((await request(`/api/comments/${comment.id}/supplements`, 'POST', { text: '해석 중 추가' })).status, 409, 'supplements cannot race an in-flight interpretation');
  assert.equal((await request(`/api/comments/${comment.id}`, 'PATCH', { text: '해석 중 수정' })).status, 409, 'edits cannot race an in-flight interpretation');
  assert.equal((await request(`/api/comments/${comment.id}`, 'DELETE')).status, 409, 'deletion cannot race an in-flight interpretation');
  const transmitted = JSON.parse(await readFile(join(control, 'call-1.json'), 'utf8'));
  assert.equal(transmitted.context.text, comment.text); assert.equal(transmitted.context.latestInstruction, '자막: 깊어지는 배움');
  assert.deepEqual(transmitted.context.instructionHistory.map(item => item.source), ['original', 'supplement']);
  assert.deepEqual(transmitted.context.instructionHistory.map(item => item.text), [comment.text, '자막: 깊어지는 배움']);
  assert.equal(transmitted.context.instructionHistory[1].id, savedSupplement.value.supplements[0].id);
  assert.match(transmitted.system, /conflict/); assert.match(transmitted.system, /Never silently choose/);
  assert.deepEqual((await request('/api/state')).value.comments.find(item => item.id === comment.id).supplements, savedSupplement.value.supplements);
  assert.equal((await importSource()).status, 409, 'pending interpretation prevents a project replacement');
  assert.equal((await request(`/api/comments/${comment.id}/interpret`, 'POST', {})).status, 409, 'the same comment cannot be interpreted twice at once');
  await writeFile(join(control, 'release-1'), 'release'); const proposal = await firstInterpretation; assert.equal(proposal.status, 200);
  const op = proposal.value.ops[0];
  const secondInterpretation = request(`/api/comments/${comment.id}/interpret`, 'POST', {}); await awaitStub(2);
  assert.equal((await request(`/api/ops/${op.id}`, 'PATCH', { status: 'approved' })).status, 200);
  await writeFile(join(control, 'release-2'), 'release'); assert.equal((await secondInterpretation).status, 409, 'late interpretation must not delete a now-approved plan');
  const approvedState = (await request('/api/state')).value; assert.equal(approvedState.ops.length, 1); assert.equal(approvedState.ops[0].id, op.id); assert.equal(approvedState.ops[0].status, 'approved');
  const invalidUpload = await fetch(`${base}/api/attachments`, { method: 'POST', headers: { 'x-file-name': 'invalid.png', 'x-asset-role': 'reference' }, body: Buffer.from('not an image') }); assert.equal(invalidUpload.status, 400);
  assert.equal((await importSource()).status, 201, 'failed uploads and rejected late interpretations release their workspace guards');
});

await test('worker SIGTERM drains an active native render and preserves recoverable state on restart', { timeout: 40_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'video-interference-worker-shutdown-'));
  let child, log = '';
  const start = async () => {
    child = spawn(process.execPath, ['apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: '4319', VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: join(storage, 'missing-demo.mp4'), ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { log += chunk.toString(); }); child.stderr.on('data', chunk => { log += chunk.toString(); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`shutdown worker failed: ${log}`);
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      await pause(25);
    }
    throw new Error(`shutdown worker readiness timed out: ${log}`);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exiting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker did not finish bounded shutdown.')), 3500);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    child.kill('SIGTERM'); assert.equal(await exiting, 0);
  };
  t.after(async () => { if (child?.exitCode === null) { try { await stop(); } catch { child.kill('SIGKILL'); } } await rm(storage, { recursive: true, force: true }); });
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  await start();
  const fixture = join(storage, 'source.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture]);
  const sourceBytes = await readFile(fixture), sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const imported = await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'x-file-name': 'source.mp4', 'content-type': 'video/mp4' }, body: sourceBytes }); assert.equal(imported.status, 201);
  const before = (await request('/api/state')).value, original = before.versions[0];
  const comment = (await request('/api/comments', 'POST', { versionId: original.id, frameIn: 0, frameOut: original.durationFrames, text: '이 구간 0.25배속' })).value;
  const op = (await request(`/api/comments/${comment.id}/interpret`, 'POST', {})).value.ops[0]; await request(`/api/ops/${op.id}`, 'PATCH', { status: 'approved' });
  const started = (await request('/api/render', 'POST', { parentVersionId: original.id, opIds: [op.id] })).value;
  const partialPath = join(storage, 'media', `${started.versionId}.mp4`);
  let nativeOutputStarted = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if ((await stat(partialPath)).size > 0) { nativeOutputStarted = true; break; } } catch {}
    await pause(5);
  }
  assert.equal(nativeOutputStarted, true, 'the native renderer must have opened its output before shutdown');
  assert.equal((await request(`/api/jobs/${started.id}`)).value.status, 'running');
  const supplementDuringRender = await request(`/api/comments/${comment.id}/supplements`, 'POST', { text: '렌더 중에는 변경 불가' }); assert.equal(supplementDuringRender.status, 409); assert.match(supplementDuringRender.value.error, /렌더/);
  assert.equal((await request(`/api/comments/${comment.id}`, 'PATCH', { text: '렌더 중 수정' })).status, 409);
  assert.equal((await request(`/api/comments/${comment.id}`, 'DELETE')).status, 409);
  const shutdownStart = Date.now(); await stop(); assert.ok(Date.now() - shutdownStart < 3500);
  await start();
  const recovered = (await request('/api/state')).value, recoveredJob = recovered.jobs.find(item => item.id === started.id);
  assert.ok(['canceled', 'failed'].includes(recoveredJob.status)); assert.equal(recovered.versions.find(item => item.id === started.versionId).status, 'failed'); assert.equal(recovered.ops.find(item => item.id === op.id).status, 'approved');
  assert.equal(recovered.project.activeVersionId, original.id);
  const db = new DatabaseSync(join(storage, 'project.sqlite'), { readOnly: true }); const data = JSON.parse(db.prepare('SELECT data FROM workspace WHERE id = 1').get().data); db.close();
  assert.equal(createHash('sha256').update(await readFile(data.files[before.asset.id].sourcePath)).digest('hex'), sourceHash);
  await assert.rejects(access(partialPath)); await assert.rejects(access(join(storage, 'media', `${started.versionId}_thumb.jpg`)));
  assert.equal((await fetch(`${base}${original.mediaUrl}`, { method: 'HEAD' })).status, 200, 'the original remains available after restart');
});

await test('append-only supplements preserve originals, invalidate approvals atomically and survive restart', { timeout: 60_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'video-interference-supplements-'));
  let child, log = '';
  const start = async () => {
    child = spawn(process.execPath, ['apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: '4319', VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: join(storage, 'missing-demo.mp4'), ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { log += chunk.toString(); }); child.stderr.on('data', chunk => { log += chunk.toString(); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`supplement worker failed: ${log}`);
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      await pause(25);
    }
    throw new Error(`supplement worker readiness timed out: ${log}`);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exiting = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Worker did not exit.')), 3500); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
    child.kill('SIGTERM'); assert.equal(await exiting, 0);
  };
  t.after(async () => { if (child?.exitCode === null) { try { await stop(); } catch { child.kill('SIGKILL'); } } await rm(storage, { recursive: true, force: true }); });
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  await start();
  const fixture = join(storage, 'source.mp4'); await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture]);
  const imported = await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'x-file-name': 'source.mp4' }, body: await readFile(fixture) }); assert.equal(imported.status, 201);
  const state = (await request('/api/state')).value, versionId = state.versions[0].id;
  const drawings = [{ id: 'where', kind: 'rect', color: '#FFFF00', points: [], region: { x: 0.2, y: 0.2, w: 0.4, h: 0.2 }, frame: 25 }, { id: 'later', kind: 'pen', color: '#00FF00', points: [{ x: 0.5, y: 0.6 }], frame: 70 }];
  const original = (await request('/api/comments', 'POST', { versionId, frameIn: 5, frameOut: 60, contextFrame: 25, text: '이 구간을 빠르게 넘겨줘', drawings: [drawings[0]] })).value;
  assert.deepEqual(original.drawings, [drawings[0]]);
  const beforeBadDrawing = (await request('/api/state')).value;
  for (const frame of [-1, 0.5, null, 90]) {
    assert.equal((await request('/api/comments', 'POST', { versionId, frameIn: 0, frameOut: 30, text: '잘못된 그림은 저장 불가', drawings: [{ ...drawings[0], frame }] })).status, 400);
    const unchanged = (await request('/api/state')).value; assert.deepEqual(unchanged.comments, beforeBadDrawing.comments); assert.deepEqual(unchanged.ops, beforeBadDrawing.ops);
  }
  const path = `/api/comments/${original.id}/supplements`;
  const initial = (await request(`/api/comments/${original.id}/interpret`, 'POST', {})).value; assert.ok(initial.clarification); assert.equal(initial.ops.length, 0);
  const first = await request(path, 'POST', { text: '  2배속  ' }); assert.equal(first.status, 200); assert.equal(first.value.status, 'received'); assert.equal(first.value.clarification, undefined); assert.equal(first.value.supplements[0].text, '2배속');
  assert.ok(first.value.supplements[0].id); assert.ok(first.value.supplements[0].createdAt);
  const interpreted = (await request(`/api/comments/${original.id}/interpret`, 'POST', {})).value; assert.equal(interpreted.ops.length, 1); assert.equal(interpreted.ops[0].params.factor, 2);
  const approved = await request(`/api/ops/${interpreted.ops[0].id}`, 'PATCH', { status: 'approved' }); assert.equal(approved.status, 200);
  const beforeInvalid = (await request('/api/state')).value;
  for (const input of [{ text: ' ' }, { text: 'x'.repeat(5001) }, { text: 2 }, { text: '새 원문', frameIn: 0 }, ['bad']]) {
    assert.equal((await request(path, 'POST', input)).status, 400);
    const unchanged = (await request('/api/state')).value; assert.deepEqual(unchanged.comments, beforeInvalid.comments); assert.deepEqual(unchanged.ops, beforeInvalid.ops);
  }
  const second = await request(path, 'POST', { text: '자막: 이어지는 배움' }); assert.equal(second.status, 200); assert.equal(second.value.status, 'received');
  assert.equal((await request('/api/state')).value.ops.length, 0, 'saved supplements invalidate the old approval rather than reinterpreting');
  for (const field of ['text', 'drawings', 'frameIn', 'frameOut', 'contextFrame', 'sourceRanges', 'createdAt']) assert.deepEqual(second.value[field], original[field]);
  assert.deepEqual(second.value.supplements[0], first.value.supplements[0]); assert.notEqual(second.value.supplements[1].id, second.value.supplements[0].id);
  const memo = (await request('/api/comments', 'POST', { versionId, frameIn: 0, text: '혼자 보는 메모', kind: 'note' })).value;
  assert.equal((await request(`/api/comments/${memo.id}/supplements`, 'POST', { text: '2배속은 나중에 생각' })).status, 200); assert.equal((await request(`/api/comments/${memo.id}/interpret`, 'POST', {})).status, 409);
  const multiDrawing = (await request('/api/comments', 'POST', { versionId, frameIn: 0, frameOut: 60, contextFrame: 25, text: '이 그림 그대로 영상에 넣어줘', drawings })).value;
  const beforePreparation = (await request('/api/state')).value;
  const prepared = await request(`/api/comments/${multiDrawing.id}/context-bundle`, 'POST', {}); assert.equal(prepared.status, 200); assert.equal(prepared.value.sceneCount, 5); assert.equal(prepared.value.drawingSceneCount, 2); assert.equal(prepared.value.attachmentCount, 0); assert.ok(prepared.value.archiveUrl);
  const manifestResponse = await fetch(`${base}${prepared.value.manifestUrl}`); assert.equal(manifestResponse.status, 200); const manifest = await manifestResponse.json();
  assert.equal(manifest.preparation, 'local-only'); assert.equal(manifest.modelCalled, false); assert.equal(manifest.networkUsed, false); assert.equal(manifest.externalConnection, 'not-connected'); assert.deepEqual(manifest.drawings, drawings);
  await validateHandoffManifest(manifest); assert.equal(manifest.feedback[0].authored.versionNumber, 1); assert.equal(manifest.feedback[0].current.status, 'present'); assert.equal(manifest.feedback[0].scenes.filter(scene => scene.annotatedFile).length, 2);
  for (const scene of manifest.sceneFrames) assert.equal((await fetch(`${base}${scene.mediaUrl}`, { method: 'HEAD' })).status, 200);
  const archiveResponse = await fetch(`${base}${prepared.value.archiveUrl}?download=1`); assert.equal(archiveResponse.status, 200); assert.match(archiveResponse.headers.get('content-type'), /application\/zip/);
  const archivePath = join(storage, 'downloaded-context.zip'); await writeFile(archivePath, Buffer.from(await archiveResponse.arrayBuffer()));
  const names = (await run('/usr/bin/unzip', ['-Z1', archivePath])).trim().split('\n'); assert.ok(names.includes('manifest.json') && names.includes('sheet.jpg')); assert.equal(names.length, manifest.files.length + 1); assert.deepEqual(names.filter(name => name !== 'manifest.json').sort(), manifest.files.map(file => file.path).sort());
  const afterPreparation = (await request('/api/state')).value; assert.deepEqual(afterPreparation.comments, beforePreparation.comments); assert.deepEqual(afterPreparation.ops, beforePreparation.ops); assert.deepEqual(afterPreparation.versions, beforePreparation.versions);
  const held = await request(`/api/comments/${multiDrawing.id}/interpret`, 'POST', {}); assert.equal(held.status, 200); assert.deepEqual(held.value.ops, []); assert.match(held.value.clarification, /한 장면/);
  const preservedMulti = await request(`/api/comments/${multiDrawing.id}/supplements`, 'POST', { text: '각 장면 표시를 참고 자료로 보관' }); assert.equal(preservedMulti.status, 200); assert.deepEqual(preservedMulti.value.drawings, drawings);
  const singleDrawing = (await request('/api/comments', 'POST', { versionId, frameIn: 0, frameOut: 30, contextFrame: 25, text: '이 그림 그대로 영상에 넣어줘', drawings: [drawings[0]] })).value;
  const singleOp = (await request(`/api/comments/${singleDrawing.id}/interpret`, 'POST', {})).value.ops[0]; assert.equal(singleOp.params.drawings[0].frame, 25);
  assert.equal((await request(`/api/ops/${singleOp.id}`, 'PATCH', { status: 'approved' })).status, 200);
  for (const [edited, expected] of [[drawings, 409], [[{ ...drawings[0], frame: 90 }], 400]]) {
    assert.equal((await request(`/api/ops/${singleOp.id}`, 'PATCH', { status: 'proposed', params: { drawings: edited } })).status, expected);
    const unchanged = (await request('/api/state')).value.ops.find(op => op.id === singleOp.id); assert.equal(unchanged.status, 'approved'); assert.deepEqual(unchanged.params.drawings, [drawings[0]]);
  }
  for (const [text, added, expected, confirmation, field, value] of [['2배속', '3배속', /서로 다른 배속/, '최종 3배속', 'factor', 3], ['자막: 처음', '자막: 다음', /서로 다른 자막 문구/, '최종 자막: 다음', 'text', '다음']]) {
    const conflict = (await request('/api/comments', 'POST', { versionId, frameIn: 0, text })).value;
    assert.equal((await request(`/api/comments/${conflict.id}/supplements`, 'POST', { text: added })).status, 200);
    const result = await request(`/api/comments/${conflict.id}/interpret`, 'POST', {}); assert.equal(result.status, 200); assert.deepEqual(result.value.ops, []); assert.match(result.value.clarification, expected); assert.equal(result.value.comment.status, 'needs_clarification');
    const confirmed = await request(`/api/comments/${conflict.id}/supplements`, 'POST', { text: confirmation }); assert.equal(confirmed.status, 200); assert.equal(confirmed.value.text, text); assert.equal(confirmed.value.supplements.length, 2);
    const resolved = await request(`/api/comments/${conflict.id}/interpret`, 'POST', {}); assert.equal(resolved.status, 200); assert.equal(resolved.value.clarification, undefined); assert.equal(resolved.value.ops.length, 1); assert.equal(resolved.value.ops[0].params[field], value);
  }
  const countLimited = (await request('/api/comments', 'POST', { versionId, frameIn: 0, text: '메모', kind: 'note' })).value;
  for (let index = 0; index < 20; index++) assert.equal((await request(`/api/comments/${countLimited.id}/supplements`, 'POST', { text: `생각 ${index}` })).status, 200);
  const counted = (await request('/api/state')).value.comments.find(item => item.id === countLimited.id);
  assert.equal((await request(`/api/comments/${countLimited.id}/supplements`, 'POST', { text: '21번째' })).status, 400); assert.deepEqual((await request('/api/state')).value.comments.find(item => item.id === countLimited.id), counted);
  const totalLimited = (await request('/api/comments', 'POST', { versionId, frameIn: 0, text: 'x'.repeat(5000), kind: 'note' })).value;
  for (let index = 0; index < 3; index++) assert.equal((await request(`/api/comments/${totalLimited.id}/supplements`, 'POST', { text: 'y'.repeat(5000) })).status, 200);
  const totalBefore = (await request('/api/state')).value.comments.find(item => item.id === totalLimited.id);
  assert.equal((await request(`/api/comments/${totalLimited.id}/supplements`, 'POST', { text: 'z' })).status, 400); assert.deepEqual((await request('/api/state')).value.comments.find(item => item.id === totalLimited.id), totalBefore);
  const beforeRestart = (await request('/api/state')).value; await stop(); await start(); const restored = (await request('/api/state')).value;
  assert.deepEqual(restored.comments, beforeRestart.comments); assert.deepEqual(restored.ops, beforeRestart.ops);
  const planned = (await request(`/api/comments/${original.id}/interpret`, 'POST', {})).value; assert.deepEqual(planned.ops.map(op => op.type), ['speed', 'subtitle']); assert.equal(planned.ops[1].params.text, '이어지는 배움');
  for (const op of planned.ops) assert.equal((await request(`/api/ops/${op.id}`, 'PATCH', { status: 'approved' })).status, 200);
  const rendered = await request('/api/render', 'POST', { parentVersionId: versionId, opIds: planned.ops.map(op => op.id) }); assert.equal(rendered.status, 202);
  let completed;
  for (let index = 0; index < 200; index++) { const job = (await request(`/api/jobs/${rendered.value.id}`)).value; if (job.status === 'completed') { completed = job; break; } assert.notEqual(job.status, 'failed', job.error); await pause(20); }
  assert.ok(completed);
  const afterRender = (await request('/api/state')).value; assert.equal((await request(path, 'POST', { text: '이미 적용한 요청 변경' })).status, 409); assert.deepEqual((await request('/api/state')).value.comments, afterRender.comments); assert.deepEqual((await request('/api/state')).value.ops, afterRender.ops);
});

await test('applied visual layers can be replaced or removed in a new immutable approved version', { timeout: 90_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'video-interference-layer-api-'));
  const child = spawn(process.execPath, ['apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: '4319', VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: join(storage, 'absent.mp4'), ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  t.after(async () => { child.kill('SIGTERM'); if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref(); }); await rm(storage, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(log);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (attempt === 99) throw new Error(`layer worker timed out: ${log}`); await pause(50);
  }
  const request = async (path, method = 'GET', value) => {
    const response = await fetch(`${base}${path}`, { method, ...(value === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) });
    return { status: response.status, value: await response.json() };
  };
  const source = join(storage, 'source.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  const imported = await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'x-file-name': 'layers.mp4', 'content-type': 'video/mp4' }, body: await readFile(source) }); assert.equal(imported.status, 201);
  const original = (await request('/api/state')).value.versions[0];
  assert.deepEqual((await request(`/api/versions/${original.id}/layers`)).value, { layers: [] });
  const propose = async (versionId, text, drawings, frameIn = 120, frameOut = 180) => {
    const comment = (await request('/api/comments', 'POST', { versionId, frameIn, frameOut, contextFrame: frameIn, text, drawings })).value;
    const result = await request(`/api/comments/${comment.id}/interpret`, 'POST', {}); assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value.ops[0];
  };
  const shape = color => [{ id: `shape-${color.slice(1)}`, kind: 'rect', color, fill: color, frame: 180, points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 }] }];
  const lower = await propose(original.id, '그림 그대로 영상에 넣어줘', shape('#FF0000'));
  const upper = await propose(original.id, '그림 그대로 영상에 넣어줘', shape('#0000FF'));
  const subtitle = await propose(original.id, '자막: 원래 문구');
  const speed = await propose(original.id, '2배속', undefined, 0, 210);
  const approve = async op => { const result = await request(`/api/ops/${op.id}`, 'PATCH', { status: 'approved' }); assert.equal(result.status, 200); };
  const waitJob = async id => { for (let index = 0; index < 500; index++) { const job = (await request(`/api/jobs/${id}`)).value; if (job.status === 'failed') throw new Error(job.error); if (job.status === 'completed') return job; await pause(50); } throw new Error('layer render timeout'); };
  for (const op of [lower, upper, subtitle, speed]) await approve(op);
  const start = await request('/api/render', 'POST', { parentVersionId: original.id, opIds: [lower.id, upper.id, subtitle.id, speed.id] }); assert.equal(start.status, 202);
  const firstJob = await waitJob(start.value.id), first = (await request('/api/state')).value.versions.find(item => item.id === firstJob.versionId);
  assert.equal(first.durationFrames, 105);
  const listed = (await request(`/api/versions/${first.id}/layers`)).value.layers;
  assert.deepEqual(listed.map(layer => layer.id), [lower.id, upper.id, subtitle.id]);
  assert.deepEqual(listed[0].outputRanges, [{ frameIn: 60, frameOut: 90 }]); assert.equal(listed[0].op.params.drawings[0].frame, 180);
  const parentHash = createHash('sha256').update(await readFile(join(storage, 'media', `${first.id}.mp4`))).digest('hex');
  const proposalUrl = id => `/api/versions/${first.id}/layers/${id}/changes`;
  const beforeBad = (await request('/api/state')).value;
  for (const value of [{ action: 'replace', params: { color: '#FFFFFF' } }, { action: 'remove', targetOpId: 'stale' }, { action: 'replace', targetOpId: lower.id, params: null }, { action: 'replace', targetOpId: lower.id, params: { color: 'red' } }, { action: 'remove', targetOpId: lower.id, params: {} }]) assert.ok((await request(proposalUrl(lower.id), 'POST', value)).status >= 400);
  assert.equal((await request(proposalUrl(speed.id), 'POST', { action: 'remove', targetOpId: speed.id })).status, 404);
  assert.equal((await request('/api/state')).value.comments.length, beforeBad.comments.length, 'invalid changes are atomic');
  assert.equal((await request(proposalUrl(lower.id), 'POST', { action: 'replace', targetOpId: lower.id, params: { text: 'x'.repeat(2_000_001) } })).status, 413);
  const imageBytes = await sharp({ create: { width: 24, height: 24, channels: 4, background: '#FFFF00' } }).png().toBuffer();
  const upload = async role => { const response = await fetch(`${base}/api/attachments`, { method: 'POST', headers: { 'x-file-name': 'replacement.png', 'x-asset-role': role, 'content-type': 'image/png' }, body: imageBytes }); assert.equal(response.status, 201); return response.json(); };
  const insertImage = await upload('insert'), referenceImage = await upload('reference');
  const invalidImage = await request(proposalUrl(lower.id), 'POST', { action: 'replace', targetOpId: lower.id, params: { kind: 'image', assetRef: referenceImage.id } }); assert.equal(invalidImage.status, 400);
  const imageProposal = await request(proposalUrl(lower.id), 'POST', { action: 'replace', targetOpId: lower.id, params: { kind: 'image', assetRef: insertImage.id } }); assert.equal(imageProposal.status, 201);
  assert.deepEqual(imageProposal.value.comment.attachmentIds, [insertImage.id]);
  assert.equal((await request(`/api/ops/${imageProposal.value.op.id}`, 'PATCH', { status: 'rejected' })).status, 200);
  const changed = await request(proposalUrl(lower.id), 'POST', { action: 'replace', targetOpId: lower.id, params: { kind: 'drawing', drawings: shape('#00FF00') } }); assert.equal(changed.status, 201);
  const replacement = changed.value.op;
  assert.equal(replacement.status, 'proposed'); assert.equal(replacement.interpreter, 'manual'); assert.equal(replacement.layerId, lower.id);
  assert.equal(replacement.params.drawings[0].frame, 60); assert.deepEqual(replacement.sourceRanges, lower.sourceRanges);
  assert.deepEqual(changed.value.comment.drawings, replacement.params.drawings); assert.deepEqual(changed.value.comment.sourceRanges, lower.sourceRanges);
  assert.equal((await request(`/api/comments/${changed.value.comment.id}/interpret`, 'POST', {})).status, 409);
  assert.equal((await request(`/api/comments/${changed.value.comment.id}/supplements`, 'POST', { text: '이 구간 삭제' })).status, 409);
  const removed = await request(proposalUrl(upper.id), 'POST', { action: 'remove', targetOpId: upper.id }); assert.equal(removed.status, 201);
  const removal = removed.value.op;
  assert.equal((await request(`/api/ops/${removal.id}`, 'PATCH', { status: 'proposed', params: { kind: 'text', text: 'wrong' } })).status, 409);
  assert.equal((await request(`/api/ops/${removal.id}`, 'PATCH', { status: 'proposed', layerChange: undefined, versionId: original.id })).status, 400);
  const textChange = await request(proposalUrl(subtitle.id), 'POST', { action: 'replace', targetOpId: subtitle.id, params: { text: '새 문구', color: '#FF00FF' } }); assert.equal(textChange.status, 201);
  for (const proposal of [changed.value, removed.value]) {
    const prepared = await request(`/api/comments/${proposal.comment.id}/context-bundle`, 'POST', {}); assert.equal(prepared.status, 200);
    const manifest = await (await fetch(`${base}${prepared.value.manifestUrl}`)).json();
    assert.deepEqual(manifest.layerChange, proposal.op.layerChange); assert.deepEqual(manifest.sourceRanges, proposal.op.sourceRanges);
    assert.equal(manifest.layerTarget.id, proposal.op.layerId); assert.equal(manifest.layerTarget.op.id, proposal.op.layerChange.targetOpId);
    assert.deepEqual(manifest.proposedOperations, [proposal.op]); assert.equal(manifest.layerTarget.op.params.drawings[0].frame, 180);
    assert.equal(manifest.proposedOperations[0].params.drawings[0].frame, 60);
    assert.equal(manifest.networkUsed, false); assert.equal(manifest.modelCalled, false);
    assert.ok(prepared.value.archiveUrl);
  }

  const adjustedDrawings = replacement.params.drawings.map(drawing => ({ ...drawing, color: '#00FFFF', fill: '#00FFFF' }));
  assert.equal((await request(`/api/ops/${replacement.id}`, 'PATCH', { status: 'proposed', params: { drawings: adjustedDrawings } })).status, 200);
  const adjustedBundle = (await request(`/api/comments/${changed.value.comment.id}/context-bundle`, 'POST', {})).value;
  const adjustedManifest = await (await fetch(`${base}${adjustedBundle.manifestUrl}`)).json();
  assert.equal(adjustedManifest.drawingsRole, 'original-request-annotations'); assert.equal(adjustedManifest.drawings[0].color, '#00FF00');
  assert.equal(adjustedManifest.proposedOperationsRole, 'current-edit-proposals'); assert.equal(adjustedManifest.proposedOperations[0].params.drawings[0].color, '#00FFFF');
  await approve(replacement);
  const edited = await request(`/api/ops/${replacement.id}`, 'PATCH', { status: 'approved', params: { kind: 'drawing', drawings: replacement.params.drawings } }); assert.equal(edited.value.status, 'proposed');
  assert.equal((await request('/api/render', 'POST', { parentVersionId: first.id, opIds: [replacement.id] })).status, 400);
  const duplicate = (await request(proposalUrl(lower.id), 'POST', { action: 'remove', targetOpId: lower.id })).value.op;
  for (const op of [replacement, removal, textChange.value.op, duplicate]) await approve(op);
  assert.equal((await request('/api/render', 'POST', { parentVersionId: first.id, opIds: [replacement.id, duplicate.id] })).status, 409);
  const secondStart = await request('/api/render', 'POST', { parentVersionId: first.id, opIds: [replacement.id, removal.id, textChange.value.op.id] }); assert.equal(secondStart.status, 202);
  assert.equal((await request(`/api/ops/${removal.id}`, 'PATCH', { status: 'rejected' })).status, 409, 'removal is locked through appliedOpIds although absent from the effective snapshot');
  const secondJob = await waitJob(secondStart.value.id), after = (await request('/api/state')).value;
  const second = after.versions.find(item => item.id === secondJob.versionId);
  assert.deepEqual(second.appliedOpIds, [replacement.id, removal.id, textChange.value.op.id]);
  assert.deepEqual(second.opIds, [replacement.id, textChange.value.op.id, speed.id]); assert.equal(after.ops.find(item => item.id === removal.id).status, 'applied');
  const secondLayers = (await request(`/api/versions/${second.id}/layers`)).value.layers;
  assert.deepEqual(secondLayers.map(layer => layer.id), [lower.id, subtitle.id]); assert.equal(secondLayers[0].op.id, replacement.id);
  assert.deepEqual((await request(`/api/versions/${first.id}/layers`)).value.layers, listed, 'parent snapshot remains byte-equivalent as data');
  assert.equal(createHash('sha256').update(await readFile(join(storage, 'media', `${first.id}.mp4`))).digest('hex'), parentHash);
  assert.equal((await request(`/api/versions/${second.id}/layers/${lower.id}/changes`, 'POST', { action: 'remove', targetOpId: lower.id })).status, 409, 'stable ID alone cannot target a stale layer revision');
  const cut = await propose(second.id, '이 구간 삭제', undefined, 60, 90); await approve(cut);
  const cutStart = await request('/api/render', 'POST', { parentVersionId: second.id, opIds: [cut.id] }); assert.equal(cutStart.status, 202);
  const cutJob = await waitJob(cutStart.value.id), hidden = (await request(`/api/versions/${cutJob.versionId}/layers`)).value.layers;
  assert.ok(hidden.every(layer => layer.outputRanges.length === 0));
  assert.equal((await request(`/api/versions/${cutJob.versionId}/layers/${lower.id}/changes`, 'POST', { action: 'remove', targetOpId: replacement.id })).status, 409);
});

await test('filmstrip API deduplicates lazy work, persists cache and yields to rendering, import and shutdown', { timeout: 60_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'video-interference-filmstrip-api-'));
  const wrapper = join(storage, 'ffmpeg-wrapper.sh'), hold = join(storage, 'hold-filmstrip'), calls = join(storage, 'filmstrip-calls');
  await writeFile(wrapper, '#!/bin/sh\ncase "$*" in\n  *".filmstrip-"*)\n    echo started >> "$VI_TEST_FILMSTRIP_CALLS"\n    trap \'exit 143\' TERM INT\n    while test -f "$VI_TEST_FILMSTRIP_HOLD"; do sleep 0.05; done\n    ;;\nesac\nexec "$VI_TEST_REAL_FFMPEG" "$@"\n'); await chmod(wrapper, 0o755);
  const children = []; let log = '';
  const startWorker = async () => {
    const child = spawn(process.execPath, ['apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: '4319', VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: join(storage, 'missing.mp4'), FFMPEG_PATH: wrapper, VI_TEST_REAL_FFMPEG: ffmpegPath, VI_TEST_FILMSTRIP_HOLD: hold, VI_TEST_FILMSTRIP_CALLS: calls, ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(`${base}/api/health`)).ok) return child; } catch {} await pause(50); }
    throw new Error(`filmstrip worker readiness timed out: ${log}`);
  };
  const stop = async child => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM'); await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('filmstrip shutdown timed out')); }, 3000); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`worker exit ${code}: ${log}`)); }); });
  };
  t.after(async () => { await rm(hold, { force: true }); for (const child of children) { if (child.exitCode === null) await stop(child); } await rm(storage, { recursive: true, force: true }); });
  let child = await startWorker();
  const request = async (path, method = 'GET', value) => { const response = await fetch(`${base}${path}`, { method, ...(value === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) }); return { status: response.status, value: await response.json() }; };
  const source = join(storage, 'source.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  const sourceBytes = await readFile(source);
  const importVideo = () => fetch(`${base}/api/assets`, { method: 'POST', headers: { 'x-file-name': 'filmstrip.mp4', 'content-type': 'video/mp4' }, body: sourceBytes });
  assert.equal((await importVideo()).status, 201);
  const firstState = (await request('/api/state')).value, original = firstState.versions[0];
  assert.equal((await request('/api/versions/no-such-version/filmstrip')).status, 404);
  const countCalls = async () => { try { return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  const waitCalls = async expected => { for (let index = 0; index < 100; index++) { if (await countCalls() === expected) return; await pause(20); } throw new Error(`filmstrip native call count did not reach ${expected}: ${log}`); };
  await writeFile(hold, 'hold');
  const firstPromise = request(`/api/versions/${original.id}/filmstrip`); await waitCalls(1);
  const duplicatePromise = request(`/api/versions/${original.id}/filmstrip`); await pause(50);
  assert.equal(await countCalls(), 1, 'two requests share the same native decode');
  await rm(hold); const [first, duplicate] = await Promise.all([firstPromise, duplicatePromise]);
  assert.equal(first.status, 200); assert.deepEqual(duplicate, first);
  assert.equal(first.value.versionId, original.id); assert.equal(first.value.durationFrames, 90); assert.equal(first.value.cellWidth, 160); assert.equal(first.value.cellHeight, 90); assert.equal(first.value.frames.length, 12);
  const spriteResponse = await fetch(`${base}${first.value.imageUrl}`); assert.equal(spriteResponse.status, 200); assert.equal(spriteResponse.headers.get('content-type'), 'image/png');
  const sprite = Buffer.from(await spriteResponse.arrayBuffer()); const metadata = await sharp(sprite).metadata(); assert.equal(metadata.width, 1920); assert.equal(metadata.height, 90);
  assert.deepEqual((await request(`/api/versions/${original.id}/filmstrip`)).value, first.value); assert.equal(await countCalls(), 1);
  const persisted = (await request('/api/state')).value; assert.deepEqual(persisted.versions, firstState.versions); assert.deepEqual(persisted.comments, firstState.comments);
  await stop(child); child = await startWorker();
  assert.deepEqual((await request(`/api/versions/${original.id}/filmstrip`)).value, first.value); assert.equal(await countCalls(), 1, 'persistent cache survives worker restart');
  const propose = async (versionId, text, frameIn, frameOut) => { const comment = (await request('/api/comments', 'POST', { versionId, text, frameIn, frameOut })).value; const op = (await request(`/api/comments/${comment.id}/interpret`, 'POST', {})).value.ops[0]; assert.equal((await request(`/api/ops/${op.id}`, 'PATCH', { status: 'approved' })).status, 200); return op; };
  const waitJob = async id => { for (let index = 0; index < 200; index++) { const job = (await request(`/api/jobs/${id}`)).value; if (job.status === 'failed') throw new Error(job.error); if (job.status === 'completed') return job; await pause(25); } throw new Error('render timeout'); };
  const cut = await propose(original.id, '이 구간 삭제', 30, 60);
  const renderStart = (await request('/api/render', 'POST', { parentVersionId: original.id, opIds: [cut.id] })).value;
  const cutJob = await waitJob(renderStart.id);
  const speed = await propose(cutJob.versionId, '2배속', 0, 60);
  await writeFile(hold, 'hold'); const cutStrip = request(`/api/versions/${cutJob.versionId}/filmstrip`); await waitCalls(2);
  const nextStart = await request('/api/render', 'POST', { parentVersionId: cutJob.versionId, opIds: [speed.id] }); assert.equal(nextStart.status, 202);
  assert.equal((await cutStrip).status, 409, 'render preempts an in-flight optional thumbnail decode');
  assert.deepEqual((await request(`/api/versions/${original.id}/filmstrip`)).value, first.value, 'completed cache remains usable while rendering');
  const speedJob = await waitJob(nextStart.value.id);
  const speedStrip = request(`/api/versions/${speedJob.versionId}/filmstrip`); await waitCalls(3);
  assert.equal((await importVideo()).status, 201); assert.equal((await speedStrip).status, 409, 'import preempts thumbnails from the old workspace');
  assert.equal((await request(`/api/versions/${speedJob.versionId}/filmstrip`)).status, 404);
  const newVersion = (await request('/api/state')).value.versions[0];
  const stoppedStrip = request(`/api/versions/${newVersion.id}/filmstrip`).catch(error => ({ disconnected: true, message: error.message })); await waitCalls(4);
  await stop(child); await stoppedStrip;
  assert.ok((await readdir(join(storage, 'filmstrips'))).every(name => !name.startsWith('.filmstrip-')), 'shutdown drains native work and removes partial sprites');
  await rm(hold); child = await startWorker();
  const retried = await request(`/api/versions/${newVersion.id}/filmstrip`); assert.equal(retried.status, 200); assert.equal(await countCalls(), 5, 'canceled work can be regenerated after restart');
});

await test('feedback handoff exports authored scenes, annotations and portable attachments without including videos', { timeout: 90_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'video-interference-feedback-api-')), hold = join(storage, 'hold-export'), calls = join(storage, 'export-calls'), wrapper = join(storage, 'ffmpeg.sh');
  await writeFile(wrapper, '#!/bin/sh\ncase "$*" in\n  *".feedback-export-"*)\n    echo started >> "$VI_EXPORT_CALLS"\n    trap \'exit 143\' TERM INT\n    while test -f "$VI_EXPORT_HOLD"; do sleep 0.05; done\n    ;;\nesac\nexec "$VI_REAL_FFMPEG" "$@"\n'); await chmod(wrapper, 0o755);
  const child = spawn(process.execPath, ['apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: '4319', VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: join(storage, 'missing.mp4'), FFMPEG_PATH: wrapper, VI_REAL_FFMPEG: ffmpegPath, VI_EXPORT_HOLD: hold, VI_EXPORT_CALLS: calls, ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  t.after(async () => { await rm(hold, { force: true }); child.kill('SIGTERM'); if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref(); }); await rm(storage, { recursive: true, force: true }); });
  for (let index = 0; index < 100; index++) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} if (index === 99) throw new Error(log); await pause(50); }
  const request = async (path, method = 'GET', value) => { const response = await fetch(`${base}${path}`, { method, ...(value === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) }); return { status: response.status, value: await response.json() }; };
  const source = join(storage, 'with-audio.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  const sourceBytes = await readFile(source), sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const importVideo = () => fetch(`${base}/api/assets`, { method: 'POST', headers: { 'x-file-name': 'feedback-source.mp4', 'content-type': 'video/mp4' }, body: sourceBytes });
  assert.equal((await importVideo()).status, 201); const original = (await request('/api/state')).value.versions[0];
  assert.equal((await request('/api/feedback-exports', 'POST', { versionId: original.id })).status, 409);
  const descriptionOnly = { versionId: original.id, frameIn: 0, frameOut: 1, text: '', sceneDescription: '첫 장면에 제목 카드가 보인다.' };
  assert.equal((await request('/api/comments', 'POST', descriptionOnly)).status, 400, 'scene description alone is not an editing request');
  const noteResponse = await request('/api/comments', 'POST', { ...descriptionOnly, kind: 'note' }); assert.equal(noteResponse.status, 201); const note = noteResponse.value;
  assert.equal(note.sceneDescription, descriptionOnly.sceneDescription); assert.equal(note.text, '');
  for (const sceneDescription of ['x'.repeat(501), 12, null]) assert.equal((await request('/api/comments', 'POST', { ...descriptionOnly, kind: 'note', sceneDescription })).status, 400);
  const upload = async (role, name, bytes, mime) => { const response = await fetch(`${base}/api/attachments`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent(name), 'x-asset-role': role, 'content-type': mime }, body: bytes }); assert.equal(response.status, 201); return response.json(); };
  const image = await upload('reference', '공유 참고.png', await sharp({ create: { width: 80, height: 80, channels: 4, background: '#FFFF00' } }).png().toBuffer(), 'image/png');
  const voice = await upload('voice', '말로 남긴 원본 영상.mp4', sourceBytes, 'video/mp4');
  const drawings = [{ id: 'request-shape', frame: 45, kind: 'rect', color: '#FF0000', fill: '#FF0000', points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 }] }];
  const feedback = (await request('/api/comments', 'POST', { versionId: original.id, frameIn: 30, frameOut: 60, contextFrame: 45, text: '여기에 설명 자막을 넣어 주세요.', sceneDescription: '진행자가 화면 왼쪽 영역을 가리킨다.', drawings, attachmentIds: [image.id], voiceAssetId: voice.id })).value;
  const shared = (await request('/api/comments', 'POST', { versionId: original.id, frameIn: 60, frameOut: 90, text: '이 장면은 참고 이미지 색감을 검토해 주세요.', attachmentIds: [image.id] })).value;
  const cutComment = (await request('/api/comments', 'POST', { versionId: original.id, frameIn: 30, frameOut: 60, text: '이 구간 삭제' })).value;
  const cut = (await request(`/api/comments/${cutComment.id}/interpret`, 'POST', {})).value.ops[0]; await request(`/api/ops/${cut.id}`, 'PATCH', { status: 'approved' });
  const render = (await request('/api/render', 'POST', { parentVersionId: original.id, opIds: [cut.id] })).value;
  let target;
  for (let index = 0; index < 200; index++) { const job = (await request(`/api/jobs/${render.id}`)).value; if (job.status === 'failed') throw new Error(job.error); if (job.status === 'completed') { target = (await request('/api/state')).value.versions.find(version => version.id === job.versionId); break; } await pause(25); }
  assert.ok(target);
  for (const body of [{ versionId: target.id, commentIds: [] }, { versionId: target.id, commentIds: [feedback.id, feedback.id] }, { versionId: target.id, unexpected: true }]) assert.equal((await request('/api/feedback-exports', 'POST', body)).status, 400);
  assert.equal((await request('/api/feedback-exports', 'POST', { versionId: target.id, commentIds: ['missing'] })).status, 404);
  const exportBody = { versionId: target.id, commentIds: [feedback.id, note.id, shared.id] };
  const countCalls = async () => { try { return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  await writeFile(hold, 'hold'); const pending = request('/api/feedback-exports', 'POST', exportBody);
  for (let index = 0; index < 100 && await countCalls() !== 1; index++) await pause(20); assert.equal(await countCalls(), 1);
  const duplicate = request('/api/feedback-exports', 'POST', { ...exportBody, commentIds: [...exportBody.commentIds].reverse() });
  await pause(30); assert.equal(await countCalls(), 1, 'duplicate selection order does not repeat authored-video decoding');
  assert.equal((await importVideo()).status, 409, 'an export snapshot cannot be replaced by an import');
  const supplement = await request(`/api/comments/${feedback.id}/supplements`, 'POST', { text: '자료 준비 이후 추가한 설명' }); assert.equal(supplement.status, 200);
  await rm(hold); const first = await pending, second = await duplicate;
  assert.equal(first.status, 200); assert.deepEqual(second, first); assert.equal(first.value.commentCount, 3);
  const manifest = await (await fetch(`${base}${first.value.manifestUrl}`)).json(); const markdown = await (await fetch(`${base}${first.value.markdownUrl}`)).text();
  assert.equal(manifest.localOnly, true); assert.equal(manifest.sourceVideoIncluded, false); assert.equal(manifest.renderedVideoIncluded, false); assert.equal(manifest.networkUsed, false); assert.equal(manifest.modelCalled, false);
  const deleted = manifest.feedback.find(entry => entry.id === feedback.id); assert.equal(deleted.current.status, 'deleted'); assert.equal(deleted.current.contextFrame, null); assert.deepEqual(deleted.current.ranges, []); assert.equal(deleted.authored.contextFrame, 45); assert.deepEqual(deleted.current.deletedSourceRanges, [{ frameIn: 30, frameOut: 60 }]);
  assert.equal(deleted.feedback.supplements.length, 0, 'in-flight export stays on its initial immutable request snapshot');
  assert.equal(deleted.sceneDescription.text, feedback.sceneDescription); assert.ok(deleted.scenes.some(scene => scene.frame === 45 && scene.annotatedFile));
  assert.equal(manifest.stats.attachmentCount, 2, 'shared reference file is copied once'); assert.equal(manifest.diagnostics.stillRuns, 1);
  assert.equal(manifest.diagnostics.shotSource, 'render', 'scene cuts measured while rendering the target version are reused');
  assert.equal(manifest.diagnostics.overviewRuns, 1, 'the overview only seeks its grid frames; no second full decode of the video'); await validateHandoffManifest(manifest);
  assert.equal(manifest.overview.versionId, target.id); assert.equal(manifest.overview.shots.list.at(-1).frameOut, target.durationFrames);
  const jsonlResponse = await fetch(`${base}${first.value.jsonlUrl}`), vttResponse = await fetch(`${base}${first.value.vttUrl}`);
  assert.match(jsonlResponse.headers.get('content-type'), /ndjson/); assert.match(vttResponse.headers.get('content-type'), /text\/vtt/);
  const jsonl = (await jsonlResponse.text()).trim().split('\n').map(line => JSON.parse(line)); assert.equal(jsonl.length, 4); assert.deepEqual(jsonl.slice(1).map(line => line.id), manifest.feedback.map(entry => entry.id));
  assert.match(jsonl.find(line => line.id === feedback.id).drawings[0].where, /화면 왼쪽 위/); assert.ok((await vttResponse.text()).startsWith('WEBVTT'));
  assert.match(markdown, /검토 가능한 시간별 피드백 브리프/); assert.match(markdown, /현재 버전에서 삭제된 구간/); assert.match(markdown, /자동 영상 분석 결과가 아닙니다/); assert.ok(markdown.includes(feedback.sceneDescription));
  const archive = join(storage, 'handoff.zip'); await writeFile(archive, Buffer.from(await (await fetch(`${base}${first.value.archiveUrl}?download=1`)).arrayBuffer()));
  const names = (await run('/usr/bin/unzip', ['-Z1', archive])).trim().split('\n'); assert.ok(['feedback.md', 'feedback.jsonl', 'feedback.vtt', 'manifest.json'].every(name => names.includes(name))); assert.equal(names.length, manifest.files.length + 4); assert.ok(names.every(name => !name.startsWith('/') && !name.includes('..') && !/\.(mp4|mov|webm|mkv|avi)$/i.test(name)));
  const unpacked = join(storage, 'unpacked'); await run('/usr/bin/unzip', ['-q', archive, '-d', unpacked]);
  const audio = manifest.files.find(file => file.mimeType === 'audio/mp4'); assert.ok(audio);
  const voiceInfo = JSON.parse(await run(ffprobePath, ['-v', 'error', '-show_streams', '-of', 'json', join(unpacked, audio.path)])); assert.ok(voiceInfo.streams.every(stream => stream.codec_type === 'audio'), 'a video uploaded as a voice memo exports audio only');
  for (const file of manifest.files) assert.equal(createHash('sha256').update(await readFile(join(unpacked, file.path))).digest('hex'), file.sha256);
  const newer = await request('/api/feedback-exports', 'POST', exportBody); assert.equal(newer.status, 200); assert.notEqual(newer.value.archiveUrl, first.value.archiveUrl); assert.equal(await countCalls(), 1, 'a text-only change re-exports from cached stills without decoding again');
  const newerManifest = await (await fetch(`${base}${newer.value.manifestUrl}`)).json(); assert.equal(newerManifest.diagnostics.stillRuns, 0); assert.equal(newerManifest.diagnostics.stillCacheHits, newerManifest.stats.sceneCount);
  assert.deepEqual(newerManifest.files.filter(file => file.role === 'scene').map(file => file.sha256), manifest.files.filter(file => file.role === 'scene').map(file => file.sha256), 'cached stills are byte-identical to the first extraction'); assert.equal(newerManifest.feedback.find(entry => entry.id === feedback.id).feedback.supplements[0].text, '자료 준비 이후 추가한 설명');
  assert.deepEqual((await request('/api/feedback-exports', 'POST', exportBody)).value, newer.value); assert.equal(await countCalls(), 1, 'unchanged snapshot reuses the complete ZIP');
  const all = await request('/api/feedback-exports', 'POST', { versionId: target.id }); assert.equal(all.status, 200); assert.equal(all.value.commentCount, (await request('/api/state')).value.comments.length, 'default includes all feedback and notes');
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), sourceHash);
});

await test('feedback edit, trash and restore preserve materials, invalidate approvals and leave rendered history immutable', { timeout: 90_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'video-interference-feedback-mutations-'));
  let child, log = '';
  const start = async () => {
    child = spawn(process.execPath, ['apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: '4319', VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: join(storage, 'missing.mp4'), ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    for (let index = 0; index < 100; index++) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {} await pause(30); }
    throw new Error(`Feedback mutation worker did not start: ${log}`);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const done = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Worker did not stop')), 3500); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
    child.kill('SIGTERM'); assert.equal(await done, 0);
  };
  t.after(async () => { if (child?.exitCode === null) { try { await stop(); } catch { child.kill('SIGKILL'); } } await rm(storage, { recursive: true, force: true }); });
  const request = async (path, method = 'GET', body) => { const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() }; };
  const persisted = () => { const db = new DatabaseSync(join(storage, 'project.sqlite'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT data FROM workspace WHERE id = 1').get().data); } finally { db.close(); } };
  await start();
  const source = join(storage, 'source.mp4'); await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  const bytes = await readFile(source);
  assert.equal((await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'x-file-name': 'source.mp4' }, body: bytes })).status, 201);
  const versionId = (await request('/api/state')).value.versions[0].id;
  const upload = async (role, name, body) => { const response = await fetch(`${base}/api/attachments`, { method: 'POST', headers: { 'x-file-name': name, 'x-asset-role': role }, body }); assert.equal(response.status, 201); return response.json(); };
  const image = await upload('reference', 'reference.png', await sharp({ create: { width: 40, height: 40, channels: 4, background: '#FFFF00' } }).png().toBuffer());
  const voice = await upload('voice', 'voice.mp4', bytes);
  // Picked voice files (not only browser recordings) are normalized to AAC like recordings.
  for (const name of ['memo.wav', 'memo.m4a']) {
    const audioPath = join(storage, name); await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', audioPath]);
    const attached = await upload('voice', name, await readFile(audioPath));
    assert.equal(attached.mimeType, 'audio/mp4'); assert.equal((await fetch(`${base}${attached.mediaUrl}`)).headers.get('content-type'), 'audio/mp4');
  }
  // Review markers are per-version bookmarks; repeated presses on one frame keep one marker.
  const marker = (await request('/api/markers', 'POST', { versionId, frame: 30 })).value;
  assert.equal(marker.frame, 30); assert.equal((await request('/api/markers', 'POST', { versionId, frame: 30 })).value.id, marker.id);
  for (const body of [{ versionId, frame: -1 }, { versionId, frame: 1.5 }, { versionId, frame: 90 }, { versionId, frame: 1, text: 'x' }]) assert.equal((await request('/api/markers', 'POST', body)).status, 400);
  assert.equal((await request('/api/markers', 'POST', { versionId: 'missing', frame: 1 })).status, 404);
  assert.deepEqual((await request('/api/state')).value.markers, [marker]);
  assert.equal((await request(`/api/markers/${marker.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/api/markers/${marker.id}`, 'DELETE')).status, 404);
  assert.deepEqual((await request('/api/state')).value.markers, []);
  const drawing = { id: 'saved-drawing', kind: 'rect', color: '#FFFF00', points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 }], frame: 15 };
  const original = (await request('/api/comments', 'POST', { versionId, frameIn: 10, frameOut: 40, contextFrame: 15, category: 'subtitle', text: '2배속', sceneDescription: '첫 장면', drawings: [drawing], attachmentIds: [image.id], voiceAssetId: voice.id })).value;
  assert.equal((await request('/api/comments', 'POST', { versionId, frameIn: 0, text: '잘못된 분야', category: 'unknown' })).status, 400);
  const path = `/api/comments/${original.id}`;
  const supplemented = (await request(`${path}/supplements`, 'POST', { text: '2배속으로 부탁해' })).value;
  const initialOp = (await request(`${path}/interpret`, 'POST', {})).value.ops[0]; assert.ok(initialOp);
  await request(`/api/ops/${initialOp.id}`, 'PATCH', { status: 'approved' });
  const approved = (await request('/api/state')).value;
  assert.equal((await request(path, 'PATCH', { text: original.text, sceneDescription: original.sceneDescription })).status, 200);
  assert.deepEqual((await request('/api/state')).value, approved, 'no-op save must keep approval and avoid a false revision');
  for (const patch of [{}, { text: null }, { text: 'x'.repeat(5001) }, { sceneDescription: null }, { sceneDescription: 'x'.repeat(501) }, { text: '새 문구', frameIn: 0 }, { drawings: [] }, { category: 'invalid' }, { category: null }]) {
    assert.equal((await request(path, 'PATCH', patch)).status, 400); assert.deepEqual((await request('/api/state')).value, approved);
  }
  assert.equal(original.category, 'subtitle');
  const anchorsBefore = { frameIn: original.frameIn, frameOut: original.frameOut, sourceRanges: original.sourceRanges };
  for (const category of ['video', 'subtitle', 'audio', 'effect']) {
    const categorized = await request(path, 'PATCH', { category }); assert.equal(categorized.status, 200);
    assert.equal(categorized.value.category, category);
    assert.equal(categorized.value.updatedAt, original.updatedAt);
    assert.deepEqual(categorized.value.revisions, original.revisions, 'category-only edits do not rewrite content history');
    assert.deepEqual({ frameIn: categorized.value.frameIn, frameOut: categorized.value.frameOut, sourceRanges: categorized.value.sourceRanges }, anchorsBefore);
    assert.deepEqual((await request('/api/state')).value.ops, approved.ops, 'choosing a pin color must preserve approval');
  }
  const edited = await request(path, 'PATCH', { text: '  3배속  ', sceneDescription: '  진행자가 등장  ' }); assert.equal(edited.status, 200);
  assert.equal(edited.value.text, '3배속'); assert.equal(edited.value.sceneDescription, '진행자가 등장'); assert.equal(edited.value.status, 'received'); assert.ok(edited.value.updatedAt);
  assert.equal(edited.value.revisions.length, 1); assert.equal(edited.value.revisions[0].text, original.text); assert.equal(edited.value.revisions[0].sceneDescription, original.sceneDescription);
  for (const key of ['id', 'versionId', 'frameIn', 'frameOut', 'contextFrame', 'kind', 'drawings', 'attachmentIds', 'voiceAssetId', 'sourceRanges', 'createdAt', 'supplements']) assert.deepEqual(edited.value[key], supplemented[key], `${key} must survive a text edit`);
  assert.equal((await request('/api/state')).value.ops.length, 0); assert.equal((await request(`/api/ops/${initialOp.id}`, 'PATCH', { status: 'approved' })).status, 404);
  const brief = await request('/api/feedback-exports', 'POST', { versionId, commentIds: [original.id] }); assert.equal(brief.status, 200);
  const briefBefore = await (await fetch(`${base}${brief.value.manifestUrl}`)).text(); assert.equal(JSON.parse(briefBefore).feedback[0].feedback.original, '3배속'); assert.equal(JSON.parse(briefBefore).feedback[0].category, 'effect');
  assert.match(await (await fetch(`${base}${brief.value.markdownUrl}`)).text(), /분야: 효과/);
  const textOnly = (await request('/api/comments', 'POST', { versionId, frameIn: 0, text: '2배속' })).value;
  assert.equal((await request(`/api/comments/${textOnly.id}`, 'PATCH', { text: '', sceneDescription: '설명만 남김' })).status, 400, 'a request must retain feedback, not merely its scene');
  const memo = (await request('/api/comments', 'POST', { versionId, frameIn: 45, kind: 'note', text: '참고', sceneDescription: '메모 장면' })).value;
  assert.equal((await request(`/api/comments/${memo.id}`, 'PATCH', { text: '' })).status, 200, 'a scene-only note remains useful');
  assert.equal((await request(`/api/comments/${memo.id}`, 'PATCH', { sceneDescription: '' })).status, 400, 'a note cannot lose its last content');
  const deleteOp = (await request(`/api/comments/${textOnly.id}/interpret`, 'POST', {})).value.ops[0]; await request(`/api/ops/${deleteOp.id}`, 'PATCH', { status: 'approved' });
  const deleted = await request(`/api/comments/${textOnly.id}`, 'DELETE'); assert.equal(deleted.status, 200); assert.ok(deleted.value.deletedAt);
  assert.equal((await request('/api/render', 'POST', { parentVersionId: versionId, opIds: [deleteOp.id] })).status, 400);
  assert.equal((await request(`/api/ops/${deleteOp.id}`, 'PATCH', { status: 'approved' })).status, 404);
  assert.equal((await request(path, 'DELETE')).status, 200);
  for (const suffix of ['/interpret', '/context-bundle', '/supplements']) assert.equal((await request(`${path}${suffix}`, 'POST', { text: '삭제 후 지시' })).status, 404);
  assert.equal((await request(path, 'PATCH', { text: '삭제 후 수정' })).status, 404);
  assert.equal((await request('/api/feedback-exports', 'POST', { versionId, commentIds: [original.id, memo.id] })).status, 404);
  const all = await request('/api/feedback-exports', 'POST', { versionId }); assert.equal(all.status, 200); assert.equal(all.value.commentCount, 1);
  assert.equal(await (await fetch(`${base}${brief.value.manifestUrl}`)).text(), briefBefore, 'a previously exported immutable snapshot stays unchanged');
  const beforeRestart = (await request('/api/state')).value; assert.deepEqual(beforeRestart.deletedComments.map(comment => comment.id).sort(), [original.id, textOnly.id].sort());
  await stop(); await start(); assert.deepEqual((await request('/api/state')).value, beforeRestart, 'trash and revision history survive restart');
  assert.equal((await request(`${path}/restore`, 'POST', {})).status, 200); const restored = (await request(`/api/comments/${textOnly.id}/restore`, 'POST', {})).value; assert.equal(restored.status, 'received'); assert.equal(restored.deletedAt, undefined);
  assert.equal((await request('/api/state')).value.ops.length, 0, 'restoring feedback does not restore its stale approval');
  assert.deepEqual((await request('/api/state')).value.comments.find(comment => comment.id === original.id), edited.value);
  const subtitle = (await request('/api/comments', 'POST', { versionId, frameIn: 0, frameOut: 60, text: '자막: 보존할 자막' })).value;
  const subtitleOp = (await request(`/api/comments/${subtitle.id}/interpret`, 'POST', {})).value.ops[0]; await request(`/api/ops/${subtitleOp.id}`, 'PATCH', { status: 'approved' });
  const render = (await request('/api/render', 'POST', { parentVersionId: versionId, opIds: [subtitleOp.id] })).value;
  let finished;
  for (let index = 0; index < 200; index++) { const job = (await request(`/api/jobs/${render.id}`)).value; assert.notEqual(job.status, 'failed', job.error); if (job.status === 'completed') { finished = job; break; } await pause(25); }
  assert.ok(finished);
  const history = persisted(), output = history.files[render.versionId].path, outputHash = createHash('sha256').update(await readFile(output)).digest('hex');
  assert.equal((await request(`/api/comments/${subtitle.id}`, 'PATCH', { text: '이미 적용한 문구 수정' })).status, 409);
  assert.equal((await request(`/api/comments/${subtitle.id}`, 'DELETE')).status, 200); assert.ok(!(await request('/api/state')).value.ops.some(op => op.id === subtitleOp.id));
  assert.deepEqual(persisted().snapshots, history.snapshots); assert.deepEqual(persisted().state.versions, history.state.versions); assert.equal(createHash('sha256').update(await readFile(output)).digest('hex'), outputHash);
  const appliedRestored = (await request(`/api/comments/${subtitle.id}/restore`, 'POST', {})).value; assert.equal(appliedRestored.status, 'applied'); assert.equal((await request('/api/state')).value.ops.find(op => op.id === subtitleOp.id).status, 'applied');
  const layer = (await request(`/api/versions/${render.versionId}/layers`)).value.layers[0];
  const change = (await request(`/api/versions/${render.versionId}/layers/${layer.id}/changes`, 'POST', { action: 'replace', targetOpId: layer.op.id, params: { text: '다음 자막' } })).value;
  await request(`/api/ops/${change.op.id}`, 'PATCH', { status: 'approved' });
  assert.equal((await request(`/api/comments/${change.comment.id}`, 'PATCH', { text: '문구로 바꾸기' })).status, 409);
  assert.equal((await request(`/api/comments/${change.comment.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/api/ops/${change.op.id}`, 'PATCH', { status: 'approved' })).status, 404);
  assert.equal((await request(`/api/comments/${change.comment.id}/restore`, 'POST', {})).status, 200);
  const finalState = (await request('/api/state')).value; assert.equal(finalState.ops.find(op => op.id === change.op.id).status, 'proposed'); assert.deepEqual(persisted().snapshots, history.snapshots);
  // Exercise the same payload conversion as the composer at the image/voice boundary.
  const imageBytes = await sharp({ create: { width: 40, height: 40, channels: 4, background: '#00FFFF' } }).png().toBuffer();
  const images = [image];
  for (let index = 1; index <= IMAGE_ATTACHMENT_LIMIT; index++) images.push(await upload('reference', `reference-${index}.png`, imageBytes));
  const materialInput = commentAttachmentInput([...images.slice(0, IMAGE_ATTACHMENT_LIMIT), voice]);
  assert.equal(materialInput.attachmentIds.length, IMAGE_ATTACHMENT_LIMIT); assert.equal(materialInput.voiceAssetId, voice.id);
  const materials = await request('/api/comments', 'POST', { versionId, frameIn: 15, text: '', ...materialInput });
  assert.equal(materials.status, 201); assert.deepEqual(materials.value.attachmentIds, materialInput.attachmentIds); assert.equal(materials.value.voiceAssetId, voice.id);
  const materialsExport = await request('/api/feedback-exports', 'POST', { versionId, commentIds: [materials.value.id] }); assert.equal(materialsExport.status, 200);
  const materialsManifest = await (await fetch(`${base}${materialsExport.value.manifestUrl}`)).json();
  assert.equal(materialsManifest.stats.attachmentCount, IMAGE_ATTACHMENT_LIMIT + 1);
  assert.equal(materialsManifest.files.filter(file => file.path.startsWith('attachments/') && file.mimeType.startsWith('image/')).length, IMAGE_ATTACHMENT_LIMIT);
  assert.equal(materialsManifest.files.filter(file => file.path.startsWith('attachments/') && file.mimeType.startsWith('audio/')).length, 1);
  assert.equal(materialsManifest.sourceVideoIncluded, false); assert.equal(materialsManifest.renderedVideoIncluded, false);
  const voiceOnly = await request('/api/comments', 'POST', { versionId, frameIn: 20, text: '', ...commentAttachmentInput([voice]) });
  assert.equal(voiceOnly.status, 201); assert.deepEqual(voiceOnly.value.attachmentIds, []); assert.equal(voiceOnly.value.voiceAssetId, voice.id);
  const beforeOverLimit = (await request('/api/state')).value;
  const overLimit = await request('/api/comments', 'POST', { versionId, frameIn: 15, text: '', ...commentAttachmentInput(images) });
  assert.equal(overLimit.status, 400); assert.match(overLimit.value.error, /최대 10개/);
  assert.deepEqual((await request('/api/state')).value, beforeOverLimit, 'an over-limit request must not partially save feedback');
});

await test('explicit local transcription stores labelled ASR text that flows into the handoff, and stays off when unconfigured', { timeout: 90_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'video-interference-transcribe-api-')), fake = await fakeWhisper(storage);
  const start = env => {
    const child = spawn(process.execPath, ['apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: '4319', VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: join(storage, 'missing.mp4'), ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '', WHISPER_CPP_PATH: '', WHISPER_MODEL_PATH: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    return { child, log: () => log };
  };
  const stop = async child => { child.kill('SIGTERM'); if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref(); }); };
  const ready = async worker => { for (let index = 0; index < 100; index++) { if (worker.child.exitCode !== null) throw new Error(worker.log()); try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {} await pause(50); } throw new Error(worker.log()); };
  const request = async (path, method = 'GET', value) => { const response = await fetch(`${base}${path}`, { method, ...(value === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) }); return { status: response.status, value: await response.json() }; };
  let worker = start({}); t.after(async () => { await stop(worker.child); await rm(storage, { recursive: true, force: true }); }); await ready(worker);
  const source = join(storage, 'source.mp4'); await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  assert.equal((await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'x-file-name': 'voice-source.mp4', 'content-type': 'video/mp4' }, body: await readFile(source) })).status, 201);
  const voiceSource = join(storage, 'memo.m4a'); await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'aac', voiceSource]);
  const upload = async (role, name, bytes, mime) => (await fetch(`${base}/api/attachments`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent(name), 'x-asset-role': role, 'content-type': mime }, body: bytes })).json();
  const voice = await upload('voice', 'memo.m4a', await readFile(voiceSource), 'audio/mp4');
  const image = await upload('reference', 'ref.png', await sharp({ create: { width: 20, height: 20, channels: 3, background: '#00FF00' } }).png().toBuffer(), 'image/png');
  const state = (await request('/api/state')).value; assert.equal(state.capabilities.transcription, false);
  const disabled = await request(`/api/attachments/${voice.id}/transcribe`, 'POST', {}); assert.equal(disabled.status, 409); assert.match(disabled.value.error, /WHISPER_CPP_PATH/);
  await stop(worker.child); worker = start({ WHISPER_CPP_PATH: fake.binary, WHISPER_MODEL_PATH: fake.model }); await ready(worker);
  assert.equal((await request('/api/state')).value.capabilities.transcription, true);
  const versionId = state.versions[0].id;
  const comment = (await request('/api/comments', 'POST', { versionId, frameIn: 30, frameOut: 31, text: '', voiceAssetId: voice.id })).value;
  const first = await request('/api/feedback-exports', 'POST', { versionId }); assert.equal(first.status, 200);
  assert.equal((await request(`/api/attachments/${image.id}/transcribe`, 'POST', {})).status, 409, 'only voice memos are transcribed');
  assert.equal((await request(`/api/attachments/${voice.id}/transcribe`, 'POST', { language: 'en' })).status, 400);
  assert.equal((await request('/api/state')).value.attachments.find(item => item.id === voice.id).transcript, undefined, 'saving and exporting feedback never start transcription');
  assert.ok(comment.id && first.value.commentCount === 1);
  const transcribed = await request(`/api/attachments/${voice.id}/transcribe`, 'POST', {}); assert.equal(transcribed.status, 200, JSON.stringify(transcribed.value));
  assert.equal(transcribed.value.transcript.source, 'asr'); assert.equal(transcribed.value.transcript.text, '자막을 조금 더 크게 해 주세요'); assert.equal(transcribed.value.transcript.model, 'ggml-test.bin');
  assert.deepEqual((await request('/api/state')).value.attachments.find(item => item.id === voice.id).transcript, transcribed.value.transcript);
  const second = await request('/api/feedback-exports', 'POST', { versionId }); assert.equal(second.status, 200); assert.notEqual(second.value.manifestUrl, first.value.manifestUrl, 'a new transcript changes the handoff');
  const manifest = await (await fetch(`${base}${second.value.manifestUrl}`)).json(); await validateHandoffManifest(manifest);
  const attachment = manifest.feedback[0].attachments.find(item => item.role === 'voice');
  assert.equal(attachment.automaticTranscription, true); assert.deepEqual(attachment.transcript, transcribed.value.transcript); assert.equal(manifest.automaticTranscription, false, 'the export itself ran no transcription'); assert.equal(manifest.stats.transcriptCount, 1);
  const markdown = await (await fetch(`${base}${second.value.markdownUrl}`)).text(); assert.match(markdown, /음성 메모 · 자동 받아쓰기/); assert.match(markdown, /> 자막을 조금 더 크게 해 주세요/); assert.match(markdown, /whisper\.cpp · ggml-test\.bin · ko 로컬 자동 결과/);
  const line = (await (await fetch(`${base}${second.value.jsonlUrl}`)).text()).trim().split('\n').map(item => JSON.parse(item))[1];
  assert.deepEqual(line.voice, [{ file: attachment.file, transcript: '자막을 조금 더 크게 해 주세요', transcriptSource: 'asr:whisper.cpp', language: 'ko' }]);
  assert.match(await (await fetch(`${base}${second.value.vttUrl}`)).text(), /음성\(자동 받아쓰기\): 자막을 조금 더 크게 해 주세요/);
});
