import { mkdir, lstat, realpath, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const AUDIO_MODEL = 'gemini-3.8-flash-lite-tts';
export const DEFAULT_AUDIO_LOCATION = 'global';
export const DEFAULT_VOICE = 'Puck';
export const SUPPORTED_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'];
export const MAX_PROMPT_LENGTH = 2000;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16MB

const fail = (code, message) => Object.assign(new Error(message), { code });

function validateAudioOptions({ project, prompt, requestId, live, location, voiceName }) {
  if (live !== true && live !== false) throw fail('INVALID_MODE', '실행 모드가 유효하지 않습니다.');
  if (typeof project !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    throw fail('INVALID_PROJECT', '프로젝트 ID를 확인해 주세요.');
  }
  if (location !== undefined && (typeof location !== 'string' || !/^(?:global|[a-z]+(?:-[a-z]+)+[0-9])$/.test(location))) {
    throw fail('INVALID_LOCATION', '리전 설정이 유효하지 않습니다.');
  }
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) {
    throw fail('INVALID_PROMPT', `대사는 제어 문자를 제외한 1~${MAX_PROMPT_LENGTH}자로 입력해 주세요.`);
  }
  if (voiceName !== undefined && !SUPPORTED_VOICES.includes(voiceName)) {
    throw fail('INVALID_VOICE', `지원하는 음성은 ${SUPPORTED_VOICES.join(', ')} 입니다.`);
  }
  if (live && (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))) {
    throw fail('INVALID_REQUEST_ID', '실행에는 새 UUID v4 요청 ID가 필요합니다.');
  }
}

async function defaultAuthHeaders(url) {
  const { GoogleAuth } = await import('google-auth-library');
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  return client.getRequestHeaders(url);
}

async function getBoundedAuthHeaders(getAuthHeaders, url, project) {
  let timer;
  try {
    const received = await Promise.race([
      getAuthHeaders(url),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 20_000); }),
    ]);
    const headers = new Headers(received);
    const authorization = headers.get('authorization');
    const quotaProject = headers.get('x-goog-user-project') || project;
    if (!authorization || !/^Bearer [\x21-\x7e]{1,8192}$/.test(authorization)) throw new Error('invalid authorization');
    if (quotaProject && !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/.test(quotaProject)) throw new Error('invalid quota project');
    return {
      authorization,
      'x-goog-user-project': project,
    };
  } catch {
    throw fail('AUTH_FAILED', 'Google ADC 인증에 실패했습니다. 생성 요청은 보내지 않았습니다.');
  } finally {
    clearTimeout(timer);
  }
}

async function reserveAudioDirectory(storageRoot, requestId) {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(storageRoot);
  const outputRoot = join(root, 'vertex-audio');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(outputRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(outputRoot)) !== outputRoot) {
    throw fail('UNSAFE_OUTPUT', '생성 결과 경로가 안전하지 않습니다.');
  }
  const directory = join(outputRoot, requestId.toLowerCase());
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw fail('DUPLICATE_REQUEST', '이미 사용한 요청 ID입니다. 중복 생성 요청을 보내지 않았습니다.');
    }
    throw fail('OUTPUT_FAILED', '결과 디렉터리를 만들지 못했습니다.');
  }
  return directory;
}

async function boundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('too large');
  if (!response.body) throw new Error('empty');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_RESPONSE_BYTES) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Validate the complete unary Gemini 3.8 TTS WAV. Throws for incomplete or
 * unsupported data and returns true for 24 kHz mono signed 16-bit PCM. */
