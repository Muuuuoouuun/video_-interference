import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { generateVertexVideo, checkVertexVideoOperation, pollVertexVideoOperation, VIDEO_MODEL } from '../apps/worker/vertex-video.mjs';
import { ffmpegPath, run } from '../apps/worker/engine.mjs';

function createMockMp4() {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(32, 0);
  buf.write('ftyp', 4, 'ascii');
  buf.write('isom', 8, 'ascii');
  return buf;
}

async function fixture(t) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'vertex-video-test-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const mp4 = createMockMp4();
  const requestId = randomUUID();
  const options = {
    project: 'sample-project-123',
    prompt: 'a cinematic drone shot of a misty pine forest at sunrise',
    requestId,
    storageRoot,
    live: true,
    location: 'us-central1',
    durationSeconds: 4,
    aspectRatio: '16:9',
  };
  const opName = `projects/sample-project-123/locations/us-central1/operations/op-${requestId.slice(0, 8)}`;
  return { options, mp4, requestId, opName, storageRoot };
}

test('video preview uses neither authentication, network nor output files', async t => {
  const f = await fixture(t);
  const result = await generateVertexVideo(
    { ...f.options, live: false },
    {
      getAuthHeaders: () => { throw new Error('auth called'); },
      fetchImpl: () => { throw new Error('network called'); },
    }
  );
  assert.equal(result.networkAttempted, false);
  assert.equal(result.mode, 'preview');
  assert.equal(result.status, 'preview');
  assert.equal(result.model, VIDEO_MODEL);
  await assert.rejects(readFile(join(f.storageRoot, 'vertex-videos')), { code: 'ENOENT' });

  // CLI preview test
  const cli = spawnSync(process.execPath, ['scripts/vertex-video.mjs', '--project', f.options.project], {
    cwd: process.cwd(),
    input: f.options.prompt,
    encoding: 'utf8',
    env: { ...process.env, VI_STORAGE_ROOT: f.storageRoot, GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent' },
  });
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.networkAttempted, false);
  assert.equal(parsed.mode, 'preview');
});

test('live video submission submits LRO once and writes state file', async t => {
  const f = await fixture(t);
  let fetchCalls = 0;
  let authCalls = 0;

  const result = await generateVertexVideo(f.options, {
    getAuthHeaders: async () => {
      authCalls++;
      return new Headers({ authorization: 'Bearer mock-bearer-token', 'x-goog-user-project': 'other-project-123' });
    },
    fetchImpl: async (url, options) => {
      fetchCalls++;
      assert.equal(
        url,
        `https://us-central1-aiplatform.googleapis.com/v1/projects/sample-project-123/locations/us-central1/publishers/google/models/${VIDEO_MODEL}:predictLongRunning`
      );
      assert.equal(options.headers.authorization, 'Bearer mock-bearer-token');
      assert.equal(options.headers['x-goog-user-project'], f.options.project);
      assert.equal(options.headers['x-goog-api-key'], undefined);
      assert.equal(options.redirect, 'error');

      const body = JSON.parse(options.body);
      assert.deepEqual(body.instances, [{ prompt: f.options.prompt }]);
      assert.equal(body.parameters.durationSeconds, 4);
      assert.equal(body.parameters.aspectRatio, '16:9');
      assert.equal(body.parameters.sampleCount, 1);

      return new Response(JSON.stringify({ name: f.opName }), { status: 200 });
    },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(authCalls, 1);
  assert.equal(result.networkAttempted, true);
  assert.equal(result.operationName, f.opName);
  assert.equal(result.status, 'PENDING');

  // Verify saved operation state
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));
  assert.equal(state.status, 'PENDING');
  assert.equal(state.operationName, f.opName);
  assert.equal(state.requestId, f.requestId);

  // Re-submission with the same ID must be blocked before calling network
  await assert.rejects(
    generateVertexVideo(f.options, {
      getAuthHeaders: async () => new Headers({ authorization: 'Bearer mock-token' }),
      fetchImpl: () => { throw new Error('must not call'); },
    }),
    { code: 'DUPLICATE_REQUEST' }
  );
});

