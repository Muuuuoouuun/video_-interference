import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVertexVideoJobs } from '../apps/worker/vertex-video-jobs.mjs';
import { VIDEO_MODEL, DEFAULT_VIDEO_LOCATION } from '../apps/worker/vertex-video.mjs';

async function fixture(t) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'vertex-video-job-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  let generations = 0, checks = 0;
  const config = {
    storageRoot, project: 'sample-project-123', enabled: true,
    validateOutput: async file => { if ((await readFile(file, 'utf8')) !== 'valid mock video') throw new Error('invalid'); },
    generate: async ({ project, requestId }) => {
      generations++; const directory = join(await realpath(storageRoot), 'vertex-videos', requestId);
      await mkdir(directory, { recursive: true });
      const operationName = `projects/${project}/locations/${DEFAULT_VIDEO_LOCATION}/operations/mock`;
      await writeFile(join(directory, 'operation.json'), JSON.stringify({ requestId, project, location: DEFAULT_VIDEO_LOCATION, model: VIDEO_MODEL, operationName, status: 'PENDING' }));
    },
    check: async ({ requestId }) => {
      checks++; const directory = join(await realpath(storageRoot), 'vertex-videos', requestId);
      await writeFile(join(directory, 'video.mp4'), 'valid mock video');
    },
  };
  return { storageRoot, config, jobs: createVertexVideoJobs(config), counts: () => ({ generations, checks }) };
}
async function waitFor(jobs, id, target) {
  for (let i = 0; i < 100; i++) { const item = await jobs.status(id); if (item.status === target) return item; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`status did not become ${target}`);
}

test('video generation is disabled by default and cannot receive client endpoint config', async t => {
  const f = await fixture(t), disabled = createVertexVideoJobs({ ...f.config, enabled: false });
  await assert.rejects(disabled.submit({ requestId: randomUUID(), prompt: 'test' }), error => error.status === 403);
  await assert.rejects(f.jobs.submit({ requestId: randomUUID(), prompt: 'test', location: 'evil.example' }));
  assert.deepEqual(f.counts(), { generations: 0, checks: 0 });
});

test('video persists submission and resumes with a separate status check, never a second generation', async t => {
  const f = await fixture(t), id = randomUUID();
  await f.jobs.submit({ requestId: id, prompt: 'public example' });
  await waitFor(f.jobs, id, 'pending');
  const restarted = createVertexVideoJobs(f.config);
  assert.equal((await restarted.status(id)).status, 'pending');
  await assert.rejects(restarted.submit({ requestId: id, prompt: 'public example' }), error => error.status === 409);
  assert.equal((await restarted.checkStatus(id)).status, 'checking');
  const completed = await waitFor(restarted, id, 'completed');
  assert.equal(completed.videoUrl, `/api/vertex-video/jobs/${id}/video`);
  assert.equal((await restarted.video(id)).mimeType, 'video/mp4');
  assert.deepEqual(f.counts(), { generations: 1, checks: 1 });
});

test('failed submission stays uncertain and tampered operation cannot be checked', async t => {
  const f = await fixture(t), id = randomUUID();
  const failed = createVertexVideoJobs({ ...f.config, generate: async () => { throw new Error('sensitive provider error'); } });
  await failed.submit({ requestId: id, prompt: 'private example' });
  const item = await waitFor(failed, id, 'interrupted');
  assert.ok(!JSON.stringify(item).includes('sensitive provider error'));
  await assert.rejects(failed.submit({ requestId: id, prompt: 'private example' }), error => error.status === 409);
  const next = randomUUID(); await f.jobs.submit({ requestId: next, prompt: 'test' }); await waitFor(f.jobs, next, 'pending');
  const file = join(f.storageRoot, 'vertex-videos', next, 'operation.json');
  const op = JSON.parse(await readFile(file, 'utf8')); op.project = 'other-project-123'; await writeFile(file, JSON.stringify(op));
  await assert.rejects(f.jobs.checkStatus(next), error => error.status === 409);
  assert.equal(f.counts().checks, 0);
});
