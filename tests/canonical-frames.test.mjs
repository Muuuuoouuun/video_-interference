import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { planCanonicalFrameDecode } from '../apps/worker/canonical-frames.mjs';
import { ffmpegPath, run } from '../apps/worker/engine.mjs';
import { prepareRequestContextBundle } from '../apps/worker/context-bundle.mjs';
import { prepareFeedbackExport } from '../apps/worker/feedback-export.mjs';

test('canonical still decoding skips only an unused whole-second prefix and retains every requested index', () => {
  assert.deepEqual(planCanonicalFrameDecode([0, 29, 30]).inputArgs, []);
  assert.deepEqual(planCanonicalFrameDecode([59]).inputArgs, []);
  const plan = planCanonicalFrameDecode([271, 272, 300, 359]);
  assert.deepEqual(plan.inputArgs, ['-ss', '8']);
  assert.equal(plan.skippedFrames, 240);
  assert.equal(plan.select, String.raw`eq(n\,31)+eq(n\,32)+eq(n\,60)+eq(n\,119)`);
  for (const frames of [null, [], [NaN], [-1], [0.5], [2, 1], [1, 1], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => planCanonicalFrameDecode(frames));
  }
});

test('native seek extraction matches decoding from frame zero across B-frames, GOPs, second boundaries and EOF', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vi-canonical-frames-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'canonical.mp4');
  // GOP boundaries intentionally do not coincide with whole seconds.
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=12', '-c:v', 'libx264', '-g', '47', '-keyint_min', '47', '-sc_threshold', '0', '-bf', '3', '-pix_fmt', 'yuv420p', source]);
  const groups = [[0, 1, 29, 30], [59, 60, 61, 89, 90], [271, 272, 299, 300, 301, 358, 359]];
  const frames = groups.flat();
  await mkdir(join(directory, 'reference'));
  const common = ['-map', '0:v:0', '-an', '-fps_mode', 'vfr', '-start_number', '0', '-threads', '1'];
  const fullSelect = frames.map(frame => `eq(n\\,${frame})`).join('+');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', source, ...common, '-vf', `select=${fullSelect}`, '-frames:v', String(frames.length), join(directory, 'reference', '%03d.png')]);
  for (let group = 0; group < groups.length; group++) {
    const selected = groups[group], plan = planCanonicalFrameDecode(selected);
    const folder = join(directory, `seek-${group}`); await mkdir(folder);
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...plan.inputArgs, '-i', source, ...common, '-vf', `select=${plan.select}`, '-frames:v', String(selected.length), join(folder, '%03d.png')]);
    for (let index = 0; index < selected.length; index++) {
      const expected = await readFile(join(directory, 'reference', `${String(frames.indexOf(selected[index])).padStart(3, '0')}.png`));
      assert.deepEqual(await readFile(join(folder, `${String(index).padStart(3, '0')}.png`)), expected, `exact pixels at canonical frame ${selected[index]}`);
    }
  }

  await t.test('context and feedback export keep late and out-of-range drawing anchors on the same scenes', async () => {
    const comment = { id: 'late-feedback', versionId: 'v1', kind: 'request', frameIn: 300, frameOut: 360, contextFrame: 359, text: '마지막 장면과 앞의 표시를 함께 확인', drawings: [{ id: 'earlier', kind: 'rect', frame: 271, color: '#0000FF', points: [], region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }], attachmentIds: [], sourceRanges: [{ frameIn: 300, frameOut: 360 }], createdAt: '2026-10-16' };
    const bundle = await prepareRequestContextBundle(comment, { versionPath: source, durationFrames: 360, directory });
    const state = { project: { id: 'p1', name: '검증' }, versions: [{ id: 'v1', assetId: 'a1', number: 1, label: '원본', status: 'ready', durationFrames: 360, mediaUrl: '/media/canonical', timelineMap: [{ sourceIn: 0, sourceOut: 360, outputIn: 0, outputOut: 360, speed: 1, volume: 1 }] }], comments: [comment], attachments: [], ops: [] };
    const exported = await prepareFeedbackExport({ state, targetVersionId: 'v1', files: { canonical: { path: source } }, directory: join(directory, 'exports') });
    assert.deepEqual(exported.manifest.feedback[0].scenes.map(scene => scene.frame), [271, 300, 329, 359]);
    for (const frame of [271, 300, 329, 359]) {
      const reference = join(directory, `full-${frame}.jpg`);
      await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', source, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-q:v', '3', reference]);
      const raw = path => sharp(path).removeAlpha().raw().toBuffer();
      assert.deepEqual(await raw(join(bundle.directory, `scene-${frame}.jpg`)), await raw(reference), `context pixels at ${frame}`);
      const scene = exported.manifest.feedback[0].scenes.find(scene => scene.frame === frame);
      // Export uses quality 2, so compare to its own frame-zero reference.
      await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', source, '-vf', `select=eq(n\\,${frame}),setsar=1`, '-frames:v', '1', '-q:v', '2', reference]);
      assert.deepEqual(await raw(join(exported.directory, scene.file)), await raw(reference), `export pixels at ${frame}`);
    }
  });
});
