import type { ApiError } from '../../../packages/core/types';
const OFFLINE = '로컬 작업 서버에 연결하지 못했습니다. `npm run dev`가 실행 중인지 확인한 뒤 다시 연결하세요.';
async function readJson<T>(response: Response, fallback: string): Promise<T> {
  // Proxies and crashed workers can answer with HTML or an empty body; keep the message actionable instead of a JSON parse error.
  let value: unknown = null;
  try { value = await response.json(); }
  catch { if (response.ok) throw new Error(fallback); }
  if (!response.ok) throw new Error((value as ApiError | null)?.error || (response.status >= 502 ? OFFLINE : fallback));
  return value as T;
}
async function send(path: string, init: RequestInit) {
  try { return await fetch(path, init); }
  catch { throw new Error(OFFLINE); }
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await send(path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return readJson<T>(response, '작업을 완료하지 못했습니다.');
}
export async function upload<T>(path: string, file: Blob, name: string, role?: string): Promise<T> {
  const response = await send(path, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), ...(role ? { 'X-Asset-Role': role } : {}) }, body: file });
  return readJson<T>(response, '파일을 가져오지 못했습니다.');
}
