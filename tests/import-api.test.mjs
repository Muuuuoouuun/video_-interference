import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegPath, run } from '../apps/worker/engine.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = 4327, base = `http://127.0.0.1:${port}`;
const pause = ms => new Promise(done => setTimeout(done, ms));

test('video import reports receive/convert progress, survives a dropped connection and reuses measured scene cuts', { timeout: 120_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'vi-import-api-'));
  const wrapper = join(storage, 'ffmpeg-wrapper.sh'), hold = join(storage, 'hold-import');
  // Hold only the normalization encode (the one writing *_preview.mp4) so the test can drop the connection mid-conversion.
  await writeFile(wrapper, '#!/bin/sh\ncase "$*" in\n  *"scene_score"*"_preview.mp4"*)\n    echo held >> "$VI_IMPORT_HOLD.entered"\n    trap \'exit 143\' TERM INT\n    while test -f "$VI_IMPORT_HOLD"; do sleep 0.05; done\n    ;;\nesac\nexec "$VI_REAL_FFMPEG" "$@"\n'); await chmod(wrapper, 0o755);
  const source = join(storage, 'cuts.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  const child = spawn(process.execPath, ['apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: join(storage, 'missing.mp4'), FFMPEG_PATH: wrapper, VI_REAL_FFMPEG: ffmpegPath, VI_IMPORT_HOLD: hold, ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  t.after(async () => { child.kill('SIGTERM'); await new Promise(done => { child.once('exit', done); setTimeout(done, 3000).unref(); }); await rm(storage, { recursive: true, force: true }); });
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null) throw new Error(log);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (attempt > 100) throw new Error(`worker readiness timed out: ${log}`); await pause(50);
  }
  const status = async () => (await fetch(`${base}/api/import-status`)).json();
  assert.deepEqual(await status(), { active: false });
  const bytes = await readFile(source);
  const post = () => {
    const req = http.request(`${base}/api/assets`, { method: 'POST', headers: { 'content-type': 'video/mp4', 'content-length': bytes.length, 'x-file-name': encodeURIComponent('컷 테스트.mp4') } });
    const response = new Promise((done, reject) => { req.on('response', res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => done({ status: res.statusCode, body: JSON.parse(text) })); }); req.on('error', reject); });
    req.end(bytes); return { req, response };
  };

  await writeFile(hold, '');
  const dropped = post(); dropped.response.catch(() => {});
  let converting;
  for (let attempt = 0; attempt < 200 && !converting; attempt++) { const value = await status(); if (value.stage === 'converting') converting = value; else await pause(25); }
  assert.ok(converting, 'the worker reports the conversion step');
  assert.equal(converting.receivedBytes, bytes.length); assert.equal(converting.totalBytes, bytes.length); assert.equal(converting.name, '컷 테스트.mp4');
  let entered = '';
  for (let attempt = 0; attempt < 200 && !entered; attempt++) { entered = await readFile(`${hold}.entered`, 'utf8').catch(() => ''); if (!entered) await pause(25); }
  assert.equal(entered, 'held\n', 'the connection drops while the normalization encode itself is running');
  dropped.req.destroy();
  for (let attempt = 0; attempt < 200 && (await status()).active; attempt++) await pause(25);
  assert.deepEqual(await status(), { active: false }, 'closing the page stops the import');
  assert.equal((await (await fetch(`${base}/api/state`)).json()).empty, true, 'a canceled import never replaces the project');
  assert.deepEqual((await readdir(join(storage, 'media'))).filter(name => !name.startsWith('.')), [], 'received source and partial proxy are removed');

  await rm(hold, { force: true });
  const completed = await post().response;
  assert.equal(completed.status, 201, JSON.stringify(completed.body));
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.project.name, '컷 테스트');
  const overviews = await readdir(join(storage, 'overviews'));
  const cuts = JSON.parse(await readFile(join(storage, 'overviews', overviews.find(name => name.startsWith('cuts-'))), 'utf8'));
  assert.deepEqual(cuts.cuts, [30], 'the red→blue cut was measured during the import itself');
  assert.equal(cuts.source, 'import-normalization');
  assert.deepEqual((await readdir(join(storage, 'jobs'))).filter(name => name.endsWith('.scene-scores.txt')), [], 'the temporary scene score file is removed');
  assert.ok((await stat(join(storage, 'media'))).isDirectory());
});
