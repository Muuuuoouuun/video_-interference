/** Local-only timing for the default feedback flow: open a video, attach images, save feedback, export.
 * node scripts/benchmark-upload-export.mjs --video /path/to/video.mp4 [--comments 40] [--images 10] [--label current]
 * Starts an isolated worker on a temporary storage folder. Nothing is sent outside 127.0.0.1.
 * The report is written to storage/qa/upload-export/<label>.json (Git excluded).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = Object.fromEntries(process.argv.slice(2).map((value, index, list) => value.startsWith('--') ? [value.slice(2), list[index + 1]] : []).filter(pair => pair.length));
if (!args.video) { console.log('Usage: node scripts/benchmark-upload-export.mjs --video PATH [--comments 40] [--images 10] [--label current] [--port 4391]'); process.exit(args.help === undefined ? 1 : 0); }
const videoPath = resolve(args.video), commentCount = Number(args.comments ?? 40), imageCount = Number(args.images ?? 10), label = args.label ?? 'current', port = Number(args.port ?? 4391);
assert.match(label, /^[\w-]+$/, 'label must be a simple folder name');
assert.ok(Number.isSafeInteger(commentCount) && commentCount > 0 && commentCount <= 300, 'comments must be 1–300');
assert.ok(Number.isSafeInteger(imageCount) && imageCount >= 0 && imageCount <= 10, 'images must be 0–10');
const base = `http://127.0.0.1:${port}`, storage = await mkdtemp(join(tmpdir(), 'vi-benchmark-'));
const child = spawn(process.execPath, ['apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: join(storage, 'missing.mp4'), ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
const stop = async () => { child.kill('SIGTERM'); await new Promise(done => { child.once('exit', done); setTimeout(done, 3000).unref(); }); await rm(storage, { recursive: true, force: true }); };
const timed = async (fn) => { const started = performance.now(); const value = await fn(); return { value, ms: Math.round(performance.now() - started) }; };
const request = async (path, method = 'GET', value) => {
  const response = await fetch(`${base}${path}`, { method, ...(value === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) });
  const body = await response.json(); if (!response.ok) throw new Error(`${method} ${path} ${response.status}: ${body.error}`); return body;
};
const uploadFile = (path, file, headers) => new Promise((done, reject) => {
  const req = http.request(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': file.size, ...headers } }, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
    res.on('end', () => { const body = JSON.parse(text); res.statusCode < 300 ? done(body) : reject(new Error(`${path} ${res.statusCode}: ${body.error}`)); });
  });
  req.on('error', reject);
  if (file.buffer) req.end(file.buffer); else createReadStream(file.path).pipe(req);
});

try {
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null) throw new Error(`worker failed: ${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (attempt > 200) throw new Error(`worker readiness timed out: ${log}`);
    await new Promise(done => setTimeout(done, 100));
  }
  const source = await stat(videoPath);
  const imported = await timed(() => uploadFile('/api/assets', { path: videoPath, size: source.size }, { 'x-file-name': encodeURIComponent(basename(videoPath)) }));
  const state = await request('/api/state'), version = state.versions[0];
  const filmstrip = await timed(() => request(`/api/versions/${version.id}/filmstrip`));
  const images = await Promise.all(Array.from({ length: imageCount }, async (_, index) => ({ buffer: await sharp({ create: { width: 4032, height: 3024, channels: 3, background: { r: 40 + index * 20, g: 90, b: 160 } } }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="4032" height="3024"><circle cx="${800 + index * 250}" cy="1500" r="600" fill="#fff"/></svg>`), left: 0, top: 0 }]).jpeg({ quality: 92 }).toBuffer(), name: `photo-${index + 1}.jpg` })));
  const attachmentTimes = [];
  const attached = await timed(async () => {
    const results = [];
    for (const image of images) { const one = await timed(() => uploadFile('/api/attachments', { buffer: image.buffer, size: image.buffer.length }, { 'x-file-name': encodeURIComponent(image.name), 'x-asset-role': 'reference' })); attachmentTimes.push(one.ms); results.push(one.value); }
    return results;
  });
  // The composer uploads three images at a time; measure the same batch that way too.
  const attachedParallel = await timed(async () => { let next = 0; await Promise.all(Array.from({ length: Math.min(3, images.length) }, async () => { while (next < images.length) { const image = images[next++]; await uploadFile('/api/attachments', { buffer: image.buffer, size: image.buffer.length }, { 'x-file-name': encodeURIComponent(image.name), 'x-asset-role': 'reference' }); } })); });
  const commentIds = [];
  const saved = await timed(async () => {
    for (let index = 0; index < commentCount; index++) {
      const frameIn = Math.floor((version.durationFrames - 60) * index / Math.max(1, commentCount - 1)), ranged = index % 3 === 0;
      const drawings = index % 2 === 0 ? [{ id: `box-${index}`, kind: 'rect', color: '#ff3b30', points: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.6 }], region: { x: 0.2, y: 0.2, w: 0.3, h: 0.4 }, frame: frameIn }] : [];
      const attachmentIds = index === 0 ? attached.value.map(item => item.id) : [];
      const comment = await request('/api/comments', 'POST', { versionId: version.id, frameIn, frameOut: ranged ? frameIn + 45 : frameIn + 1, text: `벤치마크 피드백 ${index + 1}`, sceneDescription: index % 4 === 0 ? `장면 ${index + 1}` : undefined, drawings, attachmentIds });
      commentIds.push(comment.id);
    }
  });
  const exportCold = await timed(() => request('/api/feedback-exports', 'POST', { versionId: version.id }));
  const exportWarm = await timed(() => request('/api/feedback-exports', 'POST', { versionId: version.id }));
  await request('/api/comments', 'POST', { versionId: version.id, frameIn: Math.floor(version.durationFrames / 2) + 7, text: '추가 피드백 한 개' });
  const exportAfterOneMore = await timed(() => request('/api/feedback-exports', 'POST', { versionId: version.id }));
  const premiere = await timed(() => request('/api/premiere-exports', 'POST', { versionId: version.id }));
  const report = {
    label, createdAt: new Date().toISOString(), video: { name: basename(videoPath), bytes: source.size, durationFrames: version.durationFrames }, comments: commentCount, images: imageCount,
    importMs: imported.ms, filmstripColdMs: filmstrip.ms, attachmentsMs: attached.ms, attachmentsParallel3Ms: attachedParallel.ms, attachmentMs: attachmentTimes, commentsMs: saved.ms,
    feedbackExportColdMs: exportCold.ms, feedbackExportWarmMs: exportWarm.ms, feedbackExportAfterOneMoreMs: exportAfterOneMore.ms, premiereExportMs: premiere.ms,
  };
  const outputRoot = join(root, 'storage/qa/upload-export'); await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, `${label}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await stop(); }
