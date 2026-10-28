import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdir, writeFile, access, stat, rename } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { drawingsSvg, assertStaticDrawingFrames } from './drawings.mjs';
import { sceneScoreFilter } from './scene-scores.mjs';

export const FPS = 30;

/** An explicit env path wins; otherwise Apple Silicon Homebrew, Intel Homebrew, then PATH. */
export function resolveMediaBinary(name, explicit, { searchPath = process.env.PATH ?? '', candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`] } = {}) {
  if (explicit) return explicit;
  const executable = path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
  return [...candidates, ...searchPath.split(delimiter).filter(Boolean).map(folder => join(folder, name))].find(executable) ?? name;
}
export const ffmpegPath = resolveMediaBinary('ffmpeg', process.env.FFMPEG_PATH);
export const ffprobePath = resolveMediaBinary('ffprobe', process.env.FFPROBE_PATH);
const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
/** Review proxy only (renders keep their own settings). superfast imports ~1.4x faster than veryfast at equal or better SSIM, with larger files. */
export const proxyPreset = X264_PRESETS.includes(process.env.VI_PROXY_PRESET) ? process.env.VI_PROXY_PRESET : 'superfast';

const canceledError = () => Object.assign(new Error('렌더를 취소했습니다.'), { name: 'AbortError' });
const checkCancellation = signal => { if (signal?.aborted) throw canceledError(); };
const nativeProcesses = new Set();
let mediaShuttingDown = false;

/** Stop every FFmpeg/ffprobe child, including import/context work, and wait for actual process close. */
export async function shutdownMediaProcesses() {
  mediaShuttingDown = true;
  const running = [...nativeProcesses];
  for (const process of running) process.stop();
  await Promise.all(running.map(process => process.closed));
}

export function run(binary, args, { onProgress, durationSeconds, timeout = 900_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || mediaShuttingDown) return reject(canceledError());
    const proc = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', progressBuffer = '';
    let timedOut = false, forceKill, stopRequested = false, resolveClosed;
    const abort = () => { if (stopRequested) return; stopRequested = true; proc.kill('SIGTERM'); forceKill = setTimeout(() => proc.kill('SIGKILL'), 1000); forceKill.unref(); };
    const native = { stop: abort, closed: new Promise(resolve => { resolveClosed = resolve; }) };
    nativeProcesses.add(native);
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeout);
    const cleanup = () => { clearTimeout(timer); clearTimeout(forceKill); signal?.removeEventListener('abort', abort); nativeProcesses.delete(native); resolveClosed(); };
    signal?.addEventListener('abort', abort, { once: true });
    proc.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split('\n'); progressBuffer = lines.pop();
      for (const line of lines) if (!signal?.aborted && line.startsWith('out_time_us=') && onProgress && durationSeconds) {
        onProgress(Math.min(0.98, Number(line.slice(12)) / 1_000_000 / durationSeconds));
      }
    });
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16_000); });
    proc.on('error', error => { cleanup(); reject(new Error(`미디어 엔진을 실행하지 못했습니다: ${error.message}`)); });
    proc.on('close', code => {
      cleanup();
      if (signal?.aborted || stopRequested) reject(canceledError());
      else if (timedOut) reject(new Error('미디어 처리 시간이 초과됐습니다.'));
      else code === 0 ? resolve(stdout) : reject(new Error(`FFmpeg 처리 실패 (${code}): ${stderr.slice(-2000)}`));
    });
  });
}

export async function probe(path, { signal } = {}) {
  return JSON.parse(await run(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { timeout: 30_000, signal }));
}

function streamStartSeconds(stream) {
  if (stream?.start_time !== undefined && Number.isFinite(Number(stream.start_time))) return Number(stream.start_time);
  const [numerator, denominator] = String(stream?.time_base || '').split('/').map(Number);
  if (stream?.start_pts !== undefined && Number.isFinite(Number(stream.start_pts)) && Number.isFinite(numerator) && Number.isFinite(denominator) && denominator) return Number(stream.start_pts) * numerator / denominator;
  return null;
}

export function audioOffsetFromInfo(info) {
  const video = info.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = info.streams.find(stream => stream.codec_type === 'audio');
  if (!audio) return 0;
  const videoStart = streamStartSeconds(video), audioStart = streamStartSeconds(audio);
  return videoStart === null || audioStart === null ? 0 : audioStart - videoStart;
}

const alignedAudio = offset => `asetpts=PTS-STARTPTS+(${offset})/TB,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=async=1:first_pts=0`;

/**
 * Normalizes a source into the 30fps review proxy. With `sceneScoresPath`, the same decode also writes per-frame
 * scene scores so the version overview never needs a second full decode of this proxy.
 */
export async function ingest(sourcePath, previewPath, thumbnailPath, { sceneScoresPath, onProgress, signal } = {}) {
  const info = await probe(sourcePath, { signal });
  const video = info.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video || !video.width || !video.height) throw new Error('재생 가능한 영상 파일이 필요합니다.');
  const duration = Number(video.duration || info.format.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error('첫 초안은 10분 이하 영상만 지원합니다.');
  if (['smpte2084', 'arib-std-b67'].includes(video.color_transfer)) throw new Error('첫 초안은 SDR 영상을 지원합니다. HDR 영상은 SDR로 변환해서 열어 주세요.');
  if (video.width > 8192 || video.height > 8192) throw new Error('8K 이하 영상만 지원합니다.');
  const hasAudio = info.streams.some(stream => stream.codec_type === 'audio');
  const audioOffsetSeconds = audioOffsetFromInfo(info);
  const normalize = "setpts=PTS-STARTPTS,fps=30,scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1";
  const args = ['-y', '-hide_banner', '-loglevel', 'error', ...(onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), '-i', sourcePath, ...(sceneScoresPath ? ['-filter_complex', `[0:v:0]${normalize},split=2[proxy][scenes];[scenes]${sceneScoreFilter(sceneScoresPath)}[scored]`, '-map', '[proxy]'] : ['-map', '0:v:0', '-vf', normalize]), '-map', '0:a:0?', '-c:v', 'libx264', '-preset', proxyPreset, '-crf', '20', '-pix_fmt', 'yuv420p', '-g', '15', '-movflags', '+faststart'];
  if (hasAudio) args.push('-af', `${alignedAudio(audioOffsetSeconds)},apad`, '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest');
  args.push('-t', String(duration), previewPath);
  if (sceneScoresPath) args.push('-map', '[scored]', '-t', String(duration), '-f', 'null', '-');
  await run(ffmpegPath, args, { onProgress, durationSeconds: duration, signal });
  const normalized = await probe(previewPath, { signal });
  const canonical = normalized.streams.find(stream => stream.codec_type === 'video');
  const durationFrames = Number(canonical.nb_frames) || Math.round(Number(canonical.duration) * FPS);
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.min(2, duration / 3)), '-i', previewPath, '-frames:v', '1', '-vf', 'scale=640:-2', thumbnailPath], { signal });
  return { durationFrames, fps: FPS, width: canonical.width, height: canonical.height, hasAudio, audioOffsetSeconds, originalFps: video.avg_frame_rate || video.r_frame_rate };
}

/** Maps a request made on any version back onto immutable source frame ranges. */
export function mapToSource(timelineMap, frameIn, frameOut) {
  const ranges = [];
  for (const segment of timelineMap) {
    const start = Math.max(frameIn, segment.outputIn), end = Math.min(frameOut, segment.outputOut);
    if (end <= start) continue;
    const ratio = (segment.sourceOut - segment.sourceIn) / (segment.outputOut - segment.outputIn);
    const sourceIn = Math.max(segment.sourceIn, Math.min(segment.sourceOut - 1, Math.round(segment.sourceIn + (start - segment.outputIn) * ratio)));
    const sourceOut = Math.max(sourceIn + 1, Math.min(segment.sourceOut, Math.round(segment.sourceIn + (end - segment.outputIn) * ratio)));
    const previous = ranges.at(-1);
    if (previous?.frameOut === sourceIn) previous.frameOut = sourceOut;
    else ranges.push({ frameIn: sourceIn, frameOut: sourceOut });
  }
  return ranges;
}

export function mapToOutput(timelineMap, sourceRanges) {
  const ranges = [];
  for (const segment of timelineMap) for (const range of sourceRanges) {
    const start = Math.max(segment.sourceIn, range.frameIn), end = Math.min(segment.sourceOut, range.frameOut);
    if (end <= start) continue;
    const ratio = (segment.outputOut - segment.outputIn) / (segment.sourceOut - segment.sourceIn);
    const frameIn = Math.round(segment.outputIn + (start - segment.sourceIn) * ratio);
    const frameOut = Math.round(segment.outputIn + (end - segment.sourceIn) * ratio);
    if (frameOut > frameIn) ranges.push({ frameIn, frameOut });
  }
  return ranges;
}

export function compileTimeline(durationFrames, ops) {
  if (!Number.isInteger(durationFrames) || durationFrames < 1) throw new Error('원본 길이가 유효하지 않습니다.');
  const executable = ops.filter(op => op.type !== 'note');
  for (const op of executable) {
    if (!Array.isArray(op.sourceRanges) || !op.sourceRanges.length || op.sourceRanges.some(range => !Number.isInteger(range.frameIn) || !Number.isInteger(range.frameOut) || range.frameIn < 0 || range.frameOut <= range.frameIn || range.frameOut > durationFrames)) throw new Error('편집 구간이 원본 범위를 벗어났습니다.');
  }
  const temporal = executable.filter(op => ['cut', 'trim', 'speed', 'audio'].includes(op.type));
  const boundaries = new Set([0, durationFrames]);
  for (const op of temporal) for (const range of op.sourceRanges) { boundaries.add(range.frameIn); boundaries.add(range.frameOut); }
  const points = [...boundaries].sort((a, b) => a - b);
  const map = [];
  let idealOutput = 0, output = 0;
  const covers = (op, start, end) => op.sourceRanges.some(range => range.frameIn <= start && range.frameOut >= end);
  for (let i = 0; i < points.length - 1; i++) {
    const sourceIn = points[i], sourceOut = points[i + 1];
    if (sourceIn < 0 || sourceOut > durationFrames || sourceOut <= sourceIn) throw new Error('편집 구간이 원본 범위를 벗어났습니다.');
    if (temporal.some(op => op.type === 'cut' && covers(op, sourceIn, sourceOut))) continue;
    if (temporal.some(op => op.type === 'trim' && !covers(op, sourceIn, sourceOut))) continue;
    let speed = 1, volume = 1;
    for (const op of temporal) if (covers(op, sourceIn, sourceOut)) {
      if (op.type === 'speed') speed = op.params.factor;
      if (op.type === 'audio') volume = op.params.volume;
    }
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error('배속은 원본 기준 0.25~4배 사이로 지정해 주세요.');
    if (!Number.isFinite(volume) || volume < 0 || volume > 2) throw new Error('음량은 0~200% 사이로 지정해 주세요.');
    idealOutput += (sourceOut - sourceIn) / speed;
    const outputOut = Math.max(output + 1, Math.round(idealOutput));
    map.push({ sourceIn, sourceOut, outputIn: output, outputOut, speed, volume }); output = outputOut;
  }
  if (!map.length || output < 1) throw new Error('모든 영상을 삭제할 수는 없습니다. 남길 구간을 지정해 주세요.');
  if (map.length > 100) throw new Error('첫 초안은 최대 100개의 편집 구간을 지원합니다.');
  return map;
}

function tempoChain(factor) {
  if (factor === 1) return 'anull';
  const steps = [];
  while (factor > 2) { steps.push(2); factor /= 2; }
  while (factor < 0.5) { steps.push(0.5); factor /= 0.5; }
  steps.push(factor);
  return steps.map(value => `atempo=${value}`).join(',');
}
const xml = text => String(text).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
const validColor = color => /^#[a-f\d]{6}$/i.test(color || '') ? color : '#DFFF00';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exists = async path => { try { await access(path); return true; } catch { return false; } };

export async function createGraphic(asset, op, directory, files = {}) {
  const sharp = (await import('sharp')).default;
  await mkdir(directory, { recursive: true });
  const isDrawing = op.type === 'overlay' && op.params.kind === 'drawing';
  const region = op.region || (op.type === 'subtitle' ? { x: 0.1, y: 0.78, w: 0.8, h: 0.15 } : { x: 0.12, y: 0.16, w: 0.76, h: 0.22 });
  const width = isDrawing ? asset.width : Math.max(2, Math.round(region.w * asset.width)), height = isDrawing ? asset.height : Math.max(2, Math.round(region.h * asset.height));
  let imageMetadata;
  if (op.type === 'overlay' && op.params.kind === 'image') {
    const attachment = files[op.params.assetRef];
    if (!attachment?.normalizedPath) throw new Error('삽입할 이미지 파일을 찾지 못했습니다.');
    const metadata = await stat(attachment.normalizedPath); imageMetadata = { path: attachment.normalizedPath, size: metadata.size, modified: metadata.mtimeMs };
  }
  const params = { ...op.params };
  if (isDrawing) assertStaticDrawingFrames(params.drawings);
  if (params.drawings) params.drawings = params.drawings.map(({ id, frame, ...geometry }) => geometry);
  const key = digest({ renderer: 'graphics-v3', width: asset.width, height: asset.height, type: op.type, region: isDrawing ? null : region, params, imageMetadata });
  const graphicPath = join(directory, `${key}.png`), tempPath = `${graphicPath}.${randomUUID()}.tmp`;
  const placement = { path: graphicPath, x: isDrawing ? 0 : Math.round(region.x * asset.width), y: isDrawing ? 0 : Math.round(region.y * asset.height), key };
  if (await exists(graphicPath)) return { ...placement, cacheHit: true };
  if (op.type === 'overlay' && op.params.kind === 'image') {
    await sharp(imageMetadata.path).resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(tempPath);
  } else if (isDrawing) {
    if (!Array.isArray(op.params.drawings) || !op.params.drawings.length) throw new Error('영상에 넣을 드로잉이 필요합니다.');
    await sharp(Buffer.from(drawingsSvg(asset.width, asset.height, op.params.drawings))).png().toFile(tempPath);
  } else {
    const text = String(op.params.text || '').slice(0, 300);
    const fontSize = Math.max(16, Math.min(Math.round(asset.width * 0.031), Math.floor(height / 2.1)));
    const maxChars = Math.max(6, Math.floor(width / (fontSize * 0.68)));
    const lines = [];
    for (const paragraph of text.split('\n')) for (let index = 0; index < paragraph.length; index += maxChars) lines.push(paragraph.slice(index, index + maxChars));
    const visible = lines.slice(0, 3);
    const textColor = op.params.color === undefined ? '#FFFFFF' : validColor(op.params.color);
    const textNodes = visible.map((line, index) => `<text x="50%" y="${height / 2 + (index - (visible.length - 1) / 2) * fontSize * 1.2}" dominant-baseline="central" text-anchor="middle" font-family="Apple SD Gothic Neo, Noto Sans CJK KR, sans-serif" font-weight="700" font-size="${fontSize}" fill="${textColor}">${xml(line)}</text>`).join('');
    const body = op.params.kind === 'box' ? `<rect x="3" y="3" width="${width - 6}" height="${height - 6}" rx="10" fill="none" stroke="${validColor(op.params.color)}" stroke-width="6"/>` : `<rect width="100%" height="100%" rx="14" fill="#101014" fill-opacity="0.85"/>${textNodes}`;
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`)).png().toFile(tempPath);
  }
  await rename(tempPath, graphicPath);
  return { ...placement, cacheHit: false };
}

