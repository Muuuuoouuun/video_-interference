import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJsonBody } from '../apps/worker/request-body.mjs';

function request(chunks, contentType = 'application/json') {
  const req = Readable.from(chunks);
  req.headers = { 'content-type': contentType };
  return req;
}

test('HTTP JSON preserves Korean, emoji and combining marks across every byte boundary', async () => {
  const expected = { text: '후반 장면을 바꿔 주세요 🎬', sceneDescription: '가나다 é', nested: { text: '추가 지시' } };
  const bytes = Buffer.from(JSON.stringify(expected));
  for (let boundary = 1; boundary < bytes.length; boundary++) {
    assert.deepEqual(await readJsonBody(request([bytes.subarray(0, boundary), bytes.subarray(boundary)])), expected);
  }
  assert.deepEqual(await readJsonBody(request([...bytes].map(byte => Buffer.from([byte])))), expected);
});

test('HTTP JSON enforces actual byte count before decoding, including multibyte input', async () => {
  const bytes = Buffer.from(JSON.stringify({ text: '한글' }));
  assert.deepEqual(await readJsonBody(request([bytes]), bytes.length), { text: '한글' });
  await assert.rejects(readJsonBody(request([bytes.subarray(0, 5), bytes.subarray(5)]), bytes.length - 1), error => error.status === 413);
  let consumed = 0;
  const req = { headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { for (let i = 0; i < 1000; i++) { consumed++; yield Buffer.alloc(16); } } };
  await assert.rejects(readJsonBody(req, 32), error => error.status === 413);
  assert.equal(consumed, 3, 'stop reading as soon as the limit is exceeded');
});

test('HTTP JSON accepts object payloads and charset parameters, rejecting malformed or non-object bodies', async () => {
  assert.deepEqual(await readJsonBody(request([])), {});
  assert.deepEqual(await readJsonBody(request([Buffer.from('{"text":"한글"}')], 'Application/JSON; charset=utf-8')), { text: '한글' });
  for (const contentType of ['', 'text/plain', 'application/json-invalid']) {
    await assert.rejects(readJsonBody(request([], contentType)), error => error.status === 415);
  }
  for (const json of ['{', 'null', '[]', '"hello"', '42', 'true']) {
    await assert.rejects(readJsonBody(request([Buffer.from(json)])), error => error.status === 400);
  }
  const invalidUtf8 = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xed, 0x95]), Buffer.from('"}')]);
  await assert.rejects(readJsonBody(request([invalidUtf8])), error => error.status === 400);
});

test('HTTP JSON propagates disconnects instead of returning a partially read object', async () => {
  const disconnected = new Error('client disconnected');
  const req = { headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{"text":'); throw disconnected; } };
  await assert.rejects(readJsonBody(req), error => error === disconnected);
});
