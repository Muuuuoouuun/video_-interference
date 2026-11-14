import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { ffmpegPath, ingest, mapToSource, renderVideo, run } from '../apps/worker/engine.mjs';
import { planCanonicalFrameRuns } from '../apps/worker/canonical-frames.mjs';

const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const codeFiles = ['apps/worker/filmstrip.mjs', 'apps/worker/canonical-frames.mjs', 'apps/worker/parallel.mjs', 'apps/worker/engine.mjs'];

/** Measure actual FFmpeg starts independently of the filmstrip module's diagnostics. */
export async function measureFilmstrip({ versionId, videoPath, durationFrames, directory }) {
  await mkdir(directory, { recursive: true });
  const runDirectory = await mkdtemp(join(directory, 'measured-'));
  const wrapper = join(runDirectory, 'ffmpeg-counted.mjs'), logPath = join(runDirectory, 'native-calls.jsonl');
  await writeFile(logPath, '');
  const nativeTime = process.platform === 'darwin';
  await writeFile(wrapper, `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nimport {appendFileSync} from 'node:fs';\nlet stderr='';const started=Date.now();\nconst child=spawn(${JSON.stringify(nativeTime ? '/usr/bin/time' : ffmpegPath)},${nativeTime ? `['-l',${JSON.stringify(ffmpegPath)},...process.argv.slice(2)]` : 'process.argv.slice(2)'},{stdio:['ignore','inherit','pipe']});\nchild.stderr.on('data',chunk=>{stderr+=chunk;process.stderr.write(chunk)});\nfor(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));\nchild.on('error',error=>{process.stderr.write(error.message);process.exitCode=1});\nchild.on('close',code=>{const rss=stderr.match(/(\\d+)\\s+maximum resident set size/);appendFileSync(${JSON.stringify(logPath)},JSON.stringify({elapsedMs:Date.now()-started,maximumResidentSetBytes:rss?Number(rss[1]):null,exitCode:code})+'\\n');process.exitCode=code===0?0:1});\n`);
  await chmod(wrapper, 0o755);
  const parameters = { versionId, videoPath, durationFrames, directory: join(runDirectory, 'cache') };
  const script = `import {readFile} from 'node:fs/promises';\nimport {prepareFilmstrip} from ${JSON.stringify(new URL('../apps/worker/filmstrip.mjs', import.meta.url).href)};\nconst calls=async()=> (await readFile(${JSON.stringify(logPath)},'utf8')).trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line));\nconst results=[];\nfor(const label of ['cold','warm']){ const prior=(await calls()).length;const started=performance.now();let sampledPeakNodeRssBytes=process.memoryUsage().rss;const timer=setInterval(()=>{sampledPeakNodeRssBytes=Math.max(sampledPeakNodeRssBytes,process.memoryUsage().rss)},5);try{const result=await prepareFilmstrip(${JSON.stringify(parameters)});results.push({label,result,elapsedMs:performance.now()-started,sampledPeakNodeRssBytes:Math.max(sampledPeakNodeRssBytes,process.memoryUsage().rss),nativeCalls:(await calls()).slice(prior)});}finally{clearInterval(timer)}}\nprocess.stdout.write(JSON.stringify(results));\n`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, FFMPEG_PATH: wrapper }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  assert.equal(code, 0, stderr);
  const [cold, warm] = JSON.parse(stdout);
  assert.equal(cold.result.cacheHit, false, 'First extraction must use a fresh cache directory.');
  assert.equal(cold.nativeCalls.length, planCanonicalFrameRuns(cold.result.frames).length, 'A cold strip starts one short seek+decode FFmpeg process per planned run.');
  assert.equal(warm.result.cacheHit, true);
  assert.equal(warm.nativeCalls.length, 0, 'A warm strip starts no FFmpeg process.');
  assert.equal(cold.result.cacheKey, warm.result.cacheKey);
  assert.equal(cold.result.imagePath, warm.result.imagePath);
  return { cold, warm, measurements: { nativeCalls: 'Actual FFmpeg wrapper invocation records, excludes reference-frame verification and ingestion/rendering.', nativeMaximumRss: nativeTime ? 'Per-process macOS time -l maximum resident set size in bytes; child FFmpeg only.' : 'Unavailable on this platform.', nodeRss: 'Absolute Node worker RSS sampled every 5 ms and at call boundaries; excludes FFmpeg and does not claim allocation delta.' } };
}

