import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { prepareGeminiFeedback, analyzeGeminiFeedback } from '../apps/worker/gemini-feedback.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const key = 'unit-test-key-never-real';
const errorCode = code => error => error.code === code;
const envelope = items => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify({ items }) }] } }], usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 21, totalTokenCount: 34, invalid: key, thoughtsTokenCount: -1 } });
const analysis = (entry, changes = {}) => ({ id: entry.id, observedScene: '스틸에 붉은 도형이 보입니다.', feedbackSummary: entry.kind === 'note' ? '사용자가 기록한 문맥 메모입니다.' : '사용자가 제목을 위로 옮겨 달라고 요청했습니다.', questions: ['정확한 위치를 확인해 주세요.'], evidenceFrames: [entry.scenes[0].frame], ...changes });
const fetchResult = data => async () => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'gemini-feedback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = [];
  async function add(path, bytes, mimeType, role) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), bytes);
    const info = { path, mimeType, role, bytes: bytes.length, sha256: digest(bytes) }; files.push(info); return info;
  }
  const jpeg = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#e32636' } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#2655e3' } }).png().toBuffer();
  const scene = await add('scenes/version-001/frame-000075.jpg', jpeg, 'image/jpeg', 'scene');
  const second = await add('scenes/version-001/frame-000090.jpg', jpeg, 'image/jpeg', 'scene');
  const annotated = await add('annotations/feedback-0001/frame-000075.png', png, 'image/png', 'annotation');
  const reference = await add('attachments/asset-0001.png', png, 'image/png', 'attachment');
  const voice = await add('attachments/asset-0002.m4a', Buffer.from('private voice content not transmitted'), 'audio/mp4', 'attachment');
  const entry = {
    id: 'comment-one', kind: 'request', status: 'received', sceneDescription: { source: 'user', text: '사람이 제목을 가리키는 장면' },
    feedback: { original: '제목을 위로 옮겨 주세요.', supplements: [{ id: 'supplement-one', text: '너무 위쪽은 피해주세요.', createdAt: '2026-10-14' }, { id: 'supplement-two', text: '그림의 파란 부분은 참고 표시입니다.', createdAt: '2026-10-15' }] },
    authored: { versionId: 'version-one', versionNumber: 1, frameIn: 75, frameOut: 91, contextFrame: 75, sourceRanges: [{ frameIn: 75, frameOut: 91 }] },
    current: { versionId: 'version-two', status: 'partial', ranges: [{ frameIn: 45, frameOut: 51, sourceIn: 85, sourceOut: 91 }], contextFrame: null, contextStatus: 'deleted', deletedSourceRanges: [{ frameIn: 75, frameOut: 85 }] },
    drawings: [{ id: 'drawing-one', kind: 'rect', frame: 75, color: '#2655e3', points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.4 }], region: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 }, strokeWidth: 3 }],
    scenes: [{ frame: 75, file: scene.path, annotatedFile: annotated.path }, { frame: 90, file: second.path }],
    attachments: [{ id: 'ref-one', name: 'private filename.png', role: 'reference', file: reference.path, mimeType: 'image/png' }, { id: 'voice-one', name: 'private voice.m4a', role: 'voice', file: voice.path, mimeType: 'audio/mp4' }],
    mediaUrl: '/api/media/private-video', secretPath: '/Users/private/video.mov', layerTarget: { private: 'unselected details' },
  };
  const note = structuredClone(entry); note.id = 'comment-two'; note.kind = 'note'; note.drawings = []; note.scenes = [{ frame: 75, file: scene.path }]; note.attachments = [{ id: 'ref-one', role: 'insert', name: 'private filename.png', file: reference.path, mimeType: 'image/png' }];
  const manifest = { kind: 'video-feedback-handoff', schemaVersion: 1, sourceVideoIncluded: false, renderedVideoIncluded: false, project: { name: 'private project title' }, feedback: [entry, note], files };
  const manifestPath = join(directory, 'manifest.json'), save = () => writeFile(manifestPath, JSON.stringify(manifest));
  await save();
  return { directory, manifestPath, manifest, entry, note, save, add, jpeg, png };
}

