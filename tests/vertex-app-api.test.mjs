import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function ready(child) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not start')), 10000);
    child.stdout.on('data', data => { if (String(data).includes('worker ready')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('worker exited early')); });
  });
}
async function until(base, kind, id, expected) {
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${base}/api/vertex-${kind}/jobs/${id}`), body = await response.json();
    if (body.status === expected) return body;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`${kind} did not reach ${expected}`);
}

test('local app routes execute mocked image/audio once and resume video only by status check', async t => {
  const storage = await mkdtemp(join(tmpdir(), 'vertex-app-api-')), calls = join(storage, 'calls.txt'), port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  const start = async () => {
    child = spawn(process.execPath, ['--import', './tests/vertex-app-fetch-stub.mjs', 'apps/worker/server.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), VI_STORAGE_ROOT: storage, VI_SAMPLE_PATH: join(storage, 'absent.mp4'), VI_VERTEX_GENERATION_ENABLED: '1', VERTEX_PROJECT_ID: 'sample-project-123', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent', VI_TEST_VERTEX_CALLS: calls }, stdio: ['ignore', 'pipe', 'pipe'] });
    await ready(child);
  };
  const stop = async () => { if (!child || child.exitCode !== null) return; const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; };
  t.after(async () => { await stop(); await rm(storage, { recursive: true, force: true }); });
  await start();
  const post = (kind, id, extra = {}) => fetch(`${base}/api/vertex-${kind}/jobs`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: id, prompt: 'synthetic prompt', ...extra }) });
  assert.equal((await fetch(`${base}/api/vertex-image/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await post('image', randomUUID(), { project: 'other' })).status, 400);
  for (const kind of ['image', 'audio']) {
    const id = randomUUID(); assert.equal((await post(kind, id)).status, 202);
    const complete = await until(base, kind, id, 'completed');
    const resultUrl = kind === 'image' ? complete.imageUrl : complete.audioUrl;
    assert.equal((await fetch(`${base}${resultUrl}`)).status, 200);
    assert.equal((await post(kind, id)).status, 409);
  }
  const id = randomUUID(); assert.equal((await post('video', id)).status, 202); await until(base, 'video', id, 'pending');
  await stop(); await start(); assert.equal((await until(base, 'video', id, 'pending')).status, 'pending');
  const checked = await fetch(`${base}/api/vertex-video/jobs/${id}/check`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(checked.status, 202); await until(base, 'video', id, 'pending');
  const lines = (await readFile(calls, 'utf8')).trim().split('\n');
  assert.deepEqual(lines.sort(), ['audio', 'image', 'video-check', 'video-submit'].sort());
});
