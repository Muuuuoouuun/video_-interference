import { mkdir, lstat, realpath, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateVertexImage } from './vertex-image.mjs';
import sharp from 'sharp';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** Independent from the existing render queue: the on-disk marker prevents
 * a restarted app from silently repeating a potentially charged request. */
export function createVertexImageJobs({ storageRoot, project, enabled = false, generate = generateVertexImage }) {
  const configured = enabled === true && PROJECT.test(project || '');
  const active = new Map();
  let reserving = false;
  async function root() {
    await mkdir(storageRoot, { recursive: true, mode: 0o700 });
    const storage = await realpath(storageRoot), directory = join(storage, 'vertex-image-jobs');
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
  async function recoverExtension(id) {
    const storage = await realpath(storageRoot), directory = join(storage, 'vertex-images', id), found = [];
    for (const extension of ['png', 'jpg']) {
      const file = join(directory, `image.${extension}`), info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || await realpath(file).catch(() => '') !== file) continue;
      try {
        const image = sharp(file, { limitInputPixels: 20_000_000, failOn: 'error' });
        const metadata = await image.metadata();
        if (metadata.format !== (extension === 'png' ? 'png' : 'jpeg') || !metadata.width || !metadata.height || metadata.width * metadata.height > 20_000_000 || (metadata.pages ?? 1) !== 1) continue;
        await image.stats(); found.push(extension);
      } catch { /* Ignore incomplete or invalid output. */ }
    }
    return found.length === 1 ? found[0] : null;
  }
  async function status(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw fail('작업 ID가 유효하지 않습니다.');
    const directory = join(await root(), id);
    let info, data;
    try {
      info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid directory');
      const file = join(directory, 'status.json');
      const fileInfo = await lstat(file);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > 8192) throw new Error('invalid status');
      data = JSON.parse(await readFile(file, 'utf8'));
    } catch { throw fail('생성 작업을 찾지 못했습니다.', 404); }
    if (!data || data.id !== id || typeof data.createdAt !== 'string' || !['running', 'completed', 'failed'].includes(data.status)) throw fail('생성 작업 상태를 읽지 못했습니다.', 500);
    if (data.status === 'running' && !active.has(id)) {
      const extension = await recoverExtension(id);
      if (extension) return { id, status: 'completed', createdAt: data.createdAt, extension, imageUrl: `/api/vertex-image/jobs/${id}/image` };
      return { id, status: 'interrupted', createdAt: data.createdAt, error: '앱이 중단되어 생성 결과와 과금 여부를 확인해야 합니다. 자동으로 다시 요청하지 않습니다.' };
    }
    if (data.status === 'completed' && !['png', 'jpg'].includes(data.extension)) throw fail('생성 결과를 찾지 못했습니다.', 500);
    return { id, status: data.status, createdAt: data.createdAt, ...(data.status === 'failed' ? { error: '생성에 실패했거나 결과를 확인하지 못했습니다. 과금 여부를 확인해 주세요.' } : {}), ...(data.status === 'completed' ? { extension: data.extension, imageUrl: `/api/vertex-image/jobs/${id}/image` } : {}) };
  }
  async function submit(input) {
    if (!configured) throw fail('Vertex 이미지 생성이 서버에서 활성화되지 않았습니다.', 403);
    if (!input || Object.keys(input).some(key => !['requestId', 'prompt'].includes(key)) || typeof input.requestId !== 'string' || !ID.test(input.requestId) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.prompt)) throw fail('요청 ID와 2,000자 이하의 이미지 설명을 확인해 주세요.');
    if (reserving || active.size) throw fail('이미지 생성 작업이 진행 중입니다.', 409);
    reserving = true;
    const id = input.requestId, createdAt = new Date().toISOString();
    let directory;
    try {
      directory = join(await root(), id);
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error?.code === 'EEXIST') throw fail('이미 사용한 요청 ID입니다.', 409); throw error; }
      await save(directory, { id, status: 'running', createdAt });
      const task = (async () => {
        try {
          const result = await generate({ project, prompt: input.prompt, requestId: id, storageRoot, live: true });
          const extension = result.mimeType === 'image/png' ? 'png' : result.mimeType === 'image/jpeg' ? 'jpg' : null;
          if (!extension || result.output !== join(await realpath(storageRoot), 'vertex-images', id, `image.${extension}`)) throw new Error('invalid generated image');
          await save(directory, { id, status: 'completed', createdAt, extension });
        } catch { await save(directory, { id, status: 'failed', createdAt }).catch(() => {}); }
        finally { active.delete(id); }
      })();
      active.set(id, task);
      return { id, status: 'running', createdAt };
    } finally { reserving = false; }
  }
  async function list() {
    const directory = await root();
    const names = (await readdir(directory)).filter(name => ID.test(name));
    const entries = await Promise.all(names.map(async id => ({ id, info: await lstat(join(directory, id)).catch(() => null) })));
    const recent = entries.filter(item => item.info?.isDirectory() && !item.info.isSymbolicLink()).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, 20);
    const rows = await Promise.all(recent.map(({ id }) => status(id).catch(() => null)));
    return { enabled: configured, jobs: rows.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20) };
  }
  async function image(id) {
    const job = await status(id);
    if (job.status !== 'completed') throw fail('완료된 이미지만 열 수 있습니다.', 404);
    const file = join(await realpath(storageRoot), 'vertex-images', id, `image.${job.extension}`);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || await realpath(file).catch(() => '') !== file) throw fail('이미지를 찾지 못했습니다.', 404);
    return { path: file, mimeType: job.extension === 'png' ? 'image/png' : 'image/jpeg', name: `vertex-${id}.${job.extension}` };
  }
  return { configured, submit, status, list, image };
}
