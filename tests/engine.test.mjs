import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ffmpegPath, run, probe, renderVideo, mapToSource, compileTimeline, createGraphic } from '../apps/worker/engine.mjs';
import { interpretLocal, validateAiResponse } from '../apps/worker/interpreter.mjs';
import { createTextDrawing } from '../packages/core/overlay-text.mjs';
import { validateDrawings } from '../apps/worker/drawings.mjs';

const work = await mkdtemp(join(tmpdir(), 'video-interference-engine-'));
const sourcePath = join(work, 'source.mp4');
await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '6', sourcePath]);
const asset = { durationFrames: 180, fps: 30, width: 320, height: 180, hasAudio: true };
const op = (type, frameIn, frameOut, params = {}) => ({ id: `${type}_${frameIn}_${frameOut}`, type, sourceRanges: [{ frameIn, frameOut }], params, status: 'approved' });
const results = new Map();

async function render(name, ops, overrides = {}) {
  const outputPath = join(work, `${name}.mp4`);
  const result = await renderVideo({ asset, sourcePath, ops, outputPath, workingDirectory: join(work, name), ...overrides });
  results.set(name, { ...result, outputPath }); return { ...result, outputPath };
}

async function pixelAt(path, frame, x = 20, y = 20) {
  const still = join(work, `pixel-${Math.random()}.png`);
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', still]);
  const { data, info } = await sharp(still).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
}

await test('native render removes exactly 30 frames and joins the surviving source scenes', async () => {
  const result = await render('cut', [op('cut', 30, 60)]);
  assert.equal(result.durationFrames, 150);
  const pixel = await pixelAt(result.outputPath, 40); assert.ok(pixel[1] > pixel[0] * 3, `expected green scene, got ${pixel}`);
});

await test('native render speeds a two second source interval to one second while keeping audio', async () => {
  const result = await render('speed', [op('speed', 60, 120, { factor: 2 })]);
  assert.equal(result.durationFrames, 150);
  const info = await probe(result.outputPath); assert.ok(info.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(Math.abs(Number(info.format.duration) - 5) < 0.05);
  const pixel = await pixelAt(result.outputPath, 110); assert.ok(pixel[2] > pixel[1] * 3, `expected blue scene after speed change, got ${pixel}`);
});

await test('cut plus speed maps requests on a revised version onto the original scene', async () => {
  const result = await render('combined', [op('cut', 30, 60), op('speed', 60, 120, { factor: 2 })]);
  assert.equal(result.durationFrames, 120);
  assert.deepEqual(mapToSource(result.timelineMap, 60, 90), [{ frameIn: 120, frameOut: 150 }]);
  const pixel = await pixelAt(result.outputPath, 75); assert.ok(pixel[2] > pixel[0] * 3);
});

await test('trim retains only the requested source range', async () => {
  const result = await render('trim', [op('trim', 60, 120)]); assert.equal(result.durationFrames, 60);
  const pixel = await pixelAt(result.outputPath, 30); assert.ok(pixel[1] > pixel[2] * 3);
});

await test('Korean subtitle raster is visibly present only during its source interval', async () => {
  const subtitle = { ...op('subtitle', 60, 120, { text: '배움이 이어지는 순간', kind: 'text' }), region: { x: 0.1, y: 0.65, w: 0.8, h: 0.3 } };
  const result = await render('subtitle', [subtitle]);
  const inside = await pixelAt(result.outputPath, 90, 40, 130), outside = await pixelAt(result.outputPath, 130, 40, 130);
  assert.ok(inside[1] < 60, `subtitle background should darken region, got ${inside}`);
  assert.ok(outside[2] > 200, `subtitle should disappear, got ${outside}`);
});

await test('static insertion image is rendered at the normalized drawing region', async () => {
  const imagePath = join(work, 'yellow.png'); await sharp({ create: { width: 40, height: 40, channels: 4, background: '#ffff00' } }).png().toFile(imagePath);
  const overlay = { ...op('overlay', 0, 60, { kind: 'image', assetRef: 'logo' }), region: { x: 0.1, y: 0.1, w: 0.25, h: 0.4 } };
  const result = await render('image', [overlay], { files: { logo: { normalizedPath: imagePath } } });
  const pixel = await pixelAt(result.outputPath, 30, 60, 50); assert.ok(pixel[0] > 220 && pixel[1] > 220 && pixel[2] < 30, `expected yellow overlay, got ${pixel}`);
});

await test('whole-track mute creates quiet audio in the selected interval', async () => {
  const result = await render('audio', [op('audio', 60, 120, { volume: 0 })]);
  const pcmPath = join(work, 'audio.pcm'); await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', result.outputPath, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', pcmPath]);
  const pcm = await readFile(pcmPath);
  const rms = (start, end) => { let squares = 0, samples = 0; for (let offset = Math.round(start * 48000) * 2; offset < Math.round(end * 48000) * 2; offset += 2) { squares += pcm.readInt16LE(offset) ** 2; samples++; } return Math.sqrt(squares / samples); };
  assert.ok(rms(0.5, 1.5) > 1000); assert.ok(rms(2.5, 3.5) < 20);
});