export function validateWavBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 46 || bytes.length > MAX_RESPONSE_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) !== bytes.length - 8) throw new Error('invalid WAV header');
  let position = 12, formatSeen = false, dataSeen = false, chunks = 0;
  while (position < bytes.length) {
    if (++chunks > 4096 || position + 8 > bytes.length) throw new Error('invalid WAV chunk');
    const kind = bytes.toString('ascii', position, position + 4);
    const size = bytes.readUInt32LE(position + 4);
    const content = position + 8, end = content + size, paddedEnd = end + (size & 1);
    if (end > bytes.length || paddedEnd > bytes.length) throw new Error('truncated WAV chunk');
    if (kind === 'fmt ') {
      if (formatSeen || size < 16 || bytes.readUInt16LE(content) !== 1 || bytes.readUInt16LE(content + 2) !== 1 || bytes.readUInt32LE(content + 4) !== 24_000 || bytes.readUInt32LE(content + 8) !== 48_000 || bytes.readUInt16LE(content + 12) !== 2 || bytes.readUInt16LE(content + 14) !== 16) throw new Error('unsupported WAV format');
      formatSeen = true;
    } else if (kind === 'data') {
      if (dataSeen || size < 2 || size % 2 !== 0) throw new Error('empty or incomplete WAV samples');
      dataSeen = true;
    }
    position = paddedEnd;
  }
  if (!formatSeen || !dataSeen || position !== bytes.length) throw new Error('missing WAV audio');
  return true;
}

function parseAudioPayload(data) {
  const candidates = data?.candidates;
  if (!Array.isArray(candidates) || candidates.length !== 1 || candidates[0]?.finishReason !== 'STOP') {
    throw new Error('expected exactly one candidate');
  }
  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error('missing parts');
  const audioParts = parts.filter((p) => p?.inlineData);
  if (audioParts.length !== 1) throw new Error('expected exactly one audio part');

  const { mimeType, data: encoded } = audioParts[0].inlineData;
  if (typeof mimeType !== 'string' || mimeType.trim().toLowerCase() !== 'audio/wav') throw new Error('unsupported audio MIME');
  if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('invalid base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_RESPONSE_BYTES) throw new Error('invalid size');

  validateWavBytes(bytes);
  return { bytes, mimeType: 'audio/wav', extension: 'wav' };
}

/** Explicit one-shot audio generation via Vertex AI. */
export async function generateVertexAudio(options, {
  getAuthHeaders = defaultAuthHeaders,
  fetchImpl = fetch,
  writeOutput = writeFile,
  renameOutput = rename,
  removeOutput = rm,
} = {}) {
  const {
    project,
    prompt,
    requestId,
    storageRoot,
    live = false,
    location = DEFAULT_AUDIO_LOCATION,
    voiceName = DEFAULT_VOICE,
    model = AUDIO_MODEL,
  } = options;

  validateAudioOptions({ project, prompt, requestId, live, location, voiceName });

  const preview = {
    mode: live ? 'live' : 'preview',
    provider: 'vertex',
    model,
    location,
    voiceName,
    input: 'text-only',
    networkAttempted: false,
    status: 'preview',
  };

  if (!live) return preview;
  if (typeof storageRoot !== 'string' || !storageRoot || !resolve(storageRoot)) {
    throw fail('UNSAFE_OUTPUT', '저장 경로가 필요합니다.');
  }

  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const authHeaders = await getBoundedAuthHeaders(getAuthHeaders, url, project);

  const directory = await reserveAudioDirectory(storageRoot, requestId);

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt.trim() }],
      },
    ],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          voice: voiceName,
        },
      },
    },
  };

  let audio;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`provider error status ${response.status}`);
    }
    audio = parseAudioPayload(await boundedJson(response));
  } catch (err) {
    throw fail('GENERATION_UNCERTAIN', '음성 생성 요청 결과를 확인하지 못했습니다. 과금 가능성이 있으며 같은 ID로 자동 재시도하지 않습니다.');
  }

  const outputPath = join(directory, `audio.${audio.extension}`);
  const temporary = join(directory, '.audio.partial');
  try {
    await writeOutput(temporary, audio.bytes, { flag: 'wx', mode: 0o600 });
    try { await lstat(outputPath); throw new Error('output already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await renameOutput(temporary, outputPath);
  } catch {
    await removeOutput(temporary, { force: true }).catch(() => {});
    throw fail('OUTPUT_FAILED_AFTER_CALL', '음성이 생성됐지만 저장하지 못했습니다. 과금 가능성이 있으며 같은 ID로 재시도하지 않습니다.');
  }

  return {
    ...preview,
    mode: 'live',
    networkAttempted: true,
    status: 'completed',
    audioGenerated: true,
    output: outputPath,
    mimeType: audio.mimeType,
    requestId,
  };
}