test('live video with poll=true waits for LRO completion and saves MP4 video', async t => {
  const f = await fixture(t);
  let calls = 0;

  const result = await generateVertexVideo(
    { ...f.options, poll: true, pollIntervalMs: 1 },
    {
      getAuthHeaders: async () => new Headers({ authorization: 'Bearer mock-bearer-token' }),
      sleepImpl: async () => {},
      validateOutput: async () => {},
      fetchImpl: async (url) => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify({ name: f.opName }), { status: 200 });
        }
        if (calls === 2) {
          return new Response(JSON.stringify({ name: f.opName, done: false }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            name: f.opName,
            done: true,
            response: {
              predictions: [
                {
                  bytesBase64Encoded: f.mp4.toString('base64'),
                  mimeType: 'video/mp4',
                },
              ],
            },
          }),
          { status: 200 }
        );
      },
    }
  );

  assert.equal(calls, 3);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.videoGenerated, true);
  const savedBytes = await readFile(result.output);
  assert.deepEqual(savedBytes, f.mp4);

  // State file check
  const stateFile = join(f.storageRoot, 'vertex-videos', f.requestId, 'operation.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.status, 'SUCCEEDED');
  assert.equal(state.videoFile, 'video.mp4');
});

test('checkVertexVideoOperation checks existing operation and completes save', async t => {
  const f = await fixture(t);

  const dir = join(f.storageRoot, 'vertex-videos', f.requestId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stateFile = join(dir, 'operation.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(stateFile, JSON.stringify({ requestId: f.requestId, operationName: f.opName, status: 'RUNNING' }));

  let pollCalled = 0;
  const result = await checkVertexVideoOperation(
    {
      project: f.options.project,
      operationName: f.opName,
      requestId: f.requestId,
      storageRoot: f.storageRoot,
    },
    {
      getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }),
      validateOutput: async () => {},
      fetchImpl: async (url, options) => {
        pollCalled++;
        assert.ok(url.endsWith(':fetchPredictOperation'));
        const body = JSON.parse(options.body);
        assert.equal(body.operationName, f.opName);
        return new Response(
          JSON.stringify({
            name: f.opName,
            done: true,
            response: {
              videos: [{ bytesBase64Encoded: f.mp4.toString('base64'), mimeType: 'video/mp4' }],
            },
          }),
          { status: 200 }
        );
      },
    }
  );

  assert.equal(pollCalled, 1);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.videoGenerated, true);
});

test('a truncated ftyp-only response is not published as a playable video', async t => {
  const f = await fixture(t);
  const directory = join(f.storageRoot, 'vertex-videos', f.requestId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'operation.json'), JSON.stringify({ requestId: f.requestId, operationName: f.opName, status: 'RUNNING' }));
  await assert.rejects(checkVertexVideoOperation({ ...f.options, operationName: f.opName }, {
    getAuthHeaders: async () => new Headers({ authorization: 'Bearer offline-token' }),
    fetchImpl: async () => new Response(JSON.stringify({ done: true, response: { videos: [{ mimeType: 'video/mp4', bytesBase64Encoded: f.mp4.toString('base64') }] } })),
  }), { code: 'OUTPUT_FAILED_AFTER_CALL' });
  await assert.rejects(readFile(join(directory, 'video.mp4')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, '.video.partial')), { code: 'ENOENT' });
});

test('a locally generated video is decoded before it is atomically published', async t => {
  const f = await fixture(t), sample = join(f.storageRoot, 'synthetic.mp4');
  await run(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:r=1', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sample], { timeout: 30_000 });
  const bytes = await readFile(sample), directory = join(f.storageRoot, 'vertex-videos', f.requestId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'operation.json'), JSON.stringify({ requestId: f.requestId, operationName: f.opName, status: 'RUNNING' }));
  const result = await checkVertexVideoOperation({ ...f.options, operationName: f.opName }, {
    getAuthHeaders: async () => new Headers({ authorization: 'Bearer offline-token' }),
    fetchImpl: async () => new Response(JSON.stringify({ done: true, response: { videos: [{ mimeType: 'video/mp4', bytesBase64Encoded: bytes.toString('base64') }] } })),
  });
  assert.deepEqual(await readFile(result.output), bytes);
  await assert.rejects(readFile(join(directory, '.video.partial')), { code: 'ENOENT' });
});

test('invalid options and auth failure reject before making network requests', async t => {
  const f = await fixture(t);
  let networkCalls = 0;
  const deps = {
    getAuthHeaders: async () => new Headers({ authorization: 'Bearer safe-token' }),
    fetchImpl: async () => { networkCalls++; return new Response('ok'); },
  };

  for (const invalid of [
    { project: 'invalid/project' },
    { prompt: '' },
    { prompt: 'a'.repeat(2001) },
    { requestId: 'not-a-uuid' },
    { durationSeconds: 15 },
    { aspectRatio: '4:3' },
    { location: 'bad_location' },
  ]) {
    await assert.rejects(generateVertexVideo({ ...f.options, ...invalid }, deps));
  }

  // Auth failure
  await assert.rejects(
    generateVertexVideo(f.options, {
      ...deps,
      getAuthHeaders: async () => { throw new Error('ADC unavailable'); },
    }),
    { code: 'AUTH_FAILED' }
  );

  assert.equal(networkCalls, 0);
});