await test('video without an audio stream renders with a silent compatibility track', async () => {
  const silentSource = join(work, 'silent-source.mp4'); await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-an', '-c:v', 'copy', silentSource]);
  const result = await render('silent', [op('speed', 0, 180, { factor: 1.5 })], { asset: { ...asset, hasAudio: false }, sourcePath: silentSource });
  assert.equal(result.durationFrames, 120); const info = await probe(result.outputPath); assert.ok(info.streams.some(stream => stream.codec_type === 'audio'));
  const pcmPath = join(work, 'silent.pcm'); await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', result.outputPath, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', pcmPath]);
  const pcm = await readFile(pcmPath); let squares = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) squares += pcm.readInt16LE(offset) ** 2;
  assert.ok(Math.sqrt(squares / (pcm.length / 2)) < 1, 'silent compatibility audio must contain no DC offset');
});

await test('invalid all-cut request is rejected before a render starts', () => { assert.throws(() => compileTimeline(180, [op('cut', 0, 180)]), /모든 영상/); });
await test('local parser supports multi-op instructions and asks about unsupported tracking', () => {
  const comment = { id: 'c', versionId: 'v', frameIn: 30, frameOut: 60, sourceRanges: [{ frameIn: 30, frameOut: 60 }], drawings: [], attachmentIds: [], text: "여기 2배속하고 자막 '빠르게 보기' 띄워줘" };
  const result = interpretLocal(comment, []); assert.deepEqual(result.ops.map(item => item.type), ['speed', 'subtitle']); assert.equal(result.mode, 'local-rules');
  const unsupported = interpretLocal({ ...comment, text: '얼굴 추적해서 확대해줘' }, []); assert.equal(unsupported.ops.length, 0); assert.match(unsupported.clarification, /후속/);
  const reference = interpretLocal({ ...comment, text: '이 로고 넣어줘', attachmentIds: ['a'] }, [{ id: 'a', role: 'reference', mimeType: 'image/png' }]); assert.equal(reference.ops.length, 0); assert.match(reference.clarification, /참고/);
  for (const text of ['삭제하지 마', '배속 말고 자막 넣어줘', 'do not cut']) {
    const negative = interpretLocal({ ...comment, text }, []); assert.equal(negative.ops.length, 0); assert.ok(negative.clarification);
  }
});

const shapes = [
  { id: 'rect', kind: 'rect', color: '#FF0000', fill: '#FFFFFF', strokeWidth: 20, opacity: 0.5, points: [{ x: 0.05, y: 0.05 }, { x: 0.25, y: 0.35 }] },
  { id: 'ellipse', kind: 'ellipse', color: '#00FF00', fill: '#00FF00', strokeWidth: 12, opacity: 0.8, points: [], region: { x: 0.35, y: 0.05, w: 0.2, h: 0.3 } },
  { id: 'line', kind: 'line', color: '#0000FF', strokeWidth: 20, points: [{ x: 0.65, y: 0.1 }, { x: 0.85, y: 0.1 }] },
  { id: 'arrow', kind: 'arrow', color: '#00FFFF', strokeWidth: 20, points: [{ x: 0.65, y: 0.3 }, { x: 0.9, y: 0.3 }] },
  { id: 'pen', kind: 'pen', color: '#FFFFFF', strokeWidth: 24, points: [{ x: 0.1, y: 0.65 }, { x: 0.3, y: 0.7 }, { x: 0.5, y: 0.6 }] },
  { id: 'dot', kind: 'pen', color: '#FFFFFF', strokeWidth: 24, opacity: 0.4, points: [{ x: 0.7, y: 0.65 }] }
];

