import type { ApiError } from '../../../packages/core/types';
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error((value as ApiError).error || '작업을 완료하지 못했습니다.');
  return value as T;
}
export async function upload<T>(path: string, file: Blob, name: string, role?: string): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), ...(role ? { 'X-Asset-Role': role } : {}) }, body: file });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '파일을 가져오지 못했습니다.');
  return value as T;
}
