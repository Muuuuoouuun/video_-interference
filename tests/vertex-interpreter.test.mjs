import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { GoogleAuth } from 'google-auth-library';
import { ffmpegPath, run } from '../apps/worker/engine.mjs';
import { interpretVertex } from '../apps/worker/vertex-interpreter.mjs';
import { validateAiResponse, interpreterMode, interpret } from '../apps/worker/interpreter.mjs';

const project = 'test-project-123';
const initialProject = process.env.VERTEX_PROJECT_ID;
const initialProvider = process.env.VI_INTERPRETER_PROVIDER;
const initialKey = process.env.ANTHROPIC_API_KEY;
const initialModel = process.env.ANTHROPIC_MODEL;
const comment = { id: 'comment', versionId: 'version', text: '2배속', frameIn: 20, frameOut: 40, sourceRanges: [{ start: 20, end: 40 }], drawings: [], attachmentIds: [] };
test.after(() => {
  for (const [key, value] of Object.entries({ VERTEX_PROJECT_ID: initialProject, VI_INTERPRETER_PROVIDER: initialProvider, ANTHROPIC_API_KEY: initialKey, ANTHROPIC_MODEL: initialModel })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('explicit Vertex takes priority even with a Claude key present', () => {
  process.env.VI_INTERPRETER_PROVIDER = 'vertex'; process.env.ANTHROPIC_API_KEY = 'irrelevant'; process.env.ANTHROPIC_MODEL = 'irrelevant';
  assert.equal(interpreterMode(), 'vertex');
  process.env.VI_INTERPRETER_PROVIDER = 'typo';
  assert.throws(() => interpreterMode(), /VI_INTERPRETER_PROVIDER/);
});

test('ADC request sends only selected parts to Vertex and proposals retain exact anchors', async () => {
  process.env.VERTEX_PROJECT_ID = project;
  const parts = [{ text: '2배속' }, { inlineData: { mimeType: 'image/jpeg', data: 'dGVzdA==' } }];
  let calls = 0;
  const value = await interpretVertex({ system: 'system', parts }, {
    getAuthHeaders: async url => { assert.match(url, /^https:\/\/aiplatform\.googleapis\.com\//); return { authorization: 'Bearer temporary-token', 'x-goog-api-key': 'never-forward' }; },
    fetchImpl: async (url, options) => {
      calls++;
      assert.match(url, /projects\/test-project-123\/locations\/global\/publishers\/google\/models\/gemini-3\.8-flash:generateContent$/);
      assert.equal(options.redirect, 'error');
      assert.deepEqual(options.headers, { 'content-type': 'application/json', authorization: 'Bearer temporary-token', 'x-goog-user-project': project });
      const body = JSON.parse(options.body); assert.deepEqual(body.contents[0].parts, parts); assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.equal(body.generationConfig.responseSchema.properties.ops.items.properties.params.properties.factor.type, 'NUMBER');
      assert.match(body.systemInstruction.parts[0].text, /params\.factor/);
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ ops: [{ type: 'speed', params: { factor: 2 } }] }) }] } }] }));
    },
  });
  assert.equal(calls, 1);
  const result = validateAiResponse(value, comment, [], 'vertex');
  assert.equal(result.mode, 'vertex'); assert.equal(result.ops[0].interpreter, 'vertex');
  assert.equal(result.ops[0].frameIn, 20); assert.equal(result.ops[0].frameOut, 40);
  assert.deepEqual(result.ops[0].sourceRanges, comment.sourceRanges); assert.equal(result.ops[0].status, 'proposed');
});

test('provider errors and invalid results do not fall back or leak credentials', async () => {
  process.env.VERTEX_PROJECT_ID = project; let calls = 0;
  for (const response of [new Response('secret-token', { status: 403 }), new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] }))]) {
    await assert.rejects(interpretVertex({ system: '', parts: [] }, { getAuthHeaders: async () => ({ authorization: 'Bearer secret-token' }), fetchImpl: async () => { calls++; return response; } }), error => !error.message.includes('secret-token') && /다른 API로 재시도하지 않았습니다/.test(error.message));
  }
  assert.equal(calls, 2);
  assert.throws(() => validateAiResponse({ ops: [{ type: 'speed', params: { factor: 99 } }] }, comment, [], 'vertex'), /배속/);
});

test('missing project or invalid ADC fails before network request', async () => {
  process.env.VERTEX_PROJECT_ID = 'invalid/project'; let calls = 0;
  await assert.rejects(interpretVertex({ system: '', parts: [] }, { fetchImpl: async () => { calls++; } }), /프로젝트 ID/);
  process.env.VERTEX_PROJECT_ID = project;
  await assert.rejects(interpretVertex({ system: '', parts: [] }, { getAuthHeaders: async () => ({ authorization: 'invalid' }), fetchImpl: async () => { calls++; } }), /인증에 실패/);
  assert.equal(calls, 0);
});

test('real frame extraction and interpretation pipeline sends only a still and retains anchors', async () => {
  process.env.VI_INTERPRETER_PROVIDER = 'vertex'; process.env.VERTEX_PROJECT_ID = project;
  const dir = await mkdtemp(join(tmpdir(), 'vi-vertex-interpret-'));
  const originalGetClient = GoogleAuth.prototype.getClient, originalFetch = globalThis.fetch;
  try {
    const movie = join(dir, 'sample.mp4');
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', movie]);
    GoogleAuth.prototype.getClient = async () => ({ getRequestHeaders: async () => ({ authorization: 'Bearer test-only' }) });
    let requests = 0;
    globalThis.fetch = async (url, options) => {
      requests++;
      const parts = JSON.parse(options.body).contents[0].parts;
      assert.equal(parts.length, 2); assert.equal(parts[0].inlineData.mimeType, 'image/jpeg');
      assert.ok(Buffer.from(parts[0].inlineData.data, 'base64').length > 100);
      const context = JSON.parse(parts[1].text); assert.equal(context.text, '2배속'); assert.equal(context.frameIn, 20); assert.equal(context.frameOut, 40);
      assert.ok(parts.every(part => !part.inlineData || part.inlineData.mimeType.startsWith('image/')));
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ops":[{"type":"speed","params":{"factor":2}}]}' }] } }] }));
    };
    const result = await interpret(comment, { attachments: [], files: {}, versionPath: movie, directory: dir });
    assert.equal(requests, 1); assert.equal(result.mode, 'vertex'); assert.equal(result.ops[0].params.factor, 2); assert.equal(result.ops[0].frameIn, 20);
  } finally {
    GoogleAuth.prototype.getClient = originalGetClient; globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('worker bootstrap samples stay local even when Vertex is selected', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vi-vertex-boot-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  let child;
  try {
    const movie = join(dir, 'sample.mp4');
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=13', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', movie]);
    child = spawn(process.execPath, ['apps/worker/server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), VI_STORAGE_ROOT: join(dir, 'store'), VI_SAMPLE_PATH: movie, VI_INTERPRETER_PROVIDER: 'vertex', VERTEX_PROJECT_ID: project, GOOGLE_APPLICATION_CREDENTIALS: join(dir, 'missing-credentials.json') }, stdio: 'ignore' });
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { const response = await fetch(`http://127.0.0.1:${port}/api/state`); state = await response.json(); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(state, 'worker did not start');
    assert.equal(state.capabilities.interpreter, 'vertex');
    assert.equal(state.comments.length, 2);
    assert.equal(state.ops.length, 2);
    assert.ok(state.ops.every(op => op.interpreter === 'local-rules'));
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref(); }); }
    await rm(dir, { recursive: true, force: true });
  }
});