/** Compare every sprite cell to an independent extraction at its advertised integer frame. */
export async function verifyFilmstripPixels({ strip, videoPath, directory }) {
  await mkdir(directory, { recursive: true });
  assert.equal(strip.cellWidth, 160); assert.equal(strip.cellHeight, 90);
  assert.equal(strip.frames.length, Math.min(12, strip.durationFrames));
  const metadata = await sharp(strip.imagePath).metadata();
  assert.equal(metadata.width, strip.cellWidth * strip.frames.length); assert.equal(metadata.height, strip.cellHeight);
  const checks = [];
  for (let index = 0; index < strip.frames.length; index++) {
    const frame = strip.frames[index];
    assert.ok(Number.isInteger(frame) && frame >= 0 && frame < strip.durationFrames);
    const referencePath = join(directory, `reference-${frame}.png`);
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-an', '-vf', `select=eq(n\\,${frame}),scale=160:90:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=160:90:(ow-iw)/2:(oh-ih)/2:black,setsar=1`, '-frames:v', '1', referencePath]);
    const [expected, actual] = await Promise.all([
      sharp(referencePath).removeAlpha().raw().toBuffer(),
      sharp(strip.imagePath).extract({ left: index * 160, top: 0, width: 160, height: 90 }).removeAlpha().raw().toBuffer(),
    ]);
    assert.equal(actual.length, expected.length);
    const meanAbsoluteError = expected.reduce((sum, value, offset) => sum + Math.abs(value - actual[offset]), 0) / expected.length;
    assert.ok(meanAbsoluteError < .01, `Sprite frame ${frame} differs from independent exact-frame extraction: ${meanAbsoluteError}`);
    checks.push({ index, frame, timestampSeconds: frame / 30, meanAbsoluteError, referencePath });
  }
  return checks;
}

