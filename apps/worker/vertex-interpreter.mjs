// One explicit editing-interpretation request, authenticated with Google ADC.
// The caller supplies only the selected still, annotation and selected references.
const MODEL = 'gemini-3.8-flash';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Restrict property names as well as types; e.g. the renderer requires `factor`,
// while an unconstrained model may invent `speedFactor` instead.
const RESPONSE_SCHEMA = {
  type: 'OBJECT', required: ['ops'], properties: {
    ops: { type: 'ARRAY', items: { type: 'OBJECT', required: ['type', 'params'], properties: {
      type: { type: 'STRING', enum: ['cut', 'trim', 'speed', 'subtitle', 'overlay', 'audio', 'note'] },
      params: { type: 'OBJECT', properties: {
        factor: { type: 'NUMBER' }, volume: { type: 'NUMBER' }, text: { type: 'STRING' },
        kind: { type: 'STRING', enum: ['text', 'image', 'box', 'drawing'] }, assetRef: { type: 'STRING' }, color: { type: 'STRING' },
      } },
      aiNote: { type: 'STRING' },
    } } },
    clarification: { type: 'STRING' },
  },
};

async function adcHeaders(url) {
  const { GoogleAuth } = await import('google-auth-library');
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  return client.getRequestHeaders(url);
}

async function abortable(promise, signal) {
  signal.throwIfAborted();
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', listener); }
}

async function boundedJson(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('response too large');
  if (!response.body) throw new Error('empty response');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error('response too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function interpretVertex({ system, parts, signal }, { getAuthHeaders = adcHeaders, fetchImpl = fetch } = {}) {
  const project = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (typeof project !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error('Vertex 프로젝트 ID 설정을 확인해 주세요. AI 요청은 보내지 않았습니다.');
  const url = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${MODEL}:generateContent`;
  const deadline = AbortSignal.timeout(45_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let authorization;
  try {
    const headers = new Headers(await abortable(getAuthHeaders(url), combined));
    authorization = headers.get('authorization');
    if (!authorization || !/^Bearer [\x21-\x7e]{1,8192}$/.test(authorization)) throw new Error('missing token');
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    throw new Error('Vertex 인증에 실패했습니다. AI 요청은 보내지 않았습니다.');
  }
  try {
    const response = await fetchImpl(url, {
      method: 'POST', signal: combined, redirect: 'error',
      headers: { 'content-type': 'application/json', authorization, 'x-goog-user-project': project },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system + '\nUse the exact JSON parameter names: speed uses params.factor, audio uses params.volume, subtitle uses params.text, and overlay uses params.kind. Never invent parameter names.' }] }, contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'LOW' } } }),
    });
    if (!response.ok) throw new Error('provider failed');
    const payload = await boundedJson(response);
    if (!Array.isArray(payload.candidates) || payload.candidates.length !== 1 || payload.candidates[0].finishReason !== 'STOP') throw new Error('incomplete');
    const texts = payload.candidates[0]?.content?.parts;
    if (!Array.isArray(texts)) throw new Error('missing content');
    const text = texts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid response');
    return value;
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    throw new Error('Vertex AI 해석을 완료하지 못했습니다. 기존 요청은 유지되며 다른 API로 재시도하지 않았습니다.');
  }
}
