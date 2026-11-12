import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { generateVertexImage } from '../apps/worker/vertex-image.mjs';

async function fixture(t) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'vertex-image-test-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#af831d' } }).png().toBuffer();
  const options = { project: 'sample-project-123', prompt: 'a yellow balloon', requestId: randomUUID(), storageRoot, live: true };
  const response = () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] }));
  return { options, png, response };
}

test('preview uses neither authentication, network nor output files', async t => {
  const f = await fixture(t);
  const result = await generateVertexImage({ ...f.options, live: false }, { getAuthHeaders: () => { throw new Error('auth called'); }, fetchImpl: () => { throw new Error('network called'); } });
  assert.equal(result.networkAttempted, false); assert.equal(result.mode, 'preview');
  await assert.rejects(readFile(join(f.options.storageRoot, 'vertex-images')), { code: 'ENOENT' });
  const cli = spawnSync(process.execPath, ['scripts/vertex-image.mjs', '--project', f.options.project], { cwd: process.cwd(), input: f.options.prompt, encoding: 'utf8', env: { ...process.env, VI_STORAGE_ROOT: f.options.storageRoot, GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent' } });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).networkAttempted, false);
  assert.ok(!cli.stdout.includes(f.options.prompt));
});

test('live uses one fixed Vertex request, bounded output and ADC token, saving one local image', async t => {
  const f = await fixture(t); let fetchCalls = 0, tokenCalls = 0;
  const result = await generateVertexImage(f.options, { getAuthHeaders: async () => { tokenCalls++; return new Headers({ authorization: 'Bearer offline-test-token' }); }, fetchImpl: async (url, options) => {
    fetchCalls++;
    assert.equal(url, 'https://aiplatform.googleapis.com/v1/projects/sample-project-123/locations/global/publishers/google/models/gemini-3.1-flash-lite-image:generateContent');
    assert.equal(options.headers.authorization, 'Bearer offline-test-token');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.generationConfig, { candidateCount: 1, maxOutputTokens: 2048, responseModalities: ['TEXT', 'IMAGE'] });
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: f.options.prompt }] }]);
    return f.response();
  } });
  assert.equal(fetchCalls, 1); assert.equal(tokenCalls, 1); assert.equal(result.imageGenerated, true);
  assert.deepEqual(await readFile(result.output), f.png);
  assert.ok(!JSON.stringify(result).includes('offline-test-token')); assert.ok(!JSON.stringify(result).includes(f.options.prompt));
  await assert.rejects(generateVertexImage(f.options, { getAuthHeaders: async () => new Headers({ authorization: 'Bearer offline-test-token' }), fetchImpl: () => { throw new Error('duplicate call'); } }), { code: 'DUPLICATE_REQUEST' });
});

test('invalid input and auth failure never call the provider', async t => {
  const f = await fixture(t); let calls = 0;
  const deps = { getAuthHeaders: async () => new Headers({ authorization: 'Bearer safe-token' }), fetchImpl: async () => { calls++; return f.response(); } };
  for (const change of [{ project: 'project/evil' }, { prompt: '' }, { prompt: 'x'.repeat(2001) }, { requestId: '../escape' }]) await assert.rejects(generateVertexImage({ ...f.options, ...change }, deps));
  await assert.rejects(generateVertexImage(f.options, { ...deps, getAuthHeaders: async () => { throw new Error('secret-token'); } }), error => error.code === 'AUTH_FAILED' && !error.message.includes('secret-token'));
  assert.equal(calls, 0);
});

test('provider failures and ambiguous multiple images do not retry and IDs remain claimed', async t => {
  const f = await fixture(t); let calls = 0;
  const deps = { getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }), fetchImpl: async () => { calls++; return new Response('sensitive provider data', { status: 503 }); } };
  await assert.rejects(generateVertexImage(f.options, deps), error => error.code === 'GENERATION_UNCERTAIN' && !error.message.includes('sensitive'));
  await assert.rejects(generateVertexImage(f.options, deps), { code: 'DUPLICATE_REQUEST' });
  assert.equal(calls, 1);
  const two = { ...f.options, requestId: randomUUID() };
  const imagePart = { inlineData: { mimeType: 'image/png', data: f.png.toString('base64') } };
  await assert.rejects(generateVertexImage(two, { ...deps, fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [imagePart, imagePart] } }] })) }), { code: 'GENERATION_UNCERTAIN' });
});

test('a symlinked output directory is rejected before provider call', async t => {
  const f = await fixture(t); const elsewhere = join(f.options.storageRoot, 'elsewhere');
  await mkdir(elsewhere); await symlink(elsewhere, join(f.options.storageRoot, 'vertex-images'));
  let calls = 0;
  await assert.rejects(generateVertexImage(f.options, { getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }), fetchImpl: async () => { calls++; return f.response(); } }), { code: 'UNSAFE_OUTPUT' });
  assert.equal(calls, 0);
});

test('concurrent executions sharing one ID can submit at most one generation request', async t => {
  const f = await fixture(t); let calls = 0;
  const deps = { getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }), fetchImpl: async () => { calls++; return f.response(); } };
  const results = await Promise.allSettled([generateVertexImage(f.options, deps), generateVertexImage(f.options, deps)]);
  assert.equal(calls, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'DUPLICATE_REQUEST');
});

