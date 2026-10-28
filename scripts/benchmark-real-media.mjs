/** Local-only QA. All outputs stay under storage/qa; originals are read-only.
 * node scripts/benchmark-real-media.mjs --suite baseline --label before --engine storage/qa/real-media-baseline/engine-baseline.mjs
 * node scripts/benchmark-real-media.mjs --suite all --label after
 * Missing requested media is a failure, never a passing skip.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

if (process.argv.includes('--help')) {
  console.log(`Local-only real-media benchmark (original files are never changed or sent to AI).
Usage: node scripts/benchmark-real-media.mjs [options]
  --source-root PATH  Media root; defaults to VI_REAL_MEDIA_ROOT or the local movie_ai folder.
  --suite all|baseline|stress
                      all: media + boxes + drawing/cache; baseline: media + boxes only;
                      stress: boxes + drawing/cache only. Default: all.
  --samples ID,ID     Explicit media targets (unknown or missing targets fail).
  --label NAME        Output folder storage/qa/real-media/NAME. Default: current.
  --time true         macOS /usr/bin/time -l: exact native max RSS and CPU accounting.
  --engine PATH       Alternate engine module relative to repo root (e.g. frozen baseline).
  --help              Show usage without creating files or running media jobs.
Samples: landscape-audio-full35, landscape-silent-full35, hevc24, h26425,
         timestamp-edge, portrait-derived35, 4k-derived6, rotation-derived6, vfr-derived6.
Portrait/4K/rotation/VFR fixtures are derived from real media, not native captured originals.
Reports and generated fixtures stay under storage/qa. A missing input exits with failure.`);
  process.exit(0);
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = Object.fromEntries(process.argv.slice(2).map((value, index, list) => value.startsWith('--') ? [value.slice(2), list[index + 1]] : []).filter(pair => pair.length));
const suite = args.suite || 'all', label = args.label || 'current';
assert.ok(['all', 'baseline', 'stress'].includes(suite), 'suite must be all, baseline, or stress');
assert.match(label, /^[a-zA-Z0-9_-]+$/, 'label must be a simple folder name');
const sourceRoot = resolve(args['source-root'] || process.env.VI_REAL_MEDIA_ROOT || '/Users/clmagi/Desktop/Classin/movie_ai');
const outputRoot = join(root, 'storage/qa/real-media', label), fixtureRoot = join(root, 'storage/qa/real-media/fixtures');
const enginePath = resolve(root, args.engine || 'apps/worker/engine.mjs');
const shell = promisify(execFile);
await mkdir(outputRoot, { recursive: true }); await mkdir(fixtureRoot, { recursive: true });
const nativeTiming = args.time === 'true', timingLog = join(outputRoot, 'native-time.jsonl');
if (nativeTiming) {
  assert.equal(process.platform, 'darwin', '--time true uses the macOS /usr/bin/time -l format');
  const wrapper = join(outputRoot, 'ffmpeg-timed-wrapper.mjs'), binary = (await import('../apps/worker/engine.mjs')).ffmpegPath;
  await writeFile(timingLog, '');
  await writeFile(wrapper, `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nimport {appendFileSync} from 'node:fs';\nlet stderr='';const started=Date.now();\nconst child=spawn('/usr/bin/time',['-l',${JSON.stringify(binary)},...process.argv.slice(2)],{stdio:['ignore','inherit','pipe']});\nchild.stderr.on('data',chunk=>{stderr+=chunk;process.stderr.write(chunk)});\nfor(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));\nchild.on('error',error=>{process.stderr.write(error.message);process.exitCode=1});\nchild.on('close',code=>{const cpu=stderr.match(/([\\d.]+)\\s+real\\s+([\\d.]+)\\s+user\\s+([\\d.]+)\\s+sys/);const rss=stderr.match(/(\\d+)\\s+maximum resident set size/);appendFileSync(${JSON.stringify(timingLog)},JSON.stringify({output:process.argv.at(-1),elapsedMs:Date.now()-started,realSeconds:cpu?Number(cpu[1]):null,userSeconds:cpu?Number(cpu[2]):null,systemSeconds:cpu?Number(cpu[3]):null,maximumResidentSetBytes:rss?Number(rss[1]):null,exitCode:code})+'\\n');process.exitCode=code===0?0:1});\n`);
  await chmod(wrapper, 0o755); process.env.FFMPEG_PATH = wrapper;
}
const engine = await import(pathToFileURL(enginePath));
const specs = [
  { id: 'landscape-audio-full35', relative: 'out/ClassIn_35s_v3_share.mp4' },
  { id: 'landscape-silent-full35', relative: 'out/ClassIn_35s_silent.mp4' },
  { id: 'hevc24', relative: 'higgsfield/seagull_vox/clips/draft14_mini_v2_topaz.mp4' },
  { id: 'h26425', relative: 'public/media/homehero.mp4' },
  { id: 'timestamp-edge', relative: 'public/media/clip2.mp4' },
  { id: 'portrait-derived35', derived: 'portrait' },
  { id: '4k-derived6', derived: '4k' },
  { id: 'rotation-derived6', derived: 'rotation' },
  { id: 'vfr-derived6', derived: 'vfr' },
];
const selected = args.samples ? specs.filter(item => args.samples.split(',').includes(item.id)) : specs;
if (args.samples) assert.equal(selected.length, new Set(args.samples.split(',')).size, 'unknown requested sample ID');
assert.ok(selected.length, 'no real media targets selected');
const originalStates = new Map(), report = { label, suite, nativeTiming, enginePath, engineHash: createHash('sha256').update(await readFile(enginePath)).digest('hex'), startedAt: new Date().toISOString(), sourceRoot, samples: [], stress: [], failures: [], limitations: ['4K, portrait, rotation and VFR fixtures are transformations of real media, not native captured originals.', 'Audio sync checks measure stream timestamps/durations; acoustic lip sync is not claimed.', 'peakFfmpegRssKiB is sampled at 250 ms intervals; nativeResources.maximumResidentSetBytes is separately measured by macOS time -l when enabled.'] };
const op = (type, frameIn, frameOut, params = {}, extra = {}) => ({ id: `${type}-${frameIn}-${frameOut}-${extra.id || ''}`, type, sourceRanges: [{ frameIn, frameOut }], params, status: 'approved', ...extra });
async function remember(path) {
  if (originalStates.has(path)) return;
  await access(path).catch(() => { throw new Error(`Required real-media target missing: ${path}`); });
  const data = await stat(path); const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  originalStates.set(path, { size: data.size, mtimeMs: data.mtimeMs, sha256: hash.digest('hex') });
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function sourceFor(spec) {
  if (spec.relative) { const path = join(sourceRoot, spec.relative); await remember(path); return path; }
  const original = join(sourceRoot, 'out/ClassIn_35s_v3_share.mp4'); await remember(original);
  const path = join(fixtureRoot, `${spec.id}.mp4`);
  if (await exists(path)) {
    if (spec.derived !== 'rotation' || specSummary(await engine.probe(path)).rotation === 90) return path;
  }
  const head = ['-y', '-hide_banner', '-loglevel', 'error', ...(spec.derived === 'rotation' ? ['-display_rotation:v:0', '90'] : []), '-i', original];
  let tail;
  if (spec.derived === 'portrait') tail = ['-vf', 'crop=608:1080', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac'];
  if (spec.derived === '4k') tail = ['-t', '6', '-vf', 'scale=3840:2160', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac'];
  if (spec.derived === 'rotation') tail = ['-t', '6', '-c', 'copy'];
  if (spec.derived === 'vfr') tail = ['-vf', "trim=end_frame=120,setpts='if(lt(N,60),N/(30*TB),(2+(N-60)/15)/TB)'", '-fps_mode', 'vfr', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
  await engine.run(engine.ffmpegPath, [...head, ...tail, path]); return path;
}
function specSummary(info) {
  const v = info.streams.find(s => s.codec_type === 'video'), a = info.streams.find(s => s.codec_type === 'audio');
  return { width: v.width, height: v.height, fps: v.avg_frame_rate, nominalFps: v.r_frame_rate, frames: Number(v.nb_frames) || null, duration: Number(v.duration || info.format.duration), codec: v.codec_name, audio: Boolean(a), audioDuration: a ? Number(a.duration) : null, audioStart: a ? Number(a.start_time || 0) : null, videoStart: Number(v.start_time || 0), rotation: v.side_data_list?.find(s => s.rotation !== undefined)?.rotation || 0 };
}
async function measure(callback) {
  const resources = async () => nativeTiming ? (await readFile(timingLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const resourceStart = (await resources()).length;
  const started = performance.now(); let peakFfmpegRssKiB = 0, peakFfmpegCpuPercent = 0, polling = false;
  const timer = setInterval(async () => {
    if (polling) return; polling = true;
    try {
      const { stdout } = await shell('/bin/ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm=']);
      const rows = stdout.trim().split('\n').map(line => { const [pid, ppid, rss, cpu, ...comm] = line.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), cpu: Number(cpu), comm: comm.join(' ') }; });
      const descendants = new Set([process.pid]);
      for (let changed = true; changed;) { changed = false; for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; } }
      const children = rows.filter(row => descendants.has(row.pid) && /ffmpeg$/.test(row.comm));
      peakFfmpegRssKiB = Math.max(peakFfmpegRssKiB, children.reduce((total, child) => total + child.rss, 0));
      peakFfmpegCpuPercent = Math.max(peakFfmpegCpuPercent, children.reduce((total, child) => total + child.cpu, 0));
    } catch {} finally { polling = false; }
  }, 250);
  try { const value = await callback(); return { value, elapsedMs: Math.round(performance.now() - started), peakFfmpegRssKiB, peakFfmpegCpuPercent, nativeResources: (await resources()).slice(resourceStart) }; }
  finally { clearInterval(timer); }
}
async function frame(path, index, name) {
  const target = join(outputRoot, `${name}.png`);
  await engine.run(engine.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select=eq(n\\,${index})`, '-frames:v', '1', target]);
  const { data, info } = await sharp(target).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { path: target, info, pixel: (x, y) => [...data.subarray((Math.round(y) * info.width + Math.round(x)) * info.channels, (Math.round(y) * info.width + Math.round(x)) * info.channels + 3)] };
}
async function validateResult(result, outputPath) {
  const actual = specSummary(await engine.probe(outputPath));
  assert.equal(actual.frames, result.durationFrames, 'actual native FFmpeg frame count');
  assert.ok(Math.abs(actual.duration - result.durationFrames / 30) < 1 / 30 + 0.001, 'video duration agrees with timeline');
  assert.equal(actual.fps, '30/1'); assert.equal(actual.audio, true, 'silent compatibility audio is required');
  assert.ok(Math.abs(actual.audioDuration - actual.duration) <= 0.08, `container audio/video skew ${actual.audioDuration - actual.duration}s`);
  assert.ok(Math.abs(actual.audioStart - actual.videoStart) <= 0.04, 'audio/video stream start offset');
  return actual;
}
const yellowPath = join(fixtureRoot, 'yellow-check.png');
await sharp({ create: { width: 64, height: 64, channels: 4, background: '#ffff00' } }).png().toFile(yellowPath);
const ingested = new Map();
async function runBasic(spec) {
  const sourcePath = await sourceFor(spec), sourceInfo = specSummary(await engine.probe(sourcePath));
  if (spec.derived === 'rotation') assert.equal(sourceInfo.rotation, 90, 'rotation fixture must contain a real display matrix');
  if (spec.derived === 'portrait') assert.ok(sourceInfo.height > sourceInfo.width, 'portrait fixture shape');
  if (spec.derived === '4k') assert.equal(sourceInfo.width, 3840, '4K fixture raster');
  if (spec.derived === 'vfr') assert.notEqual(sourceInfo.fps, sourceInfo.nominalFps, 'VFR fixture must have changed timestamps');
  const directory = join(outputRoot, spec.id); await mkdir(directory, { recursive: true });
  const previewPath = join(directory, 'canonical.mp4');
  const imported = await measure(() => engine.ingest(sourcePath, previewPath, join(directory, 'thumbnail.jpg')));
  const asset = imported.value, n = asset.durationFrames;
  if (['portrait', 'rotation'].includes(spec.derived)) assert.ok(asset.height > asset.width, 'ingest must preserve portrait/autorotated display aspect ratio');
  const ops = [op('cut', 30, 60), op('speed', Math.floor(n * .30), Math.floor(n * .50), { factor: 2 }), op('subtitle', Math.floor(n * .15), Math.floor(n * .25), { kind: 'text', text: '실제 영상 편집 검증' }), op('overlay', Math.floor(n * .55), Math.floor(n * .70), { kind: 'image', assetRef: 'yellow' }, { region: { x: .05, y: .05, w: .20, h: .20 } })];
  const outputPath = join(directory, 'edited.mp4'), expected = engine.compileTimeline(n, ops);
  // Match server.mjs: final edits decode the preserved original, never the compressed preview.
  const rendered = await measure(() => engine.renderVideo({ asset, sourcePath, ops, outputPath, workingDirectory: join(directory, 'render'), files: { yellow: { normalizedPath: yellowPath } } }));
  assert.equal(rendered.value.durationFrames, expected.at(-1).outputOut);
  const outputInfo = await validateResult(rendered.value, outputPath);
  const enabled = engine.mapToOutput(rendered.value.timelineMap, ops.at(-1).sourceRanges)[0];
  const still = await frame(outputPath, Math.floor((enabled.frameIn + enabled.frameOut) / 2), `${spec.id}-overlay-present`);
  const pixel = still.pixel(asset.width * .15, asset.height * .15);
  assert.ok(pixel[0] > 210 && pixel[1] > 210 && pixel[2] < 70, `expected rendered yellow PNG, got ${pixel}`);
  const outside = await frame(outputPath, 0, `${spec.id}-overlay-absent`), canonical = await frame(previewPath, 0, `${spec.id}-canonical-first`);
  const a = outside.pixel(asset.width * .15, asset.height * .15), b = canonical.pixel(asset.width * .15, asset.height * .15);
  assert.ok(a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / 3 < 28, 'overlay must not be present before its interval');
  let silenceRms = null;
  if (!asset.hasAudio) {
    const pcmPath = join(directory, 'silence-check.pcm');
    await engine.run(engine.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', outputPath, '-t', '0.5', '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', pcmPath]);
    const pcm = await readFile(pcmPath); let squares = 0;
    for (let i = 0; i < pcm.length; i += 2) squares += pcm.readInt16LE(i) ** 2;
    silenceRms = Math.sqrt(squares / (pcm.length / 2)); assert.ok(silenceRms < 2, `silent input produced audible output: ${silenceRms}`);
  }
  const row = { id: spec.id, derived: spec.derived || null, sourcePath, sourceInfo, asset, ingest: { ...imported, value: undefined }, render: { ...rendered, value: undefined }, segments: rendered.value.timelineMap.length, outputPath, outputInfo, overlayPixel: pixel, sampleFrame: still.path, silenceRms };
  report.samples.push(row); ingested.set(spec.id, { asset, previewPath, sourcePath });
  console.log(JSON.stringify({ event: 'sample-pass', ...row }));
}
async function runStress() {
  const spec = specs[0], sourcePath = await sourceFor(spec), previewPath = join(fixtureRoot, 'stress-real-8s-640.mp4');
  if (!(await exists(previewPath))) await engine.run(engine.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-t', '8', '-vf', 'scale=640:360,fps=30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', previewPath]);
  const asset = { width: 640, height: 360, durationFrames: 240, fps: 30, hasAudio: true };
  const boxes = Array.from({ length: 30 }, (_, i) => op('overlay', 4 + i * 6, 8 + i * 6, { kind: 'box', color: '#DFFF00' }, { id: `box-${i}`, region: { x: .1, y: .1, w: .6, h: .6 } }));
  for (const [id, ops] of [['distinct-boxes-30', boxes], ['same-time-boxes-30', boxes.map(item => ({ ...item, sourceRanges: [{ frameIn: 30, frameOut: 210 }] }))]]) {
    const compileStarted = performance.now(), map = engine.compileTimeline(asset.durationFrames, ops), compileMs = performance.now() - compileStarted;
    const directory = join(outputRoot, id); await mkdir(directory, { recursive: true });
    const outputPath = join(directory, 'edited.mp4');
    const rendered = await measure(() => engine.renderVideo({ asset, sourcePath: previewPath, ops, outputPath, workingDirectory: join(directory, 'render') }));
    await validateResult(rendered.value, outputPath);
    const filters = await readFile(join(directory, 'render/filters.txt'), 'utf8');
    const row = { id, compileMs, segments: map.length, graphicsInputs: (filters.match(/overlay=/g) || []).length, filterBytes: Buffer.byteLength(filters), elapsedMs: rendered.elapsedMs, peakFfmpegRssKiB: rendered.peakFfmpegRssKiB, peakFfmpegCpuPercent: rendered.peakFfmpegCpuPercent, nativeResources: rendered.nativeResources, outputPath, diagnostics: rendered.value.diagnostics || null };
    report.stress.push(row); console.log(JSON.stringify({ event: 'stress-pass', ...row }));
  }
  const manyOverlays = Array.from({ length: 105 }, (_, i) => op('overlay', i * 2, i * 2 + 1, { kind: 'box' }, { id: `many-${i}` }));
  let manyResult;
  try { manyResult = { segments: engine.compileTimeline(240, manyOverlays).length }; }
  catch (error) { manyResult = { error: error.message }; }
  report.stress.push({ id: 'compile-105-overlays', operations: 105, ...manyResult });
  if (suite === 'baseline') return;
  assert.equal(manyResult.segments, 1, 'overlay-only ranges must not inflate temporal segment count or hit the 100 segment cap');
  const points = Array.from({ length: 1000 }, (_, i) => ({ x: .08 + .80 * i / 999, y: .45 + .10 * Math.sin(i / 35) }));
  const drawings = Array.from({ length: 30 }, (_, i) => ({ id: `pen-${i}`, kind: i === 0 ? 'arrow' : 'pen', color: '#ff00ff', strokeWidth: 3, opacity: 1, points: i === 0 ? [{ x: .10, y: .20 }, { x: .80, y: .20 }] : points.map(p => ({ x: p.x, y: Math.min(.95, p.y + i * .004) })) }));
  const ops = [op('overlay', 30, 210, { kind: 'drawing', drawings }, { id: 'arrow-pen-30x1000' })], directory = join(outputRoot, 'arrow-pen-30x1000');
  await mkdir(directory, { recursive: true }); const outputPath = join(directory, 'edited.mp4');
  const rendered = await measure(() => engine.renderVideo({ asset, sourcePath: previewPath, ops, outputPath, workingDirectory: join(directory, 'render') }));
  await validateResult(rendered.value, outputPath);
  const image = await frame(outputPath, 90, 'arrow-pen-rendered'), pixel = image.pixel(asset.width * .35, asset.height * .20);
  const baseImage = await frame(previewPath, 90, 'arrow-pen-source'), basePixel = baseImage.pixel(asset.width * .35, asset.height * .20);
  // Thin colored strokes become mixed chroma after H.264 4:2:0; compare to the actual source pixel.
  assert.ok(pixel[0] - basePixel[0] > 35 && pixel[2] - basePixel[2] > 35 && pixel[0] - pixel[1] > 35 && pixel[2] - pixel[1] > 35, `drawing arrow missing: rendered=${pixel}, source=${basePixel}`);
  const penPixel = image.pixel(asset.width * .35, asset.height * .48);
  assert.ok(penPixel[0] > 200 && penPixel[2] > 200 && penPixel[1] < 80, `freehand drawings missing: ${penPixel}`);
  const repeated = await measure(() => engine.renderVideo({ asset, sourcePath: previewPath, ops, outputPath: join(directory, 'cached.mp4'), workingDirectory: join(directory, 'render') }));
  await validateResult(repeated.value, join(directory, 'cached.mp4'));
  const row = { id: 'arrow-pen-30x1000', shapes: drawings.length, freehandPoints: points.length, elapsedMs: rendered.elapsedMs, peakFfmpegRssKiB: rendered.peakFfmpegRssKiB, nativeResources: rendered.nativeResources, outputPath, sampleFrame: image.path, arrowPixel: pixel, baseArrowPixel: basePixel, penPixel, diagnostics: rendered.value.diagnostics || null, repeatElapsedMs: repeated.elapsedMs, repeatDiagnostics: repeated.value.diagnostics || null, repeatNativeResources: repeated.nativeResources };
  report.stress.push(row); console.log(JSON.stringify({ event: 'stress-pass', ...row }));
}
try {
  if (suite !== 'stress') for (const spec of selected) { try { await runBasic(spec); } catch (error) { report.failures.push({ id: spec.id, error: error.stack }); console.error(`FAIL ${spec.id}: ${error.message}`); } await writeFile(join(outputRoot, 'report.json'), JSON.stringify(report, null, 2)); }
  try { await runStress(); } catch (error) { report.failures.push({ id: 'stress', error: error.stack }); console.error(`FAIL stress: ${error.message}`); }
  for (const [path, expected] of originalStates) {
    const actual = await stat(path); assert.equal(actual.size, expected.size, `original size changed: ${path}`); assert.equal(actual.mtimeMs, expected.mtimeMs, `original timestamp changed: ${path}`);
    const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); assert.equal(hash.digest('hex'), expected.sha256, `original contents changed: ${path}`);
  }
  report.originalsPreserved = Object.fromEntries(originalStates); report.finishedAt = new Date().toISOString();
} catch (error) { report.failures.push({ id: 'harness', error: error.stack }); }
finally { await writeFile(join(outputRoot, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ event: 'summary', reportPath: join(outputRoot, 'report.json'), samples: report.samples.length, stress: report.stress.length, failures: report.failures.length }));
if (report.failures.length) process.exitCode = 1;
