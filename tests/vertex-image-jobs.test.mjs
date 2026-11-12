import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVertexImageJobs } from '../apps/worker/vertex-image-jobs.mjs';
import sharp from 'sharp';

async function fixture(t, generate) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'vertex-image-job-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const config = { storageRoot, project: 'sample-project-123', enabled: true, generate };
  return { storageRoot, config, jobs: createVertexImageJobs(config) };
}
async function waitFor(jobs, id, desired) {
  for (let i = 0; i < 100; i++) { const item = await jobs.status(id); if (item.status === desired) return item; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`status did not become ${desired}`);
}

test('disabled configuration never generates and input is strictly bounded', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; });
  const disabled = createVertexImageJobs({ ...f.config, enabled: false });
  assert.equal((await disabled.list()).enabled, false);
  await assert.rejects(disabled.submit({ requestId: randomUUID(), prompt: 'hello' }), error => error.status === 403);
  for (const input of [{ requestId: '../x', prompt: 'hello' }, { requestId: randomUUID(), prompt: 'x'.repeat(2001) }, { requestId: randomUUID(), prompt: 'ok', project: 'other' }]) await assert.rejects(f.jobs.submit(input));
  assert.equal(calls, 0);
});

test('one paid request is reserved before submission and duplicate/concurrent requests are blocked', async t => {
  let release, started = 0; const hold = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async ({ requestId, storageRoot }) => {
    started++; await hold;
    const directory = join(await realpath(storageRoot), 'vertex-images', requestId);
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'image.png'), 'test fixture');
    return { mimeType: 'image/png', output: join(directory, 'image.png') };
  });
  const requestId = randomUUID();
  assert.equal((await f.jobs.submit({ requestId, prompt: 'private prompt' })).status, 'running');
  assert.equal(started, 1);
  await assert.rejects(f.jobs.submit({ requestId, prompt: 'private prompt' }), error => error.status === 409);
  await assert.rejects(f.jobs.submit({ requestId: randomUUID(), prompt: 'other' }), error => error.status === 409);
  const saved = await readFile(join(f.storageRoot, 'vertex-image-jobs', requestId, 'status.json'), 'utf8');
  assert.ok(!saved.includes('private prompt'));
  release(); const completed = await waitFor(f.jobs, requestId, 'completed');
  assert.equal(completed.imageUrl, `/api/vertex-image/jobs/${requestId}/image`);
  assert.equal((await f.jobs.image(requestId)).mimeType, 'image/png');
  await assert.rejects(f.jobs.submit({ requestId, prompt: 'private prompt' }), error => error.status === 409);
  assert.equal(started, 1);
});

test('restart reports an interrupted request and never retries it', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return new Promise(() => {}); });
  const requestId = randomUUID(); await f.jobs.submit({ requestId, prompt: 'example' });
  const restarted = createVertexImageJobs(f.config);
  const item = await restarted.status(requestId);
  assert.equal(item.status, 'interrupted'); assert.match(item.error, /다시 요청하지 않습니다/);
  await assert.rejects(restarted.submit({ requestId, prompt: 'example' }), error => error.status === 409);
  assert.equal(calls, 1);
});

test('restart recovers a fully written image without a second paid request', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return new Promise(() => {}); });
  const requestId = randomUUID(); await f.jobs.submit({ requestId, prompt: 'example' });
  const dir = join(await realpath(f.storageRoot), 'vertex-images', requestId);
  await mkdir(dir, { recursive: true });
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'yellow' } }).png().toFile(join(dir, 'image.png'));
  const restarted = createVertexImageJobs(f.config), recovered = await restarted.status(requestId);
  assert.equal(recovered.status, 'completed'); assert.equal((await restarted.image(requestId)).mimeType, 'image/png');
  assert.equal(calls, 1);
});

test('symlinked job storage is rejected', async t => {
  const f = await fixture(t, async () => {}), outside = join(f.storageRoot, 'other');
  await mkdir(outside); await symlink(outside, join(f.storageRoot, 'vertex-image-jobs'));
  await assert.rejects(f.jobs.list(), error => error.status === 500);
});