test('provider submission failure throws GENERATION_UNCERTAIN and locks the ID', async t => {
  const f = await fixture(t);
  let calls = 0;
  const deps = {
    getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }),
    fetchImpl: async () => {
      calls++;
      return new Response('internal error', { status: 500 });
    },
  };

  await assert.rejects(generateVertexVideo(f.options, deps), { code: 'GENERATION_UNCERTAIN' });
  assert.equal(calls, 1);

  await assert.rejects(generateVertexVideo(f.options, deps), { code: 'DUPLICATE_REQUEST' });
  assert.equal(calls, 1);
});

test('symlinked output directory is rejected before network call', async t => {
  const f = await fixture(t);
  const target = join(f.storageRoot, 'target-dir');
  await mkdir(target);
  await symlink(target, join(f.storageRoot, 'vertex-videos'));

  let networkCalls = 0;
  await assert.rejects(
    generateVertexVideo(f.options, {
      getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }),
      fetchImpl: async () => { networkCalls++; return new Response('ok'); },
    }),
    { code: 'UNSAFE_OUTPUT' }
  );
  assert.equal(networkCalls, 0);
});

test('concurrent executions sharing one ID can submit at most one generation request', async t => {
  const f = await fixture(t);
  let calls = 0;
  const deps = {
    getAuthHeaders: async () => new Headers({ authorization: 'Bearer mock-token' }),
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ name: f.opName }), { status: 200 });
    },
  };

  const results = await Promise.allSettled([
    generateVertexVideo(f.options, deps),
    generateVertexVideo(f.options, deps),
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'DUPLICATE_REQUEST');
});

test('LRO failure in provider sets operation state to FAILED and throws LRO_FAILED', async t => {
  const f = await fixture(t);
  let calls = 0;

  await assert.rejects(
    generateVertexVideo(
      { ...f.options, poll: true, pollIntervalMs: 1 },
      {
        getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }),
        sleepImpl: async () => {},
        fetchImpl: async () => {
          calls++;
          if (calls === 1) {
            return new Response(JSON.stringify({ name: f.opName }), { status: 200 });
          }
          return new Response(
            JSON.stringify({
              name: f.opName,
              done: true,
              error: { code: 3, message: 'Policy violation or render failure' },
            }),
            { status: 200 }
          );
        },
      }
    ),
    { code: 'LRO_FAILED' }
  );

  const stateFile = join(f.storageRoot, 'vertex-videos', f.requestId, 'operation.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.status, 'FAILED');
  assert.equal(state.error, '영상 작업이 공급자에서 실패했습니다.');
});

test('LRO polling timeout marks state as POLL_TIMEOUT and throws LRO_TIMEOUT', async t => {
  const f = await fixture(t);

  await assert.rejects(
    generateVertexVideo(
      { ...f.options, poll: true, pollIntervalMs: 1, maxPollAttempts: 2 },
      {
        getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }),
        sleepImpl: async () => {},
        fetchImpl: async (url) => {
          if (url.includes(':predictLongRunning')) {
            return new Response(JSON.stringify({ name: f.opName }), { status: 200 });
          }
          return new Response(JSON.stringify({ name: f.opName, done: false }), { status: 200 });
        },
      }
    ),
    { code: 'LRO_TIMEOUT' }
  );

  const stateFile = join(f.storageRoot, 'vertex-videos', f.requestId, 'operation.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.status, 'POLL_TIMEOUT');
});

test('CLI check-operation command runs successfully with mocked storage', async t => {
  const f = await fixture(t);
  const dir = join(f.storageRoot, 'vertex-videos', f.requestId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'operation.json'), JSON.stringify({ requestId: f.requestId, operationName: f.opName, status: 'RUNNING' }));

  const cli = spawnSync(
    process.execPath,
    [
      'scripts/vertex-video.mjs',
      '--project', f.options.project,
      '--check-operation', f.opName,
      '--request-id', f.requestId,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        VI_STORAGE_ROOT: f.storageRoot,
        GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent',
      },
    }
  );
  assert.equal(cli.status, 1);
  assert.ok(cli.stderr.includes('AUTH_FAILED'));
});