await test('vector raster contains all shape kinds, scaled strokes, fills and exact alpha', async () => {
  const drawing = op('overlay', 0, 180, { kind: 'drawing', drawings: shapes });
  const raster = await createGraphic(asset, drawing, join(work, 'drawing-raster'));
  const { data, info } = await sharp(raster.path).raw().toBuffer({ resolveWithObject: true });
  const rgba = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
  assert.deepEqual(rgba(48, 36), [255, 255, 255, 128], 'rect fill alpha');
  assert.deepEqual(rgba(144, 36), [0, 255, 0, 204], 'ellipse fill alpha');
  assert.equal(rgba(112, 9)[3], 0, 'ellipse bounding-box corner remains transparent');
  assert.deepEqual(rgba(240, 18), [0, 0, 255, 255], 'line');
  assert.deepEqual(rgba(270, 47), [0, 255, 255, 255], 'arrow head');
  assert.deepEqual(rgba(96, 126), [255, 255, 255, 255], 'pen join');
  assert.equal(rgba(224, 117)[3], 102, 'single-point pen opacity');
  assert.equal(rgba(310, 160)[3], 0, 'outside shapes stays transparent');
  const openPen = await createGraphic(asset, op('overlay', 0, 180, { kind: 'drawing', drawings: [{ id: 'open-pen', kind: 'pen', color: '#00FF00', fill: '#FF0000', strokeWidth: 3, points: [{ x: 0.1, y: 0.6 }, { x: 0.1, y: 0.9 }, { x: 0.4, y: 0.9 }] }] }), join(work, 'drawing-raster'));
  const openPixels = await sharp(openPen.path).raw().toBuffer();
  assert.equal(openPixels[(144 * asset.width + 64) * 4 + 3], 0, 'open pen strokes never fill their enclosed region');
});

await test('drawing burn-in respects opacity and exclusive range boundaries on real frames', async () => {
  const result = await render('draw-range', [op('overlay', 60, 90, { kind: 'drawing', drawings: shapes })]);
  assert.equal(result.diagnostics.timelineSegments, 1, 'graphics do not split the media timeline');
  const before = await pixelAt(result.outputPath, 59, 48, 36), first = await pixelAt(result.outputPath, 60, 48, 36), last = await pixelAt(result.outputPath, 89, 48, 36), after = await pixelAt(result.outputPath, 90, 48, 36);
  assert.ok(before[0] > 230 && before[1] < 20);
  assert.ok(first[0] > 100 && first[1] > 160 && first[2] > 100, `expected half-white over green, got ${first}`);
  assert.ok(last[0] > 100 && last[2] > 100);
  assert.ok(after[0] < 20 && after[1] > 100 && after[2] < 20, `out frame must have no drawing, got ${after}`);
});

await test('cut and speed keep drawing and contained image attached to their original scenes', async () => {
  const imagePath = join(work, 'wide-yellow.png'); await sharp({ create: { width: 200, height: 20, channels: 4, background: '#FFFF00' } }).png().toFile(imagePath);
  const drawing = { ...op('overlay', 60, 90, { kind: 'drawing', drawings: shapes }), id: 'mapped-drawing' };
  const image = { ...op('overlay', 120, 150, { kind: 'image', assetRef: 'wide' }), id: 'mapped-image', region: { x: 0.1, y: 0.1, w: 0.25, h: 0.4 } };
  const result = await render('mapped-graphics', [op('cut', 30, 60), op('speed', 60, 120, { factor: 2 }), drawing, image], { files: { wide: { normalizedPath: imagePath } } });
  assert.equal(result.durationFrames, 120);
  const drawIn = await pixelAt(result.outputPath, 30, 48, 36), drawOut = await pixelAt(result.outputPath, 45, 48, 36);
  assert.ok(drawIn[0] > 100 && drawIn[2] > 100); assert.ok(drawOut[0] < 20 && drawOut[2] < 20);
  const imageInside = await pixelAt(result.outputPath, 75, 60, 54), transparentPadding = await pixelAt(result.outputPath, 75, 60, 25), imageOut = await pixelAt(result.outputPath, 90, 60, 54);
  assert.ok(imageInside[0] > 220 && imageInside[1] > 220 && imageInside[2] < 30);
  assert.ok(transparentPadding[2] > 220 && transparentPadding[0] < 30, 'image containment preserves transparent padding');
  assert.ok(imageOut[2] > 220 && imageOut[0] < 30);
});

await test('thirty equal-timing graphic requests use one input and persistent raster and batch caches', async () => {
  const drawings = Array.from({ length: 30 }, (_, index) => ({ ...op('overlay', 30, 150, { kind: 'drawing', drawings: [{ id: `grid-${index}`, kind: 'rect', color: '#FFFFFF', strokeWidth: 8, points: [{ x: 0.02 + index % 6 * 0.16, y: 0.02 + Math.floor(index / 6) * 0.19 }, { x: 0.12 + index % 6 * 0.16, y: 0.14 + Math.floor(index / 6) * 0.19 }] }] }), id: `graphic-${index}` }));
  const first = await render('batch-cold', drawings), second = await render('batch-hot', drawings);
  assert.equal(first.diagnostics.graphicOps, 30); assert.equal(first.diagnostics.graphicInputs, 1); assert.equal(first.diagnostics.timelineSegments, 1);
  assert.equal(second.diagnostics.rasterCacheHits, 30); assert.equal(second.diagnostics.batchCacheHits, 1);
  assert.deepEqual(await pixelAt(first.outputPath, 60, 7, 15), await pixelAt(second.outputPath, 60, 7, 15), 'cached render remains visually identical');
});

