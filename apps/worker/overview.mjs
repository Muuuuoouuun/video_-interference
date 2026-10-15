import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, stat, rename, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { ffmpegPath, run } from './engine.mjs';
import { sampleFilmstripFrames } from './filmstrip.mjs';

const CELL_WIDTH = 320, CELL_HEIGHT = 180, COLUMNS = 4, RENDERER = 'overview-v1';
export const SHOT_THRESHOLD = 0.3;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const abort = signal => signal?.throwIfAborted();
const clock = frame => { const milliseconds = Math.round(frame / 30 * 1000); return `${String(Math.floor(milliseconds / 60000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`; };
const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Cut frames are canonical 30 fps indexes where the FFmpeg scene score exceeds the threshold. */
export function parseSceneCuts(framemd5, durationFrames) {
  const header = /^#tb 0: (\d+)\/(\d+)$/m.exec(framemd5);
  if (!header) throw failure('장면 전환 결과의 시간 기준을 읽지 못했습니다.', 500);
  const [numerator, denominator] = [Number(header[1]), Number(header[2])];
  const cuts = new Set();
  for (const line of framemd5.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const pts = Number(line.split(',')[2]);
    if (!Number.isFinite(pts)) continue;
    const frame = Math.round(pts * numerator / denominator * 30);
    if (frame > 0 && frame < durationFrames) cuts.add(frame);
  }
  return [...cuts].sort((left, right) => left - right);
}

export function shotsFromCuts(cuts, durationFrames) {
  const bounds = [0, ...cuts, durationFrames];
  return bounds.slice(0, -1).map((frameIn, index) => ({ index: index + 1, frameIn, frameOut: bounds[index + 1] }));
}

async function identity({ versionId, videoPath, durationFrames, directory }) {
  if (typeof versionId !== 'string' || !/^[\w-]+$/.test(versionId)) throw failure('영상 개요의 버전 식별자가 유효하지 않습니다.');
  const frames = sampleFilmstripFrames(durationFrames);
  let source;
  try { source = await stat(videoPath); if (!source.isFile() || source.size === 0) throw failure('버전 영상 파일이 비어 있거나 유효하지 않습니다.', 404); }
  catch (error) { if (error.code === 'ENOENT') throw failure('이 버전의 영상 파일을 찾지 못했습니다.', 404); throw error; }
  const cacheKey = createHash('sha256').update(JSON.stringify({ renderer: RENDERER, threshold: SHOT_THRESHOLD, versionId, durationFrames, path: resolve(videoPath), size: source.size, modified: source.mtimeMs, changed: source.ctimeMs })).digest('hex');
  return { versionId, durationFrames, frames, cacheKey, imagePath: join(directory, `${cacheKey}.jpg`), manifestPath: join(directory, `${cacheKey}.json`) };
}

function layout(frames) {
  return frames.map((frame, index) => ({ frame, time: clock(frame), x: (index % COLUMNS) * CELL_WIDTH, y: Math.floor(index / COLUMNS) * CELL_HEIGHT, w: CELL_WIDTH, h: CELL_HEIGHT }));
}

/** One decode pass gives both a 4-column overview grid and scene-change frames. Results are cached per version file. */
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
    const select = info.frames.map(frame => `eq(n\\,${frame})`).join('+');
    const graph = `[0:v]split=2[a][b];[a]select=${select},scale=${CELL_WIDTH}:${CELL_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${CELL_WIDTH}:${CELL_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[grid];[b]scale=160:90:force_original_aspect_ratio=decrease:force_divisible_by=2,select=gt(scene\\,${SHOT_THRESHOLD})[cuts]`;
    const framemd5 = await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-filter_complex', graph, '-map', '[grid]', '-fps_mode', 'vfr', '-frames:v', String(info.frames.length), '-q:v', '3', '-start_number', '0', join(work, '%02d.jpg'), '-map', '[cuts]', '-fps_mode', 'vfr', '-f', 'framemd5', '-'], { signal, timeout: 300_000 });
    abort(signal);
    const cells = (await readdir(work)).filter(name => /^\d{2}\.jpg$/.test(name)).sort();
    if (cells.length !== info.frames.length) throw failure('버전 길이와 실제 영상 프레임이 맞지 않아 영상 개요를 만들지 못했습니다.', 409);
    const positions = layout(info.frames), rows = Math.ceil(cells.length / COLUMNS), width = Math.min(cells.length, COLUMNS) * CELL_WIDTH, height = rows * CELL_HEIGHT;
    const labels = positions.map((cell, index) => `<rect x="${cell.x + 6}" y="${cell.y + CELL_HEIGHT - 30}" width="118" height="24" rx="4" fill="#000" fill-opacity="0.72"/><text x="${cell.x + 14}" y="${cell.y + CELL_HEIGHT - 12}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="15" fill="#fff">${escapeXml(`${index + 1} · ${cell.time}`)}</text>`).join('');
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels}</svg>`);
    const imagePath = join(work, 'grid.jpg');
    await sharp({ create: { width, height, channels: 3, background: '#000000' } }).composite([...cells.map((name, index) => ({ input: join(work, name), left: positions[index].x, top: positions[index].y })), { input: svg, left: 0, top: 0 }]).jpeg({ quality: 82 }).toFile(imagePath);
    abort(signal);
    const cuts = parseSceneCuts(framemd5, info.durationFrames);
    const persisted = { renderer: RENDERER, cacheKey: info.cacheKey, versionId: info.versionId, durationFrames: info.durationFrames, fps: 30, grid: { width, height, columns: COLUMNS, cellWidth: CELL_WIDTH, cellHeight: CELL_HEIGHT, cells: positions }, shots: { method: 'ffmpeg-scene-score', threshold: SHOT_THRESHOLD, estimated: true, cuts, list: shotsFromCuts(cuts, info.durationFrames) } };
    const manifestPath = join(work, 'overview.json'); await writeFile(manifestPath, JSON.stringify(persisted));
    abort(signal);
    await rename(imagePath, info.imagePath); await rename(manifestPath, info.manifestPath);
    return { ...persisted, imagePath: info.imagePath, cacheHit: false, diagnostics: { ffmpegRuns: 1 } };
  } finally { await rm(work, { recursive: true, force: true }); }
}
