import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVertexAudioJobs } from '../apps/worker/vertex-audio-jobs.mjs';

function wav() {
  const b = Buffer.alloc(44 + 480);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(480, 40); return b;
}
async function fixture(t, generate) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'vertex-audio-job-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const config = { storageRoot, project: 'sample-project-123', enabled: true, generate };
  return { storageRoot, config, jobs: createVertexAudioJobs(config) };
}
async function waitFor(jobs, id, desired) {
  for (let i = 0; i < 100; i++) { const item = await jobs.status(id); if (item.status === desired) return item; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`status did not become ${desired}`);
}

test('audio jobs default off and reject extra configuration from client', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; });
  assert.equal((await createVertexAudioJobs({ ...f.config, enabled: false }).list()).enabled, false);
  await assert.rejects(f.jobs.submit({ requestId: randomUUID(), prompt: 'hello', model: 'other' }));
  assert.equal(calls, 0);
});

test('audio jobs reserve requests, prevent duplicates and expose completed wav only', async t => {
  let calls = 0, release; const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async ({ requestId, storageRoot }) => {
    calls++; await held; const dir = join(await realpath(storageRoot), 'vertex-audio', requestId);
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'audio.wav'), wav());
    return { mimeType: 'audio/wav', output: join(dir, 'audio.wav') };
  });
  const requestId = randomUUID(); await f.jobs.submit({ requestId, prompt: 'sample' });
  await assert.rejects(f.jobs.submit({ requestId, prompt: 'sample' }), error => error.status === 409);
  release(); const item = await waitFor(f.jobs, requestId, 'completed');
  assert.equal(item.audioUrl, `/api/vertex-audio/jobs/${requestId}/audio`);
  assert.equal((await f.jobs.audio(requestId)).mimeType, 'audio/wav'); assert.equal(calls, 1);
});

test('audio restart recovers a valid wav but never resubmits', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return new Promise(() => {}); });
  const requestId = randomUUID(); await f.jobs.submit({ requestId, prompt: 'sample' });
  const restarted = createVertexAudioJobs(f.config);
  assert.equal((await restarted.status(requestId)).status, 'interrupted');
  const dir = join(await realpath(f.storageRoot), 'vertex-audio', requestId);
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'audio.wav'), wav());
  assert.equal((await restarted.status(requestId)).status, 'completed'); assert.equal(calls, 1);
});
