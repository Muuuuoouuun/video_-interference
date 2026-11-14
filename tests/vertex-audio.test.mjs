import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { generateVertexAudio, validateWavBytes, AUDIO_MODEL } from '../apps/worker/vertex-audio.mjs';

function createMockWav() {
  const buf = Buffer.alloc(48);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(40, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(24000, 24); // sample rate
  buf.writeUInt32LE(48000, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(4, 40);
  return buf;
}

async function fixture(t) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'vertex-audio-test-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const wav = createMockWav();
  const requestId = randomUUID();
  const options = {
    project: 'sample-project-123',
    prompt: '안녕하세요, 새로운 편집본을 확인해 주세요.',
    requestId,
    storageRoot,
    live: true,
    location: 'global',
    voiceName: 'Puck',
  };
  const response = () => new Response(
    JSON.stringify({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/wav',
                  data: wav.toString('base64'),
                },
              },
            ],
          },
        },
      ],
    }),
    { status: 200 }
  );
  return { options, wav, requestId, response, storageRoot };
}

test('audio preview uses neither authentication, network nor output files', async t => {
  const f = await fixture(t);
  const result = await generateVertexAudio(
    { ...f.options, live: false },
    {
      getAuthHeaders: () => { throw new Error('auth called'); },
      fetchImpl: () => { throw new Error('network called'); },
    }
  );
  assert.equal(result.networkAttempted, false);
  assert.equal(result.mode, 'preview');
  assert.equal(result.model, AUDIO_MODEL);
  await assert.rejects(readFile(join(f.storageRoot, 'vertex-audio')), { code: 'ENOENT' });

  // CLI preview test
  const cli = spawnSync(process.execPath, ['scripts/vertex-audio.mjs', '--project', f.options.project], {
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

test('live audio generation makes one fixed Vertex request and saves audio file', async t => {
  const f = await fixture(t);
  let fetchCalls = 0;
  let authCalls = 0;

  const result = await generateVertexAudio(f.options, {
    getAuthHeaders: async () => {
      authCalls++;
      return new Headers({ authorization: 'Bearer offline-audio-token', 'x-goog-user-project': 'other-project-123' });
    },
    fetchImpl: async (url, options) => {
      fetchCalls++;
      assert.equal(
        url,
        `https://aiplatform.googleapis.com/v1/projects/sample-project-123/locations/global/publishers/google/models/${AUDIO_MODEL}:generateContent`
      );
      assert.equal(options.headers.authorization, 'Bearer offline-audio-token');
      assert.equal(options.headers['x-goog-user-project'], f.options.project);
      assert.equal(options.headers['x-goog-api-key'], undefined);
      assert.equal(options.redirect, 'error');

      const body = JSON.parse(options.body);
      assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: f.options.prompt }] }]);
      assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO']);
      assert.equal(body.generationConfig.speechConfig.voiceConfig.voice, 'Puck');

      return f.response();
    },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(authCalls, 1);
  assert.equal(result.audioGenerated, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.networkAttempted, true);
  assert.deepEqual(await readFile(result.output), f.wav);

  // Duplication check
  await assert.rejects(
    generateVertexAudio(f.options, {
      getAuthHeaders: async () => new Headers({ authorization: 'Bearer offline-audio-token' }),
      fetchImpl: () => { throw new Error('duplicate call'); },
    }),
    { code: 'DUPLICATE_REQUEST' }
  );
});

test('invalid audio options and auth failures reject before network call', async t => {
  const f = await fixture(t);
  let calls = 0;
  const deps = {
    getAuthHeaders: async () => new Headers({ authorization: 'Bearer safe-token' }),
    fetchImpl: async () => { calls++; return f.response(); },
  };

  for (const change of [
    { project: 'invalid/project' },
    { prompt: '' },
    { prompt: 'a'.repeat(2001) },
    { requestId: 'bad-request-id' },
    { voiceName: 'UnknownVoice' },
    { location: 'bad_loc' },
  ]) {
    await assert.rejects(generateVertexAudio({ ...f.options, ...change }, deps));
  }

  // ADC failure
  await assert.rejects(
    generateVertexAudio(f.options, {
      ...deps,
      getAuthHeaders: async () => { throw new Error('missing credentials'); },
    }),
    { code: 'AUTH_FAILED' }
  );

  assert.equal(calls, 0);
});

test('provider errors do not retry and IDs remain claimed', async t => {
  const f = await fixture(t);
  let calls = 0;
  const deps = {
    getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }),
    fetchImpl: async () => {
      calls++;
      return new Response('internal error', { status: 500 });
    },
  };

  await assert.rejects(generateVertexAudio(f.options, deps), { code: 'GENERATION_UNCERTAIN' });
  assert.equal(calls, 1);

  await assert.rejects(generateVertexAudio(f.options, deps), { code: 'DUPLICATE_REQUEST' });
  assert.equal(calls, 1);
});

test('symlinked audio output directory is rejected before provider call', async t => {
  const f = await fixture(t);
  const target = join(f.storageRoot, 'audio-target');
  await mkdir(target);
  await symlink(target, join(f.storageRoot, 'vertex-audio'));

  let calls = 0;
  await assert.rejects(
    generateVertexAudio(f.options, {
      getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }),
      fetchImpl: async () => { calls++; return f.response(); },
    }),
    { code: 'UNSAFE_OUTPUT' }
  );
  assert.equal(calls, 0);
});