test('oversized or incomplete responses are not persisted or retried', async t => {
  const f = await fixture(t);
  const deps = { getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }), fetchImpl: async () => new Response('x', { headers: { 'content-length': String(13 * 1024 * 1024) } }) };
  await assert.rejects(generateVertexImage(f.options, deps), { code: 'GENERATION_UNCERTAIN' });
  await assert.rejects(readFile(join(f.options.storageRoot, 'vertex-images', f.options.requestId, 'image.png')), { code: 'ENOENT' });
  await assert.rejects(generateVertexImage(f.options, deps), { code: 'DUPLICATE_REQUEST' });
});

test('truncated PNG and JPEG with readable headers are not reported or saved as valid images', async t => {
  const f = await fixture(t);
  for (const format of ['png', 'jpeg']) {
    const original = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#7b5639' } })[format]().toBuffer();
    let truncated;
    for (let end = 1; end < original.length; end++) {
      const candidate = original.subarray(0, end);
      try { await sharp(candidate, { failOn: 'error' }).metadata(); } catch { continue; }
      try { await sharp(candidate, { failOn: 'error' }).stats(); } catch { truncated = candidate; break; }
    }
    assert.ok(truncated, `expected ${format} header to be readable before its pixel data is complete`);
    const requestId = randomUUID();
    const content = { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: `image/${format}`, data: truncated.toString('base64') } }] } }] };
    await assert.rejects(generateVertexImage({ ...f.options, requestId }, { getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }), fetchImpl: async () => new Response(JSON.stringify(content)) }), { code: 'GENERATION_UNCERTAIN' });
    await assert.rejects(readFile(join(f.options.storageRoot, 'vertex-images', requestId, `image.${format === 'jpeg' ? 'jpg' : format}`)), { code: 'ENOENT' });
  }
});

test('ADC authorization and quota-project headers are sent only to the fixed Vertex endpoint', async t => {
  const f = await fixture(t); let authCalls = 0;
  const result = await generateVertexImage(f.options, {
    getAuthHeaders: async url => {
      authCalls++;
      assert.equal(url, 'https://aiplatform.googleapis.com/v1/projects/sample-project-123/locations/global/publishers/google/models/gemini-3.1-flash-lite-image:generateContent');
      return new Headers({ authorization: 'Bearer private-token', 'x-goog-user-project': 'billing-project-123', 'x-unrelated-secret': 'not-forwarded' });
    },
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).hostname, 'aiplatform.googleapis.com');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, 'Bearer private-token');
      assert.equal(options.headers['x-goog-user-project'], f.options.project);
      assert.equal(options.headers['x-unrelated-secret'], undefined);
      return f.response();
    },
  });
  assert.equal(authCalls, 1);
  assert.ok(!JSON.stringify(result).includes('private-token'));
  assert.ok(!JSON.stringify(result).includes('billing-project-123'));
  assert.ok(!JSON.stringify(result).includes('not-forwarded'));
});

test('ADC quota project is optional and malformed auth metadata prevents calls', async t => {
  const f = await fixture(t); let calls = 0;
  const fetchImpl = async (_url, options) => { calls++; assert.equal(options.headers['x-goog-user-project'], f.options.project); return f.response(); };
  await generateVertexImage(f.options, { getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }), fetchImpl });
  for (const headers of [{ authorization: 'Basic token' }, { authorization: 'Bearer token', 'x-goog-user-project': 'bad/project' }]) {
    await assert.rejects(generateVertexImage({ ...f.options, requestId: randomUUID() }, { getAuthHeaders: async () => new Headers(headers), fetchImpl }), { code: 'AUTH_FAILED' });
  }
  assert.equal(calls, 1);
});

test('partial writes and rename failures never publish the final image or allow duplicate requests', async t => {
  const f = await fixture(t);
  for (const failure of ['write', 'rename']) {
    const requestId = randomUUID(), directory = join(f.options.storageRoot, 'vertex-images', requestId);
    const deps = {
      getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }),
      fetchImpl: async () => f.response(),
      writeOutput: async (path, bytes, options) => {
        if (failure === 'write') { await writeFile(path, bytes.subarray(0, 4), options); throw new Error('disk full'); }
        await writeFile(path, bytes, options);
      },
      ...(failure === 'rename' ? { renameOutput: async () => { throw new Error('rename failed'); } } : {}),
    };
    const options = { ...f.options, requestId };
    await assert.rejects(generateVertexImage(options, deps), { code: 'OUTPUT_FAILED_AFTER_CALL' });
    await assert.rejects(readFile(join(directory, 'image.png')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(directory, '.image.partial')), { code: 'ENOENT' });
    await assert.rejects(generateVertexImage(options, deps), { code: 'DUPLICATE_REQUEST' });
  }
});

test('an unexpected existing final file is never overwritten', async t => {
  const f = await fixture(t); let existingPath;
  const deps = {
    getAuthHeaders: async () => new Headers({ authorization: 'Bearer token' }), fetchImpl: async () => f.response(),
    writeOutput: async (path, bytes, options) => {
      await writeFile(path, bytes, options);
      existingPath = join(f.options.storageRoot, 'vertex-images', f.options.requestId, 'image.png');
      await writeFile(existingPath, 'existing user content', { flag: 'wx' });
    },
  };
  await assert.rejects(generateVertexImage(f.options, deps), { code: 'OUTPUT_FAILED_AFTER_CALL' });
  assert.equal(await readFile(existingPath, 'utf8'), 'existing user content');
});
