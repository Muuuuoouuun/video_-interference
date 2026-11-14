import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, stat, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { ffmpegPath, run } from './engine.mjs';
import { sampleFilmstripFrames } from './filmstrip.mjs';
import { extractCanonicalFrames } from './canonical-frames.mjs';
import { mapLimit, mediaConcurrency } from './parallel.mjs';
import { SHOT_THRESHOLD, parseSceneScores, sceneScoreFilter } from './scene-scores.mjs';

export { SHOT_THRESHOLD };

const CELL_WIDTH = 320, CELL_HEIGHT = 180, COLUMNS = 4, RENDERER = 'overview-v2';
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const abort = signal => signal?.throwIfAborted();
const clock = frame => { const milliseconds = Math.round(frame / 30 * 1000); return `${String(Math.floor(milliseconds / 60000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`; };
const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function shotsFromCuts(cuts, durationFrames) {
  const bounds = [0, ...cuts, durationFrames];
  return bounds.slice(0, -1).map((frameIn, index) => ({ index: index + 1, frameIn, frameOut: bounds[index + 1] }));
}

const GRID_FILTER = `scale=${CELL_WIDTH}:${CELL_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${CELL_WIDTH}:${CELL_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

async function videoStat(videoPath) {
  try { const source = await stat(videoPath); if (!source.isFile() || source.size === 0) throw failure('버전 영상 파일이 비어 있거나 유효하지 않습니다.', 404); return source; }
  catch (error) { if (error.code === 'ENOENT') throw failure('이 버전의 영상 파일을 찾지 못했습니다.', 404); throw error; }
}

const cutsPathFor = (directory, videoPath, source, durationFrames) => join(directory, `cuts-${createHash('sha256').update(JSON.stringify({ method: 'ffmpeg-scene-score', filter: sceneScoreFilter('scores'), threshold: SHOT_THRESHOLD, durationFrames, path: resolve(videoPath), size: source.size, modified: source.mtimeMs, changed: source.ctimeMs })).digest('hex')}.json`);

/** Persists cuts measured while the version file was being written (import or render), keyed to that exact file. */
export async function storeSceneCuts({ videoPath, durationFrames, scores, directory, source }) {
  const cuts = parseSceneScores(scores, durationFrames), path = cutsPathFor(directory, videoPath, await videoStat(videoPath), durationFrames);
  await mkdir(directory, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, JSON.stringify({ method: 'ffmpeg-scene-score', threshold: SHOT_THRESHOLD, source, durationFrames, cuts })); await rename(partial, path);
  return cuts;
}

async function readSceneCuts(path, durationFrames) {
  try {
    const stored = JSON.parse(await readFile(path, 'utf8'));
    const valid = stored.durationFrames === durationFrames && Array.isArray(stored.cuts) && stored.cuts.every((frame, index) => Number.isSafeInteger(frame) && frame > 0 && frame < durationFrames && (index === 0 || frame > stored.cuts[index - 1]));
    return valid ? { cuts: stored.cuts, source: typeof stored.source === 'string' ? stored.source : 'import-normalization' } : null;
  } catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) throw error; return null; }
}

async function identity({ versionId, videoPath, durationFrames, directory }) {
  if (typeof versionId !== 'string' || !/^[\w-]+$/.test(versionId)) throw failure('영상 개요의 버전 식별자가 유효하지 않습니다.');
  const frames = sampleFilmstripFrames(durationFrames), source = await videoStat(videoPath);
  const cacheKey = createHash('sha256').update(JSON.stringify({ renderer: RENDERER, threshold: SHOT_THRESHOLD, versionId, durationFrames, path: resolve(videoPath), size: source.size, modified: source.mtimeMs, changed: source.ctimeMs })).digest('hex');
  return { versionId, durationFrames, frames, cacheKey, imagePath: join(directory, `${cacheKey}.jpg`), manifestPath: join(directory, `${cacheKey}.json`), cutsPath: cutsPathFor(directory, videoPath, source, durationFrames) };
}

function layout(frames) {
  return frames.map((frame, index) => ({ frame, time: clock(frame), x: (index % COLUMNS) * CELL_WIDTH, y: Math.floor(index / COLUMNS) * CELL_HEIGHT, w: CELL_WIDTH, h: CELL_HEIGHT }));
}

/**
 * A 4-column overview grid from short exact seeks, plus estimated scene cuts. Cuts measured during import or render
 * are reused; otherwise one scene-only decode runs beside the grid extraction. Results are cached per version file.
 */
export async function prepareVersionOverview(options) {
  const { videoPath, directory, signal } = options;
  abort(signal);
  const info = await identity(options);
  try {
    const cached = JSON.parse(await readFile(info.manifestPath, 'utf8'));
    if (cached.cacheKey === info.cacheKey && JSON.stringify(cached.grid.cells.map(cell => cell.frame)) === JSON.stringify(info.frames)) {
      const metadata = await sharp(info.imagePath).metadata();
      if (metadata.format === 'jpeg' && metadata.width === cached.grid.width && metadata.height === cached.grid.height) { abort(signal); return { ...cached, imagePath: info.imagePath, cacheHit: true, diagnostics: { ffmpegRuns: 0 } }; }
    }
  } catch (error) { abort(signal); if (['EACCES', 'EPERM'].includes(error.code)) throw error; }
  await mkdir(directory, { recursive: true });
  const work = await mkdtemp(join(directory, '.overview-'));
  try {
    const precomputed = await readSceneCuts(info.cutsPath, info.durationFrames);
    const [grid, scenes] = await mapLimit([
      taskSignal => extractCanonicalFrames({ videoPath, frames: info.frames, directory: work, filter: GRID_FILTER, outputArgs: ['-q:v', '3'], threads: 1, concurrency: mediaConcurrency(), timeout: 300_000, signal: taskSignal }),
      async taskSignal => {
        if (precomputed) return { ...precomputed, runs: 0 };
        const scoresPath = join(work, 'scene-scores.txt');
        await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', sceneScoreFilter(scoresPath), '-f', 'null', '-'], { signal: taskSignal, timeout: 300_000 });
        return { cuts: parseSceneScores(await readFile(scoresPath, 'utf8'), info.durationFrames), source: 'version-decode', runs: 1 };
      },
    ], 2, (task, index, taskSignal) => task(taskSignal), signal);
    abort(signal);
    const cells = grid.paths;
    if (cells.some(path => !path)) throw failure('버전 길이와 실제 영상 프레임이 맞지 않아 영상 개요를 만들지 못했습니다.', 409);
    const positions = layout(info.frames), rows = Math.ceil(cells.length / COLUMNS), width = Math.min(cells.length, COLUMNS) * CELL_WIDTH, height = rows * CELL_HEIGHT;
    const labels = positions.map((cell, index) => `<rect x="${cell.x + 6}" y="${cell.y + CELL_HEIGHT - 30}" width="118" height="24" rx="4" fill="#000" fill-opacity="0.72"/><text x="${cell.x + 14}" y="${cell.y + CELL_HEIGHT - 12}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="15" fill="#fff">${escapeXml(`${index + 1} · ${cell.time}`)}</text>`).join('');
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels}</svg>`);
    const imagePath = join(work, 'grid.jpg');
    await sharp({ create: { width, height, channels: 3, background: '#000000' } }).composite([...cells.map((path, index) => ({ input: path, left: positions[index].x, top: positions[index].y })), { input: svg, left: 0, top: 0 }]).jpeg({ quality: 82 }).toFile(imagePath);
    abort(signal);
    const persisted = { renderer: RENDERER, cacheKey: info.cacheKey, versionId: info.versionId, durationFrames: info.durationFrames, fps: 30, grid: { width, height, columns: COLUMNS, cellWidth: CELL_WIDTH, cellHeight: CELL_HEIGHT, cells: positions }, shots: { method: 'ffmpeg-scene-score', threshold: SHOT_THRESHOLD, estimated: true, source: scenes.source, cuts: scenes.cuts, list: shotsFromCuts(scenes.cuts, info.durationFrames) } };
    const manifestPath = join(work, 'overview.json'); await writeFile(manifestPath, JSON.stringify(persisted));
    abort(signal);
    await rename(imagePath, info.imagePath); await rename(manifestPath, info.manifestPath);
    return { ...persisted, imagePath: info.imagePath, cacheHit: false, diagnostics: { ffmpegRuns: grid.runs + scenes.runs, gridRuns: grid.runs, sceneCutRuns: scenes.runs } };
  } finally { await rm(work, { recursive: true, force: true }); }
}