test('malicious location, project or model never reaches ADC or network on submission or polling', async t => {
  const f = await fixture(t);
  const dir = join(f.storageRoot, 'vertex-videos', f.requestId);
  await mkdir(dir, { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'operation.json'), JSON.stringify({ requestId: f.requestId, operationName: f.opName, project: f.options.project, location: f.options.location, model: VIDEO_MODEL, status: 'PENDING' }));
  let authCalls = 0, networkCalls = 0;
  const deps = { getAuthHeaders: async () => { authCalls++; return new Headers({ authorization: 'Bearer private-test-token' }); }, fetchImpl: async () => { networkCalls++; return new Response('{}'); } };
  for (const invalid of [{ location: 'evil.example/path' }, { location: 'evil.example@google.com' }, { project: 'evil/path' }, { model: 'evil/../../path' }]) {
    await assert.rejects(checkVertexVideoOperation({ ...f.options, operationName: f.opName, ...invalid }, deps));
    await assert.rejects(generateVertexVideo({ ...f.options, ...invalid, requestId: randomUUID() }, deps));
  }
  assert.equal(authCalls, 0); assert.equal(networkCalls, 0);
});

test('polling requires the matching saved operation and does not authenticate or call another operation', async t => {
  const f = await fixture(t);
  const dir = join(f.storageRoot, 'vertex-videos', f.requestId);
  await mkdir(dir, { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  const statePath = join(dir, 'operation.json');
  const base = { requestId: f.requestId, operationName: f.opName, project: f.options.project, location: f.options.location, model: VIDEO_MODEL, status: 'PENDING' };
  let authCalls = 0, calls = 0;
  const deps = { getAuthHeaders: async () => { authCalls++; return new Headers({ authorization: 'Bearer token' }); }, fetchImpl: async () => { calls++; return new Response('{}'); } };
  for (const mismatch of [{ requestId: randomUUID() }, { operationName: `${f.opName}-other` }, { project: 'other-project-123' }, { location: 'asia-northeast3' }, { model: 'other-model' }]) {
    await writeFile(statePath, JSON.stringify({ ...base, ...mismatch }));
    await assert.rejects(checkVertexVideoOperation({ ...f.options, operationName: f.opName }, deps), { code: 'INVALID_SAVED_OPERATION' });
  }
  await rm(statePath);
  await assert.rejects(checkVertexVideoOperation({ ...f.options, operationName: f.opName }, deps), { code: 'INVALID_SAVED_OPERATION' });
  assert.equal(authCalls, 0); assert.equal(calls, 0);
});

test('pending state retains endpoint identity after a poll and resumes without generation resubmission', async t => {
  const f = await fixture(t); let generationCalls = 0, pollCalls = 0;
  const auth = async () => new Headers({ authorization: 'Bearer token', 'x-goog-user-project': 'other-project-123' });
  const submitted = await generateVertexVideo(f.options, { getAuthHeaders: auth, fetchImpl: async () => { generationCalls++; return new Response(JSON.stringify({ name: f.opName })); } });
  const options = { project: f.options.project, location: f.options.location, model: VIDEO_MODEL, requestId: f.requestId, operationName: f.opName, storageRoot: f.storageRoot };
  const pending = await checkVertexVideoOperation(options, { getAuthHeaders: auth, fetchImpl: async (url, request) => { pollCalls++; assert.ok(url.endsWith(':fetchPredictOperation')); assert.equal(request.headers['x-goog-user-project'], options.project); return new Response(JSON.stringify({ done: false })); } });
  assert.equal(pending.status, 'RUNNING');
  const running = JSON.parse(await readFile(submitted.statePath, 'utf8'));
  assert.equal(running.project, options.project); assert.equal(running.location, options.location); assert.equal(running.model, options.model); assert.equal(running.operationName, f.opName);
  const completed = await checkVertexVideoOperation(options, { getAuthHeaders: auth, validateOutput: async () => {}, fetchImpl: async (url, request) => { pollCalls++; assert.ok(url.endsWith(':fetchPredictOperation')); assert.equal(request.headers['x-goog-user-project'], options.project); return new Response(JSON.stringify({ done: true, response: { videos: [{ mimeType: 'video/mp4', bytesBase64Encoded: f.mp4.toString('base64') }] } })); } });
  assert.equal(completed.status, 'SUCCEEDED'); assert.equal(generationCalls, 1); assert.equal(pollCalls, 2);
});

test('supplied poll headers cannot override the request project or add unrelated headers', async t => {
  const f = await fixture(t);
  await generateVertexVideo(f.options, { getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }), fetchImpl: async () => new Response(JSON.stringify({ name: f.opName })) });
  let polls = 0;
  await pollVertexVideoOperation({ ...f.options, model: VIDEO_MODEL, operationName: f.opName, authHeaders: { authorization: 'Bearer token', 'x-goog-user-project': 'other-project-123', 'x-unrelated-secret': 'not-forwarded' }, singleCheck: true, fetchImpl: async (_url, request) => {
    polls++;
    assert.equal(request.headers['x-goog-user-project'], f.options.project);
    assert.equal(request.headers['x-unrelated-secret'], undefined);
    return new Response(JSON.stringify({ done: false }));
  } });
  assert.equal(polls, 1);
});