test('Gemini preparation sends every selected still, annotation and image once with bindings, excluding video, voice and private metadata', async t => {
  const f = await fixture(t), before = await readFile(f.manifestPath), prepared = await prepareGeminiFeedback(f.manifestPath);
  assert.equal(prepared.summary.commentCount, 2);
  assert.equal(prepared.summary.imageCount, 4);
  assert.equal(prepared.summary.omittedVoiceCount, 1);
  assert.equal(prepared.summary.requestBytes, Buffer.byteLength(JSON.stringify(prepared.request)));
  assert.equal(prepared.summary.imageBytes, f.manifest.files.filter(file => file.mimeType.startsWith('image/')).reduce((sum, file) => sum + file.bytes, 0));
  assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.entries[0].feedback.supplements[0]) && Object.isFrozen(prepared.request.contents[0].parts));
  assert.throws(() => { prepared.entries[0].feedback.original = 'changed'; }, TypeError);
  assert.deepEqual(prepared.entries, f.manifest.feedback);
  const parts = prepared.request.contents[0].parts, text = JSON.parse(parts[0].text);
  assert.deepEqual(text.feedback[0].feedback.supplements.map(item => item.text), f.entry.feedback.supplements.map(item => item.text));
  assert.equal(text.feedback[1].kind, 'note');
  assert.equal(text.feedback[0].attachments.find(item => item.role === 'voice').included, false);
  assert.equal(parts.filter(part => part.inlineData).length, 4);
  assert.deepEqual(new Set(parts.filter(part => part.inlineData).map(part => part.inlineData.mimeType)), new Set(['image/jpeg', 'image/png']));
  for (let index = 1; index < parts.length; index += 2) {
    const label = JSON.parse(parts[index].text).image, bytes = Buffer.from(parts[index + 1].inlineData.data, 'base64');
    assert.equal(label.width, 32); assert.equal(label.height, 20);
    assert.ok(label.bindings.every(item => ['original_scene', 'annotation_preview', 'reference', 'insert_reference'].includes(item.type)));
    assert.ok(prepared.summary.sentFiles.some(file => file.sha256 === digest(bytes)));
  }
  assert.equal(prepared.summary.sentFiles.find(file => file.path.endsWith('asset-0001.png')).bindings.length, 2);
  const requestText = JSON.stringify(prepared.request);
  for (const secret of ['private project title', '/Users/private', '/api/media/', 'private filename', 'private voice content', 'unselected details', '.m4a', '.mov']) assert.ok(!requestText.includes(secret), `request excludes ${secret}`);
  assert.ok(prepared.request.systemInstruction.parts[0].text.includes('음성 전사는 하지 않았습니다'));
  assert.equal(prepared.request.generationConfig.responseMimeType, 'application/json');
  assert.equal(prepared.request.generationConfig.maxOutputTokens, 4096);
  assert.equal(prepared.request.generationConfig.responseJsonSchema.additionalProperties, false);
  assert.deepEqual(await readFile(f.manifestPath), before);
});

test('Gemini analysis makes one fixed-endpoint request and binds reordered results to immutable originals', async t => {
  const f = await fixture(t), prepared = await prepareGeminiFeedback(f.manifestPath); let calls = 0;
  const result = await analyzeGeminiFeedback(prepared, { apiKey: key, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-goog-api-key'], key); assert.ok(!url.includes(key));
    assert.deepEqual(JSON.parse(options.body), prepared.request); assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify(envelope([analysis(f.note), analysis(f.entry)])));
  } });
  assert.equal(calls, 1); assert.equal(result.provider, 'gemini');
  assert.equal(result.modelCalled, true); assert.equal(result.networkUsed, true);
  for (const flag of ['sourceVideoIncluded', 'renderedVideoIncluded', 'transcriptionPerformed']) assert.equal(result[flag], false);
  assert.deepEqual(result.usageMetadata, { promptTokenCount: 13, candidatesTokenCount: 21, totalTokenCount: 34 });
  assert.deepEqual(result.feedback.map(item => item.id), prepared.entries.map(item => item.id));
  for (const [index, entry] of prepared.entries.entries()) {
    assert.deepEqual(result.feedback[index].authored, entry.authored); assert.deepEqual(result.feedback[index].current, entry.current);
    assert.deepEqual(result.feedback[index].originalFeedback, entry.feedback); assert.deepEqual(result.feedback[index].sceneDescription, entry.sceneDescription);
  }
  result.feedback[0].originalFeedback.supplements[0].text = 'local result mutation';
  assert.equal(prepared.entries[0].feedback.supplements[0].text, f.entry.feedback.supplements[0].text);
  assert.ok(!JSON.stringify(result).includes(key));
});