export async function verifyRealFilmstrip({ sourcePath, directory }) {
  sourcePath = resolve(sourcePath); directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  assert.ok(!(await realpath(sourcePath)).startsWith(`${await realpath(directory)}${sep}`), 'Choose a QA output directory separate from the original video.');
  const codeHashes = Object.fromEntries(await Promise.all(codeFiles.map(async path => [path, await hash(new URL(`../${path}`, import.meta.url))])));
  const sourceHash = await hash(sourcePath), canonicalPath = join(directory, 'canonical.mp4');
  const asset = await ingest(sourcePath, canonicalPath, join(directory, 'thumbnail.jpg'));
  assert.ok(asset.durationFrames >= 180, 'This check needs at least six seconds.');
  const operation = (id, type, frameIn, frameOut, params, extra = {}) => ({ id, type, sourceRanges: [{ frameIn, frameOut }], params, status: 'approved', ...extra });
  const ops = [
    operation('trim', 'trim', 0, 180, {}),
    operation('cut', 'cut', 30, 60, {}),
    operation('speed', 'speed', 90, 150, { factor: 2 }),
    operation('subtitle', 'subtitle', 60, 90, { kind: 'text', text: '실제 장면 확인', color: '#00ff00' }),
    operation('drawing', 'overlay', 150, 180, { kind: 'drawing', drawings: [{ id: 'visible', frame: 160, kind: 'rect', color: '#ff00ff', fill: '#ff00ff', points: [{ x: .1, y: .1 }, { x: .3, y: .4 }] }] }),
  ];
  const editedPath = join(directory, 'edited.mp4');
  const rendered = await renderVideo({ asset, sourcePath, ops, outputPath: editedPath, workingDirectory: join(directory, 'render') });
  assert.equal(rendered.durationFrames, 120);
  const editedHash = await hash(editedPath), canonicalHash = await hash(canonicalPath);
  const original = await measureFilmstrip({ versionId: 'qa-original', videoPath: canonicalPath, durationFrames: asset.durationFrames, directory: join(directory, 'original') });
  const edited = await measureFilmstrip({ versionId: 'qa-edited', videoPath: editedPath, durationFrames: rendered.durationFrames, directory: join(directory, 'edited') });
  assert.notEqual(original.cold.result.cacheKey, edited.cold.result.cacheKey, 'Original and edited versions have separate cached artifacts.');
  const originalCells = await verifyFilmstripPixels({ strip: original.cold.result, videoPath: canonicalPath, directory: join(directory, 'original-reference') });
  const editedCells = await verifyFilmstripPixels({ strip: edited.cold.result, videoPath: editedPath, directory: join(directory, 'edited-reference') });
  for (const cell of editedCells) cell.sourceFrame = mapToSource(rendered.timelineMap, cell.frame, cell.frame + 1)[0].frameIn;
  const drawingCell = editedCells.find(cell => cell.frame >= 90 && cell.frame < 120);
  const rgb = [...await sharp(drawingCell.referencePath).extract({ left: 32, top: 22, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  assert.ok(rgb[0] > 200 && rgb[1] < 40 && rgb[2] > 200, `Rendered drawing must be visible in the edited strip: ${rgb}`);
  const subtitleCells = editedCells.filter(cell => cell.frame >= 30 && cell.frame < 60);
  assert.ok(subtitleCells.length > 0);
  for (const cell of subtitleCells) {
    const pixels = await sharp(cell.referencePath).extract({ left: 16, top: 70, width: 128, height: 14 }).removeAlpha().raw().toBuffer();
    let greenPixels = 0;
    for (let index = 0; index < pixels.length; index += 3) if (pixels[index + 1] > 70 && pixels[index + 1] > pixels[index] * 1.6 && pixels[index + 1] > pixels[index + 2] * 1.6) greenPixels++;
    assert.ok(greenPixels >= 5, `Green final subtitle is absent from strip frame ${cell.frame}: ${greenPixels}`);
    cell.greenSubtitlePixels = greenPixels;
  }
  assert.equal(await hash(sourcePath), sourceHash); assert.equal(await hash(canonicalPath), canonicalHash); assert.equal(await hash(editedPath), editedHash);
  for (const path of codeFiles) assert.equal(await hash(new URL(`../${path}`, import.meta.url)), codeHashes[path], `Checked module changed during verification: ${path}`);
  const report = { checkedAt: new Date().toISOString(), sourcePath, sourceHash, sourcePreserved: true, versionsPreserved: true, codeHashes, asset, editedFrames: rendered.durationFrames, original, edited, originalCells, editedCells, renderedDrawingRgb: rgb, scope: 'Native sprite extraction and disk cache for original 35-second local footage and a cut/speed/subtitle/drawing output. No browser interaction, no API scheduler concurrency or loop playback claim.' };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], 'Usage: node scripts/verify-filmstrip.mjs SOURCE.mp4 [OUTPUT_DIRECTORY]');
  const report = await verifyRealFilmstrip({ sourcePath: process.argv[2], directory: process.argv[3] || 'storage/qa/filmstrip' });
  console.log(JSON.stringify({ originalFrames: report.asset.durationFrames, editedFrames: report.editedFrames, originalCells: report.originalCells.length, editedCells: report.editedCells.length, coldNativeCalls: [report.original.cold.nativeCalls.length, report.edited.cold.nativeCalls.length], warmNativeCalls: [report.original.warm.nativeCalls.length, report.edited.warm.nativeCalls.length], sourcePreserved: report.sourcePreserved }, null, 2));
}
