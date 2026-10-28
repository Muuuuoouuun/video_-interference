import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, stat, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { extractCanonicalFrames } from './canonical-frames.mjs';
import { mediaConcurrency } from './parallel.mjs';

const CELL_WIDTH = 160, CELL_HEIGHT = 90, RENDERER = 'filmstrip-v1';
// Thumbnails run beside playback, so they use at most two single-threaded decodes.
const FILMSTRIP_CONCURRENCY = 2;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const abort = signal => signal?.throwIfAborted();

/** Each cell represents the middle frame of an equal-width timeline bin. */
export function sampleFilmstripFrames(durationFrames) {
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1 || durationFrames > 72_000) throw failure('시간축 썸네일의 영상 길이가 유효하지 않습니다.');
  const count = Math.min(12, durationFrames);
  return Array.from({ length: count }, (_, index) => Math.floor((index + 0.5) * durationFrames / count));
}

async function identity({ versionId, videoPath, durationFrames, directory }) {
  if (typeof versionId !== 'string' || !/^[\w-]+$/.test(versionId)) throw failure('시간축 썸네일의 버전 식별자가 유효하지 않습니다.');
  const frames = sampleFilmstripFrames(durationFrames);
  let source;
  try { source = await stat(videoPath); if (!source.isFile() || source.size === 0) throw failure('버전 영상 파일이 비어 있거나 유효하지 않습니다.', 404); }
  catch (error) { if (error.code === 'ENOENT') throw failure('이 버전의 영상 파일을 찾지 못했습니다.', 404); throw error; }
  const cacheKey = createHash('sha256').update(JSON.stringify({ renderer: RENDERER, versionId, durationFrames, path: resolve(videoPath), size: source.size, modified: source.mtimeMs, changed: source.ctimeMs })).digest('hex');
  const manifest = { versionId, durationFrames, fps: 30, cellWidth: CELL_WIDTH, cellHeight: CELL_HEIGHT, frames };
  return { ...manifest, cacheKey, imagePath: join(directory, `${cacheKey}.png`), manifestPath: join(directory, `${cacheKey}.json`) };
}

async function cached(info, signal) {
  abort(signal);
  try {
    const manifest = JSON.parse(await readFile(info.manifestPath, 'utf8'));
    if (manifest.cacheKey !== info.cacheKey || manifest.versionId !== info.versionId || manifest.durationFrames !== info.durationFrames || JSON.stringify(manifest.frames) !== JSON.stringify(info.frames) || manifest.cellWidth !== CELL_WIDTH || manifest.cellHeight !== CELL_HEIGHT || manifest.fps !== 30) return null;
    const metadata = await sharp(info.imagePath).metadata();
    if (metadata.format !== 'png' || metadata.width !== CELL_WIDTH * info.frames.length || metadata.height !== CELL_HEIGHT) return null;
    abort(signal);
    return { ...info, cacheHit: true, diagnostics: { ffmpegRuns: 0, decodePasses: 0, elapsedMs: 0 } };
  } catch (error) { abort(signal); if (['EACCES', 'EPERM'].includes(error.code)) throw error; return null; }
}

/** A cache read never starts a native process, so it can serve while a render is running. */
export async function readFilmstripCache(options) {
  abort(options.signal);
  return cached(await identity(options), options.signal);
}

/** Short seek+decode runs extract exact canonical frame indexes; completed output publishes atomically. */
export async function prepareFilmstrip(options) {
  const { videoPath, directory, signal } = options;
  abort(signal);
  const info = await identity(options), hit = await cached(info, signal);
  if (hit) return hit;
  await mkdir(directory, { recursive: true });
  const work = await mkdtemp(join(directory, '.filmstrip-')), started = performance.now();
  try {
    const filter = `scale=${CELL_WIDTH}:${CELL_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${CELL_WIDTH}:${CELL_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
    const extracted = await extractCanonicalFrames({ videoPath, frames: info.frames, directory: work, filter, extension: 'png', threads: 1, concurrency: mediaConcurrency(FILMSTRIP_CONCURRENCY), signal });
    abort(signal);
    const cells = extracted.paths;
    if (cells.some(path => !path)) throw failure('버전 길이와 실제 영상 프레임이 맞지 않아 시간축 썸네일을 만들지 못했습니다.', 409);
    const imagePath = join(work, 'sprite.png');
    await sharp({ create: { width: CELL_WIDTH * cells.length, height: CELL_HEIGHT, channels: 3, background: '#000000' } }).composite(cells.map((path, index) => ({ input: path, left: index * CELL_WIDTH, top: 0 }))).png().toFile(imagePath);
    abort(signal);
    const persisted = { versionId: info.versionId, durationFrames: info.durationFrames, fps: 30, cellWidth: CELL_WIDTH, cellHeight: CELL_HEIGHT, frames: info.frames, cacheKey: info.cacheKey };
    const manifestPath = join(work, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(persisted));
    abort(signal);
    await rename(imagePath, info.imagePath); await rename(manifestPath, info.manifestPath);
    return { ...info, cacheHit: false, diagnostics: { ffmpegRuns: extracted.runs, decodePasses: extracted.runs, elapsedMs: Math.round(performance.now() - started) } };
  } finally { await rm(work, { recursive: true, force: true }); }
}