test('Gemini preparation requires an exact small selection and never silently drops excess images or bytes', async t => {
  const f = await fixture(t);
  for (const selection of [[], ['missing'], ['comment-one', 'comment-one'], ['comment-one', null], 'comment-one']) await assert.rejects(prepareGeminiFeedback(f.manifestPath, { commentIds: selection }), errorCode('INVALID_FEEDBACK_BUNDLE'));
  f.manifest.feedback.push({ ...structuredClone(f.note), id: 'comment-three' }, { ...structuredClone(f.note), id: 'comment-four' }); await f.save();
  await assert.rejects(prepareGeminiFeedback(f.manifestPath), errorCode('FEEDBACK_LIMIT'));
  const one = await prepareGeminiFeedback(f.manifestPath, { commentIds: ['comment-two'] });
  assert.deepEqual(one.summary.commentIds, ['comment-two']); assert.equal(one.summary.imageCount, 2); assert.equal(one.summary.omittedVoiceCount, 0);
  f.manifest.feedback = [f.entry]; f.entry.scenes = [];
  for (let index = 0; index < 25; index++) {
    const path = `scenes/version-002/frame-${String(index).padStart(6, '0')}.jpg`;
    f.manifest.files.push({ ...f.manifest.files[0], path }); f.entry.scenes.push({ frame: index, file: path });
  }
  await f.save(); await assert.rejects(prepareGeminiFeedback(f.manifestPath), errorCode('IMAGE_LIMIT'));
  f.entry.scenes = [{ frame: 75, file: f.manifest.files[0].path }]; f.manifest.files[0].bytes = 10 * 1024 * 1024; await f.save();
  await assert.rejects(prepareGeminiFeedback(f.manifestPath), errorCode('REQUEST_TOO_LARGE'));
});

test('Gemini preparation verifies portable paths, inventory hashes, image type and symlink containment before any request', async t => {
  const f = await fixture(t), original = structuredClone(f.manifest);
  async function rejectMutation(mutate) { Object.assign(f.manifest, structuredClone(original)); f.entry = f.manifest.feedback[0]; mutate(); await f.save(); await assert.rejects(prepareGeminiFeedback(f.manifestPath), errorCode('INVALID_FEEDBACK_BUNDLE')); }
  await rejectMutation(() => { f.entry.scenes[0].file = '../outside.jpg'; });
  await rejectMutation(() => { f.entry.scenes[0].file = 'https://example.com/still.jpg'; });
  await rejectMutation(() => { f.manifest.files[0].path = '/Users/private/still.jpg'; });
  await rejectMutation(() => { f.manifest.files[0].mimeType = 'video/mp4'; });
  await rejectMutation(() => { f.manifest.files[0].sha256 = 'a'.repeat(64); });
  await rejectMutation(() => { f.manifest.files[0].bytes++; });
  await rejectMutation(() => { f.manifest.sourceVideoIncluded = true; });
  await rejectMutation(() => { f.manifest.feedback[1].id = f.entry.id; });
  await rejectMutation(() => { f.entry.feedback.supplements[0].text = null; });
  Object.assign(f.manifest, structuredClone(original));
  const scenePath = join(f.directory, original.files[0].path);
  await writeFile(scenePath, f.png); f.manifest.files[0].bytes = f.png.length; f.manifest.files[0].sha256 = digest(f.png); await f.save();
  await assert.rejects(prepareGeminiFeedback(f.manifestPath), errorCode('INVALID_FEEDBACK_BUNDLE'));
  Object.assign(f.manifest, structuredClone(original)); await f.save();
  const outside = await mkdtemp(join(tmpdir(), 'gemini-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideImage = join(outside, 'still.jpg'); await writeFile(outsideImage, f.jpeg); await rm(scenePath); await symlink(outsideImage, scenePath);
  await assert.rejects(prepareGeminiFeedback(f.manifestPath), error => error.code === 'INVALID_FEEDBACK_BUNDLE' && !error.message.includes(outside));
});

test('Gemini rejects altered response IDs, omitted feedback, unsupported frames, extra fields and incomplete or non-text results', async t => {
  const f = await fixture(t), prepared = await prepareGeminiFeedback(f.manifestPath), valid = [analysis(f.entry), analysis(f.note)];
  const invalid = [
    envelope([valid[0]]),
    envelope([valid[0], valid[0]]),
    envelope([valid[0], { ...valid[1], id: 'unknown' }]),
    envelope([{ ...valid[0], evidenceFrames: [999] }, valid[1]]),
    envelope([{ ...valid[0], evidenceFrames: [75, 75] }, valid[1]]),
    envelope([{ ...valid[0], questions: 'a question' }, valid[1]]),
    envelope([{ ...valid[0], observedScene: ' ' }, valid[1]]),
    envelope([{ ...valid[0], questions: [''] }, valid[1]]),
    envelope([{ ...valid[0], observedScene: 'x'.repeat(4001) }, valid[1]]),
    envelope([{ ...valid[0], operations: [] }, valid[1]]),
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: JSON.stringify({ items: valid }) }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'editVideo', args: {} } }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '```json\n{}\n```' }] } }] },
    { promptFeedback: { blockReason: 'SAFETY' } },
    { candidates: [null] },
  ];
  for (const value of invalid) await assert.rejects(analyzeGeminiFeedback(prepared, { apiKey: key, fetchImpl: fetchResult(value) }), error => ['INVALID_MODEL_RESPONSE', 'INCOMPLETE_MODEL_RESPONSE'].includes(error.code));
  await assert.rejects(analyzeGeminiFeedback(prepared, { apiKey: key, fetchImpl: async () => new Response('x'.repeat(130 * 1024)) }), errorCode('INVALID_MODEL_RESPONSE'));
});

