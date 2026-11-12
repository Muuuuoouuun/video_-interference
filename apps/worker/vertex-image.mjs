import { mkdir, lstat, realpath, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

export const IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
const OUTPUT_TOKEN_LIMIT = 2048;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });

function validate({ project, prompt, requestId, live }) {
  if (live !== true && live !== false) throw fail('INVALID_MODE', '실행 모드가 유효하지 않습니다.');
  if (typeof project !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw fail('INVALID_PROJECT', '프로젝트 ID를 확인해 주세요.');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) throw fail('INVALID_PROMPT', '설명은 제어 문자를 제외한 1~2000자로 입력해 주세요.');
  if (live && (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))) throw fail('INVALID_REQUEST_ID', '실행에는 새 UUID v4 요청 ID가 필요합니다.');
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
    const quotaProject = headers.get('x-goog-user-project');
    if (!authorization || !/^Bearer [\x21-\x7e]{1,8192}$/.test(authorization)) throw new Error('invalid authorization');
    if (quotaProject !== null && !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/.test(quotaProject)) throw new Error('invalid quota project');
    return { authorization, 'x-goog-user-project': project };
  } catch { throw fail('AUTH_FAILED', 'Google ADC 인증에 실패했습니다. 생성 요청은 보내지 않았습니다.'); }
  finally { clearTimeout(timer); }
}

async function reserve(storageRoot, requestId) {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(storageRoot);
  const outputRoot = join(root, 'vertex-images');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(outputRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(outputRoot) !== outputRoot) throw fail('UNSAFE_OUTPUT', '생성 결과 경로가 안전하지 않습니다.');
  const directory = join(outputRoot, requestId.toLowerCase());
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error?.code === 'EEXIST') throw fail('DUPLICATE_REQUEST', '이미 사용한 요청 ID입니다. 중복 생성 요청을 보내지 않았습니다.');
    throw fail('OUTPUT_FAILED', '결과 디렉터리를 만들지 못했습니다.');
  }
  return directory;
}

async function boundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('too large');
  if (!response.body) throw new Error('empty');
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_RESPONSE_BYTES) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readImage(data) {
  const candidates = data?.candidates;
  if (!Array.isArray(candidates) || candidates.length !== 1 || candidates[0]?.finishReason !== 'STOP') throw new Error('incomplete');
  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error('missing parts');
  const images = parts.filter(part => part?.inlineData);
  if (images.length !== 1) throw new Error('expected one image');
  const { mimeType, data: encoded } = images[0].inlineData;
  if (!['image/png', 'image/jpeg'].includes(mimeType) || typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('invalid image');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('invalid size');
  const image = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'error' });
  const metadata = await image.metadata();
  if ((mimeType === 'image/png' && metadata.format !== 'png') || (mimeType === 'image/jpeg' && metadata.format !== 'jpeg') || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) || metadata.width < 1 || metadata.height < 1 || metadata.width * metadata.height > 20_000_000 || (metadata.pages ?? 1) !== 1) throw new Error('invalid image type or dimensions');
  // Header inspection alone does not detect truncated compressed pixel data.
  await image.stats();
  return { bytes, mimeType, extension: mimeType === 'image/png' ? 'png' : 'jpg' };
}

/** Explicit one-shot image generation. A claimed ID is never reused, even if
 * the provider returns an error or the connection drops after submission. */
export async function generateVertexImage(options, { getAuthHeaders = defaultAuthHeaders, fetchImpl = fetch, writeOutput = writeFile, renameOutput = rename, removeOutput = rm } = {}) {
  const { project, prompt, requestId, storageRoot, live = false } = options;
  validate({ project, prompt, requestId, live });
  const preview = { mode: live ? 'live' : 'preview', provider: 'vertex', model: IMAGE_MODEL, location: 'global', candidates: 1, maxOutputTokens: OUTPUT_TOKEN_LIMIT, input: 'text-only', networkAttempted: false };
  if (!live) return preview;
  if (typeof storageRoot !== 'string' || !storageRoot || !resolve(storageRoot)) throw fail('UNSAFE_OUTPUT', '저장 경로가 필요합니다.');
  const url = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${IMAGE_MODEL}:generateContent`;
  const authHeaders = await getBoundedAuthHeaders(getAuthHeaders, url, project);
  const directory = await reserve(storageRoot, requestId);
  const body = { systemInstruction: { parts: [{ text: 'Generate exactly one image. Do not generate additional images.' }] }, contents: [{ role: 'user', parts: [{ text: prompt.trim() }] }], generationConfig: { candidateCount: 1, maxOutputTokens: OUTPUT_TOKEN_LIMIT, responseModalities: ['TEXT', 'IMAGE'] } };
  let image;
  try {
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000), headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('provider error'); }
    image = await readImage(await boundedJson(response));
  } catch { throw fail('GENERATION_UNCERTAIN', '요청 결과를 확인하지 못했습니다. 과금 가능성이 있으며 같은 ID로 자동 재시도하지 않습니다.'); }
  const output = join(directory, `image.${image.extension}`);
  const temporary = join(directory, '.image.partial');
  try {
    await writeOutput(temporary, image.bytes, { flag: 'wx', mode: 0o600 });
    try { await lstat(output); throw new Error('output already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await renameOutput(temporary, output);
  } catch {
    await removeOutput(temporary, { force: true }).catch(() => {});
    throw fail('OUTPUT_FAILED_AFTER_CALL', '이미지가 생성됐지만 저장하지 못했습니다. 과금 가능성이 있으며 같은 ID로 재시도하지 않습니다.');
  }
  return { ...preview, mode: 'live', networkAttempted: true, imageGenerated: true, output, mimeType: image.mimeType };
}