test('concurrent executions sharing one ID can submit at most one audio request', async t => {
  const f = await fixture(t);
  let calls = 0;
  const deps = {
    getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }),
    fetchImpl: async () => { calls++; return f.response(); },
  };

  const results = await Promise.allSettled([
    generateVertexAudio(f.options, deps),
    generateVertexAudio(f.options, deps),
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'DUPLICATE_REQUEST');
});

test('WAV validator accepts complete PCM and a padded C2PA chunk', () => {
  const basic = createMockWav();
  assert.equal(validateWavBytes(basic), true);
  const metadata = Buffer.alloc(12);
  metadata.write('C2PA', 0, 'ascii'); metadata.writeUInt32LE(3, 4); metadata.write('abc', 8, 'ascii');
  const extended = Buffer.concat([basic, metadata]); extended.writeUInt32LE(extended.length - 8, 4);
  assert.equal(validateWavBytes(extended), true);
});

test('WAV validator rejects empty, truncated, inconsistent and unsupported PCM', () => {
  const original = createMockWav();
  const invalid = [original.subarray(0, 47), Buffer.from('RIFF....WAVE')];
  const mutate = (offset, value, size = 4) => {
    const b = Buffer.from(original);
    if (size === 2) b.writeUInt16LE(value, offset); else b.writeUInt32LE(value, offset);
    return b;
  };
  invalid.push(mutate(4, 99), mutate(16, 4), mutate(20, 3, 2), mutate(22, 2, 2), mutate(24, 16000), mutate(28, 0), mutate(32, 1, 2), mutate(34, 8, 2), mutate(40, 0), mutate(40, 3), mutate(40, 100));
  for (const bad of invalid) assert.throws(() => validateWavBytes(bad));
});

test('non-STOP, raw PCM, spoofed MIME, malformed or empty audio are rejected without a saved result', async t => {
  const f = await fixture(t);
  const response = (mimeType, bytes, finishReason = 'STOP') => new Response(JSON.stringify({ candidates: [{ finishReason, content: { parts: [{ inlineData: { mimeType, data: bytes.toString('base64') } }] } }] }));
  const cases = [
    ['audio/wav', f.wav, 'MAX_TOKENS'],
    ['audio/L16;rate=24000', Buffer.from([1, 2, 3, 4]), 'STOP'],
    ['audio/mpeg', f.wav, 'STOP'],
    ['audio/wav', Buffer.from([1, 2, 3, 4]), 'STOP'],
    ['audio/wav', Buffer.alloc(0), 'STOP'],
    ['audio/wav', f.wav.subarray(0, 47), 'STOP'],
  ];
  for (const [mimeType, bytes, finishReason] of cases) {
    const requestId = randomUUID(), options = { ...f.options, requestId };
    const deps = { getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }), fetchImpl: async () => response(mimeType, bytes, finishReason) };
    await assert.rejects(generateVertexAudio(options, deps), { code: 'GENERATION_UNCERTAIN' });
    await assert.rejects(readFile(join(f.storageRoot, 'vertex-audio', requestId, 'audio.wav')), { code: 'ENOENT' });
    await assert.rejects(generateVertexAudio(options, deps), { code: 'DUPLICATE_REQUEST' });
  }
});

test('partial writes and rename failure never publish audio or allow reuse of the request ID', async t => {
  const f = await fixture(t);
  for (const failure of ['write', 'rename']) {
    const requestId = randomUUID(), directory = join(f.storageRoot, 'vertex-audio', requestId);
    const deps = {
      getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }), fetchImpl: async () => f.response(),
      writeOutput: async (path, bytes, options) => {
        if (failure === 'write') { await writeFile(path, bytes.subarray(0, 4), options); throw new Error('disk full'); }
        await writeFile(path, bytes, options);
      },
      ...(failure === 'rename' ? { renameOutput: async () => { throw new Error('rename failed'); } } : {}),
    };
    const options = { ...f.options, requestId };
    await assert.rejects(generateVertexAudio(options, deps), { code: 'OUTPUT_FAILED_AFTER_CALL' });
    await assert.rejects(readFile(join(directory, 'audio.wav')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(directory, '.audio.partial')), { code: 'ENOENT' });
    await assert.rejects(generateVertexAudio(options, deps), { code: 'DUPLICATE_REQUEST' });
  }
});

test('an unexpected existing audio file is never overwritten', async t => {
  const f = await fixture(t); let existingPath;
  const deps = {
    getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }), fetchImpl: async () => f.response(),
    writeOutput: async (path, bytes, options) => {
      await writeFile(path, bytes, options);
      existingPath = join(f.storageRoot, 'vertex-audio', f.requestId, 'audio.wav');
      await writeFile(existingPath, 'existing data', { flag: 'wx' });
    },
  };
  await assert.rejects(generateVertexAudio(f.options, deps), { code: 'OUTPUT_FAILED_AFTER_CALL' });
  assert.equal(await readFile(existingPath, 'utf8'), 'existing data');
});