test('Gemini missing keys, unsafe model names, forged requests and cancellation never make a network request', async t => {
  const f = await fixture(t), prepared = await prepareGeminiFeedback(f.manifestPath); let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('should not call'); };
  for (const apiKey of [undefined, '', '  ', 'bad\nkey']) await assert.rejects(analyzeGeminiFeedback(prepared, { apiKey, fetchImpl }), errorCode('MISSING_API_KEY'));
  for (const model of ['https://example.com', '../gemini-test', 'gemini-test?key=oops', 'models/gemini-test']) await assert.rejects(analyzeGeminiFeedback(prepared, { apiKey: key, model, fetchImpl }), errorCode('INVALID_MODEL'));
  await assert.rejects(analyzeGeminiFeedback(structuredClone(prepared), { apiKey: key, fetchImpl }), errorCode('INVALID_PREPARED_REQUEST'));
  const controller = new AbortController(); controller.abort(new Error(key));
  await assert.rejects(analyzeGeminiFeedback(prepared, { apiKey: key, fetchImpl, signal: controller.signal }), error => error.code === 'GEMINI_ABORTED' && !error.message.includes(key));
  assert.equal(calls, 0);
});

test('Gemini failures redact provider and transport detail and never retry failed or redirected requests', async t => {
  const f = await fixture(t), prepared = await prepareGeminiFeedback(f.manifestPath);
  const cases = [
    async () => new Response(JSON.stringify({ error: { message: `provider echoed ${key}` } }), { status: 403 }),
    async () => new Response('redirect', { status: 302, headers: { location: `https://example.com/?key=${key}` } }),
    async () => { throw new Error(`transport echoed ${key}`); },
    async () => { throw Object.assign(new Error(`spoofed error ${key}`), { code: 'GEMINI_HTTP_ERROR' }); },
    async () => new Response(`malformed JSON ${key}`),
  ];
  for (const implementation of cases) {
    let calls = 0;
    await assert.rejects(analyzeGeminiFeedback(prepared, { apiKey: key, fetchImpl: (...args) => { calls++; return implementation(...args); } }), error => !String(error).includes(key) && !error.cause && ['GEMINI_HTTP_ERROR', 'GEMINI_NETWORK_ERROR', 'INVALID_MODEL_RESPONSE'].includes(error.code));
    assert.equal(calls, 1);
  }
});

test('Gemini also applies the encoded JSON size limit to long feedback without truncating any supplement', async t => {
  const f = await fixture(t);
  for (const entry of f.manifest.feedback) entry.feedback.supplements = Array.from({ length: 100 }, (_, index) => ({ id: `long-${index}`, text: '가'.repeat(32_000) }));
  await f.save();
  await assert.rejects(prepareGeminiFeedback(f.manifestPath), errorCode('REQUEST_TOO_LARGE'));
});
