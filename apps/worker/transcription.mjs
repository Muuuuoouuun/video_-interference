import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ffmpegPath, run } from './engine.mjs';

/** Local speech-to-text through a user-installed whisper.cpp CLI. Nothing here opens a network connection. */
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const MAX_TEXT = 100_000, MAX_SEGMENTS = 5000;

export function transcriptionConfig(env = process.env) {
  const binary = env.WHISPER_CPP_PATH?.trim(), model = env.WHISPER_MODEL_PATH?.trim();
  if (!binary || !model) return null;
  const language = (env.WHISPER_LANGUAGE || 'ko').trim();
  if (!/^[a-z]{2,8}$|^auto$/.test(language)) return null;
  return { binary, model, language };
}

/** whisper.cpp `-oj` writes {transcription: [{offsets: {from, to}, text}]} with millisecond offsets. */
export function parseWhisperJson(value) {
  const items = value?.transcription;
  if (!Array.isArray(items)) throw fail('받아쓰기 결과 형식을 읽지 못했습니다.', 502);
  const segments = [];
  for (const item of items.slice(0, MAX_SEGMENTS)) {
    const startMs = Number(item?.offsets?.from), endMs = Number(item?.offsets?.to), text = String(item?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) throw fail('받아쓰기 결과의 시간 정보가 유효하지 않습니다.', 502);
    if (text) segments.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), text });
  }
  const text = segments.map(segment => segment.text).join(' ').slice(0, MAX_TEXT);
  return { text, segments };
}

export async function transcribeVoice({ audioPath, directory, config = transcriptionConfig(), signal, now = () => new Date().toISOString() }) {
  if (!config) throw fail('로컬 받아쓰기가 설정되지 않았습니다. WHISPER_CPP_PATH와 WHISPER_MODEL_PATH를 설정해 주세요.', 409);
  for (const [path, label] of [[config.binary, '받아쓰기 프로그램'], [config.model, '받아쓰기 모델']]) {
    try { if (!(await stat(path)).isFile()) throw new Error('not a file'); }
    catch { throw fail(`${label} 파일을 찾지 못했습니다: ${basename(path)}`, 409); }
  }
  await mkdir(directory, { recursive: true });
  const work = await mkdtemp(join(directory, 'transcribe-'));
  try {
    const wav = join(work, 'audio.wav'), output = join(work, 'transcript');
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', audioPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal, timeout: 120_000 });
    try { await run(config.binary, ['-m', config.model, '-f', wav, '-l', config.language, '-oj', '-of', output, '-np'], { signal, timeout: 900_000 }); }
    catch (error) { if (error.name === 'AbortError') throw error; throw fail('로컬 받아쓰기를 실행하지 못했습니다. whisper.cpp 경로와 모델을 확인해 주세요.', 502); }
    let parsed;
    try { parsed = JSON.parse(await readFile(`${output}.json`, 'utf8')); }
    catch { throw fail('받아쓰기 결과 파일을 읽지 못했습니다.', 502); }
    const { text, segments } = parseWhisperJson(parsed);
    return { source: 'asr', engine: 'whisper.cpp', model: basename(config.model), language: config.language, text, segments, createdAt: now() };
  } finally { await rm(work, { recursive: true, force: true }); }
}
