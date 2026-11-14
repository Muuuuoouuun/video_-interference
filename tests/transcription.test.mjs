import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegPath, run } from '../apps/worker/engine.mjs';
import { parseWhisperJson, transcribeVoice, transcriptionConfig } from '../apps/worker/transcription.mjs';
import { fakeWhisper } from './fake-whisper.mjs';

test('whisper.cpp JSON becomes trimmed text and millisecond segments; malformed output is rejected', () => {
  assert.deepEqual(parseWhisperJson({ transcription: [{ offsets: { from: 0, to: 1200 }, text: ' 안녕  하세요 ' }, { offsets: { from: 1200, to: 1300 }, text: ' ' }] }), { text: '안녕 하세요', segments: [{ startMs: 0, endMs: 1200, text: '안녕 하세요' }] });
  for (const bad of [{}, { transcription: [{ offsets: { from: 5, to: 1 }, text: 'x' }] }, { transcription: [{ offsets: {}, text: 'x' }] }]) assert.throws(() => parseWhisperJson(bad));
});

test('local transcription is configured only by explicit paths and a safe language code', () => {
  assert.equal(transcriptionConfig({}), null);
  assert.equal(transcriptionConfig({ WHISPER_CPP_PATH: '/x/whisper-cli' }), null);
  assert.deepEqual(transcriptionConfig({ WHISPER_CPP_PATH: '/x/whisper-cli', WHISPER_MODEL_PATH: '/x/model.bin' }), { binary: '/x/whisper-cli', model: '/x/model.bin', language: 'ko' });
  assert.equal(transcriptionConfig({ WHISPER_CPP_PATH: '/x/w', WHISPER_MODEL_PATH: '/x/m', WHISPER_LANGUAGE: 'ko; rm -rf' }), null);
});

test('voice memos are converted to 16 kHz mono WAV, transcribed locally and labelled as automatic output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-interference-transcribe-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const audio = join(directory, 'voice.m4a');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'aac', audio]);
  const fake = await fakeWhisper(directory), config = { binary: fake.binary, model: fake.model, language: 'ko' };
  const transcript = await transcribeVoice({ audioPath: audio, directory: join(directory, 'jobs'), config, now: () => '2026-10-15T00:00:00.000Z' });
  assert.deepEqual(transcript, { source: 'asr', engine: 'whisper.cpp', model: 'ggml-test.bin', language: 'ko', text: '자막을 조금 더 크게 해 주세요', segments: [{ startMs: 0, endMs: 1500, text: '자막을 조금 더' }, { startMs: 1500, endMs: 2800, text: '크게 해 주세요' }], createdAt: '2026-10-15T00:00:00.000Z' });
  const args = (await readFile(fake.calls, 'utf8')).trim().split('\n');
  assert.deepEqual([args[0], args[1], args[4], args[5], args[6]], ['-m', fake.model, '-l', 'ko', '-oj']);
  assert.deepEqual(await readdir(join(directory, 'jobs')), [], 'temporary WAV and JSON are removed');
  await assert.rejects(transcribeVoice({ audioPath: audio, directory, config: null }), error => error.status === 409 && /WHISPER_CPP_PATH/.test(error.message));
  await assert.rejects(transcribeVoice({ audioPath: audio, directory, config: { ...config, model: join(directory, 'missing.bin') } }), error => error.status === 409 && /missing\.bin/.test(error.message));
  await writeFile(fake.binary, '#!/bin/sh\nexit 4\n');
  await assert.rejects(transcribeVoice({ audioPath: audio, directory, config }), error => error.status === 502 && /whisper\.cpp/.test(error.message));
});