await test('batching retains layer order when equal-time graphics surround a different-time layer', async () => {
  const layer = (id, color, frameIn, frameOut) => ({ ...op('overlay', frameIn, frameOut, { kind: 'drawing', drawings: [{ id, kind: 'rect', color, fill: color, points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 }] }] }), id });
  const result = await render('layer-order', [layer('bottom', '#FFFFFF', 0, 60), layer('middle', '#FF0000', 30, 90), layer('top', '#0000FF', 0, 60)]);
  assert.equal(result.diagnostics.graphicInputs, 3);
  const pixel = await pixelAt(result.outputPath, 45, 70, 40); assert.ok(pixel[2] > 220 && pixel[0] < 30, `last layer should stay blue, got ${pixel}`);
});

await test('local and cloud schemas insert only explicitly requested user drawings without invented geometry', () => {
  const comment = { id: 'drawing-c', versionId: 'v', frameIn: 30, frameOut: 60, sourceRanges: [{ frameIn: 30, frameOut: 60 }], drawings: shapes, attachmentIds: [], text: '이 그림과 도형 그대로 영상에 넣어줘' };
  const result = interpretLocal(comment, []); assert.equal(result.ops.length, 1); assert.equal(result.ops[0].params.kind, 'drawing'); assert.deepEqual(result.ops[0].params.drawings, shapes);
  const cloud = validateAiResponse({ ops: [{ type: 'overlay', params: { kind: 'drawing', drawings: [{ kind: 'unknown' }] } }] }, comment, []);
  assert.deepEqual(cloud.ops[0].params.drawings, shapes, 'cloud uses original user geometry, not generated params');
  result.ops[0].params.drawings[0].color = '#000000'; assert.equal(comment.drawings[0].color, '#FF0000', 'proposals cannot mutate source annotation');
  const annotation = { ...comment, text: '여기 참고해줘' }; assert.equal(interpretLocal(annotation, []).ops.length, 0);
  assert.throws(() => validateAiResponse({ ops: [{ type: 'overlay', params: { kind: 'drawing' } }] }, annotation, []), /명시적인/);
  assert.ok(interpretLocal({ ...comment, drawings: [] }, []).clarification);
  assert.equal(interpretLocal({ ...comment, text: '그림은 영상에 넣지 말아줘' }, []).ops.length, 0);
  assert.equal(interpretLocal({ ...comment, text: '그림은 영상에 넣지마' }, []).ops.length, 0);
  assert.throws(() => validateAiResponse({ ops: [{ type: 'overlay', params: { kind: 'drawing' } }] }, { ...comment, text: '그림은 영상에 넣지마' }, []), /명시적인/);
});

await test('drawing validation preserves legacy annotations and rejects malformed styling or coordinates', () => {
  const legacy = { id: 'legacy', kind: 'arrow', color: '#DFFF00', points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 }] };
  assert.deepEqual(validateDrawings([legacy]), [legacy]);
  for (const bad of [{ ...legacy, opacity: 2 }, { ...legacy, strokeWidth: 0 }, { ...legacy, fill: 'url(file:///etc/passwd)' }, { ...legacy, color: '#000000"/>' }, { ...legacy, points: [{ x: -1, y: 0 }, { x: 0, y: 0 }] }, { ...legacy, points: [] }, { ...legacy, script: 'anything' }]) assert.throws(() => validateDrawings([bad]));
  const stress = Array.from({ length: 30 }, (_, i) => ({ ...op('overlay', i + 1, i + 2, { kind: 'drawing', drawings: [legacy] }), id: `d${i}` }));
  assert.equal(compileTimeline(180, stress).length, 1);
});

await test('native FFmpeg renders Korean and escaped text annotations only inside the approved range', async () => {
  const drawing = createTextDrawing({ id: 'native-text', text: '한글 메모 <&>\nTEXT', point: { x: .1, y: .15 }, style: { color: '#FFFFFF' }, fontSize: 110, logicalHeight: 562.5 });
  const result = await render('text-annotation', [op('overlay', 30, 60, { kind: 'drawing', drawings: [drawing] })]);
  const extract = async frame => {
    const path = join(work, `text-frame-${frame}.png`);
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', result.outputPath, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', path]);
    return sharp(path).removeAlpha().raw().toBuffer();
  };
  const before = await extract(20), during = await extract(40), after = await extract(70);
  const whites = buffer => { let count = 0; for (let i = 0; i < buffer.length; i += 3) if (buffer[i] > 180 && buffer[i + 1] > 180 && buffer[i + 2] > 180) count++; return count; };
  assert.equal(whites(before), 0); assert.equal(whites(after), 0);
  assert.ok(whites(during) > 100, 'native output must contain real text pixels, not just saved metadata');
  assert.equal(result.durationFrames, 180);
});

await rm(work, { recursive: true, force: true });
