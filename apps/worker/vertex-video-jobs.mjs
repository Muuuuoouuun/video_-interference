import { mkdir, lstat, realpath, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateVertexVideo, checkVertexVideoOperation, validateVideoOutput, VIDEO_MODEL, DEFAULT_VIDEO_LOCATION } from './vertex-video.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** A video submission is persisted before any paid request. Status checks
 * only query the existing operation and never resubmit generation. */
export function createVertexVideoJobs({ storageRoot, project, enabled = false, generate = generateVertexVideo, check = checkVertexVideoOperation, validateOutput = validateVideoOutput }) {
  const configured = enabled === true && PROJECT.test(project || '');
  const active = new Map(); let reserving = false;
  const verified = new Map();
  async function root() {
    await mkdir(storageRoot, { recursive: true, mode: 0o700 });
    const storage = await realpath(storageRoot), directory = join(storage, 'vertex-video-jobs');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw fail('생성 작업 저장 위치를 확인해 주세요.', 500);
    return directory;
  }
  async function save(directory, record) {
    const temporary = join(directory, 'status.tmp');
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, join(directory, 'status.json'));
  }
  async function readRecord(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw fail('작업 ID가 유효하지 않습니다.');
    const directory = join(await root(), id);
    try {
      const info = await lstat(directory), file = join(directory, 'status.json'), fileInfo = await lstat(file);
      if (!info.isDirectory() || info.isSymbolicLink() || !fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > 8192) throw new Error('invalid status');
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (record.id !== id || typeof record.createdAt !== 'string' || !['submitting', 'pending', 'interrupted'].includes(record.status)) throw new Error('invalid record');
      return { directory, record };
    } catch { throw fail('생성 작업을 찾지 못했습니다.', 404); }
  }
  async function operation(id) {
    const storage = await realpath(storageRoot), directory = join(storage, 'vertex-videos', id), file = join(directory, 'operation.json');
    try {
      const d = await lstat(directory), f = await lstat(file);
      if (!d.isDirectory() || d.isSymbolicLink() || !f.isFile() || f.isSymbolicLink() || f.size > 65536 || await realpath(file) !== file) return null;
      const item = JSON.parse(await readFile(file, 'utf8'));
      if (item.requestId !== id || item.project !== project || item.location !== DEFAULT_VIDEO_LOCATION || item.model !== VIDEO_MODEL || typeof item.operationName !== 'string') return null;
      return item;
    } catch { return null; }
  }
  async function resultFile(id) {
    const file = join(await realpath(storageRoot), 'vertex-videos', id, 'video.mp4');
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024 || await realpath(file).catch(() => '') !== file) return null;
    const fingerprint = `${info.size}:${info.mtimeMs}`;
    const cached = verified.get(id);
    if (cached?.fingerprint === fingerprint) return cached.valid ? file : null;
    try { await validateOutput(file); verified.set(id, { fingerprint, valid: true }); return file; }
    catch { verified.set(id, { fingerprint, valid: false }); return null; }
  }
  async function status(id) {
    const { record } = await readRecord(id), op = await operation(id);
    if (active.has(id)) return { id, status: active.get(id), createdAt: record.createdAt };
    if (op?.status === 'FAILED') return { id, status: 'failed', createdAt: record.createdAt, error: '영상 생성이 실패했습니다. 청구 내역을 확인해 주세요.' };
    if (await resultFile(id)) return { id, status: 'completed', createdAt: record.createdAt, videoUrl: `/api/vertex-video/jobs/${id}/video` };
    if (op && ['PENDING', 'RUNNING', 'POLL_TIMEOUT', 'SUCCEEDED'].includes(op.status)) return { id, status: 'pending', createdAt: record.createdAt, ...(record.checkFailed || op.status === 'SUCCEEDED' ? { error: '영상 결과를 확인하지 못했습니다. 상태를 다시 확인해 주세요.' } : {}) };
    return { id, status: 'interrupted', createdAt: record.createdAt, error: '제출 결과를 확인할 수 없습니다. 과금 여부를 확인해 주세요. 자동으로 다시 요청하지 않습니다.' };
  }
  async function submit(input) {
    if (!configured) throw fail('Vertex 영상 생성이 서버에서 활성화되지 않았습니다.', 403);
    if (!input || Object.keys(input).some(key => !['requestId', 'prompt'].includes(key)) || typeof input.requestId !== 'string' || !ID.test(input.requestId) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.prompt)) throw fail('요청 ID와 2,000자 이하의 영상 설명을 확인해 주세요.');
    if (reserving || active.size) throw fail('영상 작업이 진행 중입니다.', 409);
    reserving = true; const id = input.requestId, createdAt = new Date().toISOString();
    try {
      const directory = join(await root(), id);
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error?.code === 'EEXIST') throw fail('이미 사용한 요청 ID입니다.', 409); throw error; }
      await save(directory, { id, status: 'submitting', createdAt });
      active.set(id, 'submitting');
      void (async () => {
        try { await generate({ project, prompt: input.prompt, requestId: id, storageRoot, live: true, poll: false }); await save(directory, { id, status: 'pending', createdAt }); }
        catch { await save(directory, { id, status: 'interrupted', createdAt }).catch(() => {}); }
        finally { active.delete(id); }
      })();
      return { id, status: 'submitting', createdAt };
    } finally { reserving = false; }
  }
  async function checkStatus(id) {
    if (!configured) throw fail('Vertex 영상 생성이 서버에서 활성화되지 않았습니다.', 403);
    if (active.size || reserving) throw fail('영상 작업이 진행 중입니다.', 409);
    reserving = true;
    try {
      const current = await status(id), { directory, record } = await readRecord(id), op = await operation(id);
      if (current.status !== 'pending' || !op) throw fail('대기 중인 영상 작업만 확인할 수 있습니다.', 409);
      active.set(id, 'checking');
      void (async () => {
        try { await check({ project, location: DEFAULT_VIDEO_LOCATION, model: VIDEO_MODEL, operationName: op.operationName, requestId: id, storageRoot }); await save(directory, { id, status: 'pending', createdAt: record.createdAt }); }
        catch { await save(directory, { id, status: 'pending', createdAt: record.createdAt, checkFailed: true }).catch(() => {}); }
        finally { active.delete(id); }
      })();
      return { id, status: 'checking', createdAt: record.createdAt };
    } finally { reserving = false; }
  }
  async function list() {
    const directory = await root(), names = (await readdir(directory)).filter(name => ID.test(name));
    const entries = await Promise.all(names.map(async id => ({ id, info: await lstat(join(directory, id)).catch(() => null) })));
    const recent = entries.filter(item => item.info?.isDirectory() && !item.info.isSymbolicLink()).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, 20);
    const rows = [];
    for (let i = 0; i < recent.length; i += 3) rows.push(...await Promise.all(recent.slice(i, i + 3).map(({ id }) => status(id).catch(() => null))));
    return { enabled: configured, jobs: rows.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20) };
  }
  async function video(id) {
    if ((await status(id)).status !== 'completed') throw fail('완료된 영상만 열 수 있습니다.', 404);
    const path = await resultFile(id);
    if (!path) throw fail('영상을 찾지 못했습니다.', 404);
    return { path, mimeType: 'video/mp4', name: `vertex-${id}.mp4` };
  }
  return { configured, submit, status, checkStatus, list, video };
}
