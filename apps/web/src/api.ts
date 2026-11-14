import type { ApiError } from '../../../packages/core/types';

const OFFLINE = '로컬 작업 서버에 연결하지 못했습니다. 앱이 실행 중인지 확인한 뒤 다시 시도해 주세요.';

/** A proxy error page or an empty body is reported with its HTTP status instead of a JSON parse error. */
function readResult<T>(status: number, ok: boolean, text: string, fallback: string): T {
  let value: unknown;
  if (text) { try { value = JSON.parse(text); } catch { value = undefined; } }
  if (!ok) throw new Error((value as ApiError | undefined)?.error || `${fallback} (HTTP ${status})`);
  if (value === undefined) throw new Error(`${fallback} 서버 응답을 읽지 못했습니다.`);
  return value as T;
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error(OFFLINE); }
  return readResult<T>(response.status, response.ok, await response.text(), '작업을 완료하지 못했습니다.');
}

export const isAbortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export interface UploadOptions { onProgress?: (sentBytes: number, totalBytes: number) => void; signal?: AbortSignal }

/** XHR instead of fetch: browsers report request-body progress only for XHR uploads. */
export function upload<T>(path: string, file: Blob, name: string, role?: string, { onProgress, signal }: UploadOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('업로드를 취소했습니다.', 'AbortError')); return; }
    const request = new XMLHttpRequest();
    const abort = () => request.abort(), settle = () => signal?.removeEventListener('abort', abort);
    request.open('POST', path);
    request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    request.setRequestHeader('X-File-Name', encodeURIComponent(name));
    if (role) request.setRequestHeader('X-Asset-Role', role);
    if (onProgress) request.upload.onprogress = event => onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    request.onload = () => { settle(); try { resolve(readResult<T>(request.status, request.status >= 200 && request.status < 300, request.responseText, '파일을 가져오지 못했습니다.')); } catch (error) { reject(error); } };
    request.onerror = () => { settle(); reject(new Error(OFFLINE)); };
    request.onabort = () => { settle(); reject(new DOMException('업로드를 취소했습니다.', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    request.send(file);
  });
}