async function batchGraphic(asset, group, directory) {
  if (group.items.length === 1) return { ...group.items[0], ranges: group.ranges, batchCacheHit: false };
  const sharp = (await import('sharp')).default;
  const key = digest({ renderer: 'batch-v1', width: asset.width, height: asset.height, graphics: group.items.map(graphic => ({ key: graphic.key, x: graphic.x, y: graphic.y })) });
  const path = join(directory, `${key}.png`);
  const result = { path, key, x: 0, y: 0, ranges: group.ranges };
  if (await exists(path)) return { ...result, batchCacheHit: true };
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await sharp({ create: { width: asset.width, height: asset.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(group.items.map(graphic => ({ input: graphic.path, left: graphic.x, top: graphic.y }))).png().toFile(tempPath);
  await rename(tempPath, path);
  return { ...result, batchCacheHit: false };
}

export async function renderVideo({ asset, sourcePath, ops, outputPath, thumbnailPath, workingDirectory, graphicCacheDirectory = join(dirname(workingDirectory), 'graphic-cache'), files = {}, sceneScoresPath, onProgress, signal }) {
  checkCancellation(signal);
  await mkdir(workingDirectory, { recursive: true });
  const timelineMap = compileTimeline(asset.durationFrames, ops);
  const durationFrames = timelineMap.at(-1).outputOut;
  const audioOffsetSeconds = !asset.hasAudio ? 0 : Number.isFinite(asset.audioOffsetSeconds) ? asset.audioOffsetSeconds : audioOffsetFromInfo(await probe(sourcePath, { signal }));
  checkCancellation(signal);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', sourcePath];
  let audioInput = 0, nextInput = 1;
  if (!asset.hasAudio) { args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'); audioInput = 1; nextInput = 2; }
  const graphicStart = Date.now(), groups = [];
  let graphicOps = 0, rasterCacheHits = 0;
  for (const op of ops.filter(op => ['subtitle', 'overlay'].includes(op.type))) {
    checkCancellation(signal);
    const ranges = mapToOutput(timelineMap, op.sourceRanges);
    if (!ranges.length) continue;
    const graphic = await createGraphic(asset, op, graphicCacheDirectory, files);
    graphicOps++; if (graphic.cacheHit) rasterCacheHits++;
    const timing = JSON.stringify(ranges), previous = groups.at(-1);
    // Only consecutive equal-timing layers can be combined without changing overlap order.
    if (previous?.timing === timing) previous.items.push(graphic);
    else groups.push({ timing, ranges, items: [graphic] });
  }
  const graphics = [];
  for (const group of groups) {
    checkCancellation(signal);
    const graphic = await batchGraphic(asset, group, graphicCacheDirectory);
    args.push('-loop', '1', '-framerate', '30', '-threads', '1', '-i', graphic.path);
    graphics.push({ ...graphic, input: nextInput++ });
  }
  const diagnostics = { timelineSegments: timelineMap.length, graphicOps, graphicInputs: graphics.length, rasterCacheHits, batchCacheHits: graphics.filter(graphic => graphic.batchCacheHit).length, graphicPrepareMs: Date.now() - graphicStart };
  const filter = [];
  const count = timelineMap.length;
  filter.push(`[0:v:0]setpts=PTS-STARTPTS,fps=30,scale=${asset.width}:${asset.height},setsar=1,split=${count}${timelineMap.map((_, i) => `[vs${i}]`).join('')}`);
  filter.push(`[${audioInput}:a:0]${alignedAudio(audioOffsetSeconds)},asplit=${count}${timelineMap.map((_, i) => `[as${i}]`).join('')}`);
  for (let i = 0; i < count; i++) {
    const segment = timelineMap[i], frames = segment.outputOut - segment.outputIn, seconds = frames / FPS;
    filter.push(`[vs${i}]trim=start_frame=${segment.sourceIn}:end_frame=${segment.sourceOut},setpts=(PTS-STARTPTS)/${segment.speed},fps=30,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames},setpts=PTS-STARTPTS[v${i}]`);
    filter.push(`[as${i}]atrim=start=${segment.sourceIn / FPS}:end=${segment.sourceOut / FPS},asetpts=PTS-STARTPTS,${tempoChain(segment.speed)},volume=${segment.volume},apad=whole_dur=${seconds},atrim=duration=${seconds},asetpts=PTS-STARTPTS[a${i}]`);
  }
  filter.push(`${timelineMap.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${count}:v=1:a=1[basev][outa]`);
  let label = 'basev';
  for (let index = 0; index < graphics.length; index++) {
    const graphic = graphics[index];
    const enable = graphic.ranges.map(range => `gte(t,${range.frameIn / FPS})*lt(t,${range.frameOut / FPS})`).join('+');
    filter.push(`[${label}][${graphic.input}:v:0]overlay=x=${graphic.x}:y=${graphic.y}:enable='${enable}':eof_action=repeat:shortest=1[graphic${index}]`);
    label = `graphic${index}`;
  }
  const filterPath = join(workingDirectory, 'filters.txt');
  await writeFile(filterPath, filter.join(';\n'));
  // Scene scores ride on the same render decode; they only feed the estimated overview cuts.
  if (sceneScoresPath) { filter.push(`[${label}]split=2[rendered][scenes]`, `[scenes]${sceneScoreFilter(sceneScoresPath)}[scored]`); label = 'rendered'; }
  args.push('-filter_complex', filter.join(';'), '-map', `[${label}]`, '-map', '[outa]', '-frames:v', String(durationFrames), '-t', String(durationFrames / FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outputPath);
  if (sceneScoresPath) args.push('-map', '[scored]', '-t', String(durationFrames / FPS), '-f', 'null', '-');
  const renderStart = Date.now();
  await run(ffmpegPath, args, { durationSeconds: durationFrames / FPS, onProgress, signal });
  diagnostics.renderMs = Date.now() - renderStart;
  const info = await probe(outputPath, { signal });
  const video = info.streams.find(stream => stream.codec_type === 'video');
  if (Number(video.nb_frames) !== durationFrames) throw new Error(`출력 프레임 검증 실패: 예상 ${durationFrames}, 실제 ${video.nb_frames}`);
  if (thumbnailPath) await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.min(2, durationFrames / FPS / 3)), '-i', outputPath, '-frames:v', '1', '-vf', 'scale=640:-2', thumbnailPath], { signal });
  checkCancellation(signal);
  await writeFile(join(workingDirectory, 'render-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  return { timelineMap, durationFrames, diagnostics };
}
