import { mkdir, lstat, realpath, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { probe, run, ffmpegPath } from './engine.mjs';

export const VIDEO_MODEL = 'veo-3.1-lite-generate-001';
export const DEFAULT_VIDEO_LOCATION = 'us-central1';
export const MAX_PROMPT_LENGTH = 2000;
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024; // 64MB
export const DEFAULT_MAX_POLL_ATTEMPTS = 30;
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const SUPPORTED_ASPECT_RATIOS = ['16:9', '9:16', '1:1'];
export const SUPPORTED_DURATIONS = [4, 5, 6, 8];

const fail = (code, message) => Object.assign(new Error(message), { code });

function validateEndpoint(project, location, model) {
  if (typeof project !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw fail('INVALID_PROJECT', '프로젝트 ID를 확인해 주세요.');
  if (typeof location !== 'string' || !/^(?:global|[a-z]+(?:-[a-z]+)+[0-9])$/.test(location)) throw fail('INVALID_LOCATION', '리전 설정이 유효하지 않습니다.');
  if (model !== VIDEO_MODEL) throw fail('INVALID_MODEL', '지원하지 않는 영상 모델입니다.');
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const parsed = new URL(`https://${host}`);
  if (parsed.protocol !== 'https:' || parsed.hostname !== host || parsed.port || parsed.username || parsed.password || parsed.pathname !== '/') throw fail('INVALID_LOCATION', '리전 엔드포인트가 유효하지 않습니다.');
  return host;
}

function validOperationName(operationName, project, location, model) {
  if (typeof operationName !== 'string' || operationName.length > 1024) return false;
  const match = /^projects\/([a-z0-9-]+)\/locations\/([a-z0-9-]+)\/(?:publishers\/google\/models\/([a-z0-9.-]+)\/)?operations\/([a-zA-Z0-9._-]+)$/.exec(operationName);
  return Boolean(match && (match[1] === project || /^[0-9]{6,20}$/.test(match[1])) && match[2] === location && (!match[3] || match[3] === model));
}

function validateVideoOptions({ project, prompt, requestId, live, location, durationSeconds, aspectRatio }) {
  if (live !== true && live !== false) throw fail('INVALID_MODE', '실행 모드가 유효하지 않습니다.');
  if (typeof project !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    throw fail('INVALID_PROJECT', '프로젝트 ID를 확인해 주세요.');
  }
  if (location !== undefined && (typeof location !== 'string' || !/^(?:global|[a-z]+(?:-[a-z]+)+[0-9])$/.test(location))) {
    throw fail('INVALID_LOCATION', '리전 설정이 유효하지 않습니다.');
  }
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) {
    throw fail('INVALID_PROMPT', `설명은 제어 문자를 제외한 1~${MAX_PROMPT_LENGTH}자로 입력해 주세요.`);
  }
  if (durationSeconds !== undefined && !SUPPORTED_DURATIONS.includes(durationSeconds)) {
    throw fail('INVALID_DURATION', `영상 길이는 ${SUPPORTED_DURATIONS.join(', ')}초 중 하나여야 합니다.`);
  }
  if (aspectRatio !== undefined && !SUPPORTED_ASPECT_RATIOS.includes(aspectRatio)) {
    throw fail('INVALID_ASPECT_RATIO', `화면비는 ${SUPPORTED_ASPECT_RATIOS.join(', ')} 중 하나여야 합니다.`);
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

async function reserveVideoDirectory(storageRoot, requestId) {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(storageRoot);
  const outputRoot = join(root, 'vertex-videos');
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

async function writeStateFile(directory, state) {
  const path = join(directory, 'operation.json');
  const temporary = join(directory, `.operation-${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

export async function validateVideoOutput(path) {
  const result = await probe(path);
  if (!result.streams?.some(stream => stream.codec_type === 'video') || !Number.isFinite(Number(result.format?.duration)) || Number(result.format.duration) <= 0) throw new Error('invalid video');
  await run(ffmpegPath, ['-v', 'error', '-xerror', '-i', path, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'], { timeout: 30_000 });
}

async function boundedJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('too large');
  if (!response.body) throw new Error('empty');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validateMp4Bytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16) throw new Error('invalid mp4 size');
  const boxType = bytes.toString('latin1', 4, 8);
  if (boxType !== 'ftyp') {
    throw new Error('invalid mp4 signature');
  }
}

function extractVideoFromPrediction(prediction) {
  if (!prediction || typeof prediction !== 'object') throw new Error('missing prediction');
  const rawBytes = prediction.bytesBase64Encoded || prediction.video?.bytesBase64Encoded;
  if (typeof rawBytes !== 'string' || !rawBytes.length) throw new Error('missing video payload');
  const buffer = Buffer.from(rawBytes, 'base64');
  validateMp4Bytes(buffer);
  return {
    bytes: buffer,
    mimeType: prediction.mimeType || 'video/mp4',
  };
}

/** Explicit video generation using Vertex AI Long-Running Operations (LRO). */
export async function generateVertexVideo(options, {
  getAuthHeaders = defaultAuthHeaders,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  validateOutput = validateVideoOutput,
} = {}) {
  const {
    project,
    prompt,
    requestId,
    storageRoot,
    live = false,
    location = DEFAULT_VIDEO_LOCATION,
    durationSeconds = 4,
    aspectRatio = '16:9',
    model = VIDEO_MODEL,
    resolution = '720p',
    poll = false,
    maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;

  validateVideoOptions({ project, prompt, requestId, live, location, durationSeconds, aspectRatio });
  const host = validateEndpoint(project, location, model);

  const preview = {
    mode: live ? 'live' : 'preview',
    provider: 'vertex',
    model,
    location,
    durationSeconds,
    aspectRatio,
    resolution,
    fps: 24,
    input: 'text-only',
    networkAttempted: false,
    status: 'preview',
  };

  if (!live) return preview;
  if (typeof storageRoot !== 'string' || !storageRoot || !resolve(storageRoot)) {
    throw fail('UNSAFE_OUTPUT', '저장 경로가 필요합니다.');
  }

  const url = `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predictLongRunning`;
  const authHeaders = await getBoundedAuthHeaders(getAuthHeaders, url, project);

  const directory = await reserveVideoDirectory(storageRoot, requestId);
  const now = new Date().toISOString();
  const initialRecord = {
    requestId,
    project,
    location,
    model,
    durationSeconds,
    aspectRatio,
    resolution,
    createdAt: now,
    updatedAt: now,
    status: 'SUBMITTING',
  };
  await writeStateFile(directory, initialRecord);

  const body = {
    instances: [{ prompt: prompt.trim() }],
    parameters: {
      sampleCount: 1,
      durationSeconds,
      aspectRatio,
      resolution,
      fps: 24,
      personGeneration: 'dont_allow',
    },
  };

  let operationData;
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
    operationData = await boundedJson(response, 1024 * 1024);
  } catch (err) {
    const failedRecord = {
      ...initialRecord,
      status: 'SUBMISSION_FAILED',
      updatedAt: new Date().toISOString(),
      error: '제출 요청 실패',
    };
    await writeStateFile(directory, failedRecord).catch(() => {});
    throw fail('GENERATION_UNCERTAIN', '영상 생성 요청 결과를 확인하지 못했습니다. 과금 가능성이 있으며 같은 ID로 자동 재시도하지 않습니다.');
  }

  const operationName = operationData?.name;
  if (!validOperationName(operationName, project, location, model)) {
    const failedRecord = {
      ...initialRecord,
      status: 'INVALID_OPERATION_RESPONSE',
      updatedAt: new Date().toISOString(),
    };
    await writeStateFile(directory, failedRecord).catch(() => {});
    throw fail('GENERATION_UNCERTAIN', '유효하지 않은 장기 작업 식별자가 반환되었습니다. 과금 가능성이 있으며 같은 ID로 재시도하지 않습니다.');
  }

  const submittedRecord = {
    ...initialRecord,
    operationName,
    status: 'PENDING',
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeStateFile(directory, submittedRecord);

  const baseResult = {
    ...preview,
    mode: 'live',
    networkAttempted: true,
    operationName,
    requestId,
    status: 'PENDING',
    statePath: join(directory, 'operation.json'),
  };

  if (!poll) {
    return baseResult;
  }

  return await pollVertexVideoOperation({
    project,
    location,
    model,
    operationName,
    requestId,
    storageRoot,
    authHeaders,
    maxPollAttempts,
    pollIntervalMs,
    fetchImpl,
    sleepImpl,
    validateOutput,
  });
}

/** Poll an existing Vertex Video Operation until completion or timeout. */
export async function pollVertexVideoOperation({
  project,
  location = DEFAULT_VIDEO_LOCATION,
  model = VIDEO_MODEL,
  operationName,
  requestId,
  storageRoot,
  authHeaders,
  getAuthHeaders = defaultAuthHeaders,
  maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  validateOutput = validateVideoOutput,
  singleCheck = false,
}) {
  const host = validateEndpoint(project, location, model);
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw fail('INVALID_REQUEST_ID', '요청 ID를 확인해 주세요.');
  }
  if (!validOperationName(operationName, project, location, model)) {
    throw fail('INVALID_OPERATION_NAME', '유효한 작업 식별자가 필요합니다.');
  }
  if (!Number.isInteger(maxPollAttempts) || maxPollAttempts < 1 || maxPollAttempts > 30 || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60_000) throw fail('INVALID_POLL_OPTIONS', '상태 조회 횟수 또는 간격이 유효하지 않습니다.');
  const root = await realpath(storageRoot);
  const outputRoot = join(root, 'vertex-videos');
  const outputStat = await lstat(outputRoot).catch(() => null);
  if (!outputStat || !outputStat.isDirectory() || outputStat.isSymbolicLink() || await realpath(outputRoot) !== outputRoot) throw fail('UNSAFE_OUTPUT', '작업 보관 경로가 안전하지 않습니다.');
  const directory = join(outputRoot, requestId.toLowerCase());
  const dirStat = await lstat(directory).catch(() => null);
  if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw fail('UNSAFE_OUTPUT', '작업 디렉터리를 찾을 수 없거나 안전하지 않습니다.');
  }

  const statePath = join(directory, 'operation.json');
  const stateStat = await lstat(statePath).catch(() => null);
  if (!stateStat || !stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.size > 65_536) throw fail('INVALID_SAVED_OPERATION', '저장된 작업 정보를 확인할 수 없습니다.');
  let saved;
  try { saved = JSON.parse(await readFile(statePath, 'utf8')); }
  catch { throw fail('INVALID_SAVED_OPERATION', '저장된 작업 정보를 읽을 수 없습니다.'); }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || typeof saved.requestId !== 'string' || saved.requestId.toLowerCase() !== requestId.toLowerCase() || saved.operationName !== operationName || (saved.project !== undefined && saved.project !== project) || (saved.location !== undefined && saved.location !== location) || (saved.model !== undefined && saved.model !== model)) throw fail('INVALID_SAVED_OPERATION', '저장된 작업과 요청 정보가 일치하지 않습니다.');

  // Vertex AI Veo uses :fetchPredictOperation for LRO status querying
  const fetchUrl = `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:fetchPredictOperation`;

  const headers = await getBoundedAuthHeaders(authHeaders ? async () => authHeaders : getAuthHeaders, fetchUrl, project);

  let attempts = 0;
  while (attempts < maxPollAttempts) {
    attempts++;
    let response, opResult;
    try {
      response = await fetchImpl(fetchUrl, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operationName }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`poll HTTP status ${response.status}`);
      }
      opResult = await boundedJson(response, MAX_RESPONSE_BYTES);
    } catch {
      if (attempts >= maxPollAttempts) {
        throw fail('LRO_POLL_ERROR', '작업 상태 조회 중 오류가 지속되었습니다. 상태 파일을 확인하세요.');
      }
      await sleepImpl(pollIntervalMs);
      continue;
    }

    if (opResult?.done) {
      if (opResult.error) {
        const errorRecord = {
          ...saved,
          requestId,
          operationName,
          status: 'FAILED',
          error: '영상 작업이 공급자에서 실패했습니다.',
          updatedAt: new Date().toISOString(),
        };
        await writeStateFile(directory, errorRecord).catch(() => {});
        throw fail('LRO_FAILED', '영상 생성이 공급자에서 실패했습니다.');
      }

      // Veo returns response.videos or response.predictions
      const videos = opResult.response?.videos || opResult.response?.predictions;
      if (!Array.isArray(videos) || !videos.length) {
        throw fail('LRO_FAILED', '작업은 완료되었으나 생성된 영상 데이터가 없습니다.');
      }
      const video = extractVideoFromPrediction(videos[0]);
      const outputPath = join(directory, 'video.mp4');
      const temporary = join(directory, '.video.partial');
      try {
        await writeFile(temporary, video.bytes, { flag: 'wx', mode: 0o600 });
        await validateOutput(temporary);
        try { await lstat(outputPath); throw new Error('output already exists'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await rename(temporary, outputPath);
      } catch (writeErr) {
        await rm(temporary, { force: true }).catch(() => {});
        throw fail('OUTPUT_FAILED_AFTER_CALL', '영상이 생성되었으나 로컬에 저장하지 못했습니다.');
      }

      const successRecord = {
        ...saved,
        requestId,
        operationName,
        status: 'SUCCEEDED',
        videoFile: 'video.mp4',
        mimeType: video.mimeType,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeStateFile(directory, successRecord);

      return {
        mode: 'live',
        provider: 'vertex',
        model,
        location,
        networkAttempted: true,
        status: 'SUCCEEDED',
        videoGenerated: true,
        output: outputPath,
        mimeType: video.mimeType,
        requestId,
        operationName,
      };
    }

    const runningRecord = {
      ...saved,
      requestId,
      operationName,
      status: 'RUNNING',
      attempts,
      updatedAt: new Date().toISOString(),
    };
    await writeStateFile(directory, runningRecord).catch(() => {});

    if (singleCheck) return { mode: 'live', provider: 'vertex', model, location, requestId, operationName, status: 'RUNNING', networkAttempted: true };

    if (attempts < maxPollAttempts) {
      await sleepImpl(pollIntervalMs);
    }
  }

  const timeoutRecord = {
    ...saved,
    requestId,
    operationName,
    status: 'POLL_TIMEOUT',
    attempts,
    updatedAt: new Date().toISOString(),
  };
  await writeStateFile(directory, timeoutRecord).catch(() => {});
  throw fail('LRO_TIMEOUT', `최대 폴링 횟수(${maxPollAttempts}회)를 초과했습니다. 작업은 백그라운드에서 계속 진행 중일 수 있습니다.`);
}

/** Check operation status once without long polling. */
export async function checkVertexVideoOperation(options, {
  getAuthHeaders = defaultAuthHeaders,
  fetchImpl = fetch,
  validateOutput = validateVideoOutput,
} = {}) {
  const { project, location = DEFAULT_VIDEO_LOCATION, model = VIDEO_MODEL, operationName, requestId, storageRoot } = options;
  if (!requestId || !operationName || !storageRoot) {
    throw fail('INVALID_OPTIONS', 'requestId, operationName, storageRoot가 모두 필요합니다.');
  }
  return await pollVertexVideoOperation({
    project,
    location,
    model,
    operationName,
    requestId,
    storageRoot,
    getAuthHeaders,
    fetchImpl,
    validateOutput,
    singleCheck: true,
    maxPollAttempts: 1,
    pollIntervalMs: 0,
    sleepImpl: () => Promise.resolve(),
  });
}
