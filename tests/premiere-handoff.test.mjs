import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { buildPremiereBundle, preparePremiereExport } from '../apps/worker/premiere-export.mjs';
import bridge from '../integrations/premiere/bridge.js';

const drawing = frame => ({ id: `rect-${frame}`, kind: 'rect', color: '#ff0000', points: [],
  region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fill: '#ff0000', strokeWidth: 2, opacity: 0.5, frame });
function workspace() {
  const original = { id: 'v1', assetId: 'asset', status: 'ready', number: 1, label: '원본', durationFrames: 300,
    mediaUrl: '/does-not-exist.mp4', timelineMap: [{ sourceIn: 0, sourceOut: 300, outputIn: 0, outputOut: 300, speed: 1 }] };
  const edited = { ...original, id: 'v2', number: 2, label: '컷·배속', durationFrames: 150,
    timelineMap: [{ sourceIn: 0, sourceOut: 90, outputIn: 0, outputOut: 90, speed: 1 },
      { sourceIn: 180, sourceOut: 300, outputIn: 90, outputOut: 150, speed: 2 }] };
  const comment = (id, start, end, drawings) => ({ id, versionId: 'v1', frameIn: start, frameOut: end,
    contextFrame: start, sourceRanges: [{ frameIn: start, frameOut: end }], text: '여기 수정\n한글 피드백',
    drawings, supplements: [{ text: '추가 내용', createdAt: '2026-10-20' }], attachmentIds: ['image-secret'], voiceAssetId: 'voice-secret' });
  return { project: { id: 'project', name: '디렉팅' }, asset: { width: 320, height: 180, mediaUrl: '/private/video.mp4' },
    versions: [original, edited], comments: [
      comment('survives', 210, 240, [drawing(210)]),
      comment('gone', 120, 150, [drawing(120)]),
      comment('partial', 60, 210, [drawing(60), drawing(195)]),
    ], attachments: [{ id: 'image-secret', mediaUrl: '/private/reference.png' }], ops: [] };
}
const sequenceInfo = (overrides = {}) => ({ projectId: 'pr-project', sequenceId: 'pr-sequence',
  name: '시퀀스', timebase: '8467200000', endSeconds: 10, width: 320, height: 180, ...overrides });

test('video-free export preserves authored geometry, cut/speed anchors and immutable state', async () => {
  const state = workspace(), before = structuredClone(state);
  const { bundle, pngs } = await buildPremiereBundle(state, 'v2');
  assert.deepEqual(state, before);
  assert.equal(bundle.videoIncluded, false);
  assert.equal(bundle.stillsIncluded, false);
  assert.equal(bundle.modelCalled, false);
  assert.equal(pngs.length, 4);
  const [survives, gone, partial] = bundle.feedback;
  assert.deepEqual(survives.ranges, [{ frameIn: 105, frameOut: 120 }]);
  assert.equal(survives.overlays[0].frame, 105);
  assert.deepEqual(survives.overlays[0].drawings, state.comments[0].drawings);
  assert.equal(survives.excludedAttachmentCount, 2);
  assert.equal(gone.status, 'deleted');
  assert.deepEqual(gone.ranges, []);
  assert.equal(gone.overlays[0].frame, null);
  assert.equal(gone.overlays[0].status, 'deleted');
  assert.equal(partial.status, 'partial');
  assert.deepEqual(survives.overlays[0].displayRanges, [{ frameIn: 105, frameOut: 120 }]);
  assert.deepEqual(gone.overlays[0].displayRanges, []);
  assert.deepEqual(partial.overlays.map(o => o.displayRanges), [[{ frameIn: 60, frameOut: 90 }, { frameIn: 90, frameOut: 98 }], [{ frameIn: 98, frameOut: 105 }]]);
  assert.deepEqual(partial.overlays.map(o => o.frame), [60, 98]);
  const serialized = JSON.stringify(bundle);
  for (const secret of ['mediaUrl', '/private/', '.mp4', 'image-secret', 'voice-secret']) assert.ok(!serialized.includes(secret));
  const { data, info } = await sharp(pngs[0].bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 320); assert.equal(info.height, 180);
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
  assert.equal(pixel(0, 0)[3], 0, 'background contains no video pixels');
  const center = pixel(160, 90);
  assert.ok(center[0] > 250 && center[1] === 0 && center[2] === 0 && center[3] >= 126 && center[3] <= 129);
});

test('portable ZIP contains only JSON, instructions and transparent PNGs; requires no source media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vi-premiere-test-'));
  try {
    const result = await preparePremiereExport(workspace(), 'v2', directory);
    const entries = execFileSync('/usr/bin/unzip', ['-Z1', result.archivePath], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(entries.length, 6 + result.timelineSegmentCount);
    assert.ok(entries.every(name => /^(premiere-feedback\.json|README\.txt|overlays\/\d{4}-\d{2}\.png|timeline-overlays\/vi-[a-f0-9-]+\.png)$/.test(name)));
    const bundle = bridge.validateBundle(JSON.parse(await readFile(result.manifestPath, 'utf8')));
    for (const entry of bundle.feedback) for (const overlay of entry.overlays) {
      const bytes = await readFile(join(result.directory, overlay.file));
      assert.equal(overlay.preview, `data:image/png;base64,${bytes.toString('base64')}`);
    }
    assert.equal(result.unplacedCount, 1);
    const pluginEntries = execFileSync('/usr/bin/unzip', ['-Z1', result.pluginArchivePath], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(pluginEntries.sort(), ['manifest.json', 'index.html', 'main.js', 'bridge.js', 'overlays.js', 'sha256.js', 'style.css', 'README.md'].map(name => `premiere-panel/${name}`).sort());
    const manifest = JSON.parse(execFileSync('/usr/bin/unzip', ['-p', result.pluginArchivePath, 'premiere-panel/manifest.json'], { encoding: 'utf8' }));
    assert.equal(manifest.host.app, 'premierepro');
    assert.deepEqual(manifest.requiredPermissions, { localFileSystem: 'request' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('full size transparent overlays retain placement while panel previews stay bounded', async () => {
  const state = workspace();
  state.asset.width = 1920; state.asset.height = 1080;
  state.comments = [state.comments[0]];
  const { bundle, pngs } = await buildPremiereBundle(state, 'v1');
  const full = await sharp(pngs[0].bytes).metadata();
  const preview = await sharp(Buffer.from(bundle.feedback[0].overlays[0].preview.split(',')[1], 'base64')).metadata();
  assert.deepEqual([full.width, full.height, full.hasAlpha], [1920, 1080, true]);
  assert.deepEqual([preview.width, preview.height, preview.hasAlpha], [960, 540, true]);
  state.comments[0].frameOut = state.comments[0].frameIn + 1;
  state.comments[0].sourceRanges[0].frameOut = state.comments[0].frameOut;
  const { bundle: point } = await buildPremiereBundle(state, 'v1');
  const binding = bridge.sequenceBinding(point, sequenceInfo({ width: 1920, height: 1080 }));
  assert.equal(bridge.markerPlan(point, binding).markers[0].durationSeconds, 0);
});

test('frame rate conversion uses elapsed time and offset without 29.97 / 24 fps drift', async () => {
  const { bundle } = await buildPremiereBundle(workspace(), 'v2');
  for (const timebase of ['8475667200', '10584000000']) {
    const binding = bridge.sequenceBinding(bundle, sequenceInfo({ timebase }), 1.1);
    const expected = 105 / 30 + binding.offsetSeconds;
    assert.ok(Math.abs(bridge.sequenceSeconds(105, binding) - expected) <= binding.frameSeconds / 2 + 1e-9);
    const { markers } = bridge.markerPlan(bundle, binding);
    assert.equal(markers.length, 3, 'deleted scene omitted; partial ranges stay separate');
    assert.ok(markers.every(marker => marker.startSeconds >= 0 && marker.durationSeconds > 0));
  }
  assert.throws(() => bridge.sequenceBinding(bundle, sequenceInfo({ width: 1920 })), /해상도/);
  assert.throws(() => bridge.sequenceBinding(bundle, sequenceInfo({ endSeconds: 1 })), /짧/);
  assert.throws(() => bridge.sequenceBinding(bundle, sequenceInfo(), NaN), /시간/);
  const binding = bridge.sequenceBinding(bundle, sequenceInfo());
  assert.throws(() => bridge.assertBinding(binding, sequenceInfo({ sequenceId: 'other' })), /바뀌/);
  assert.throws(() => bridge.assertBinding(binding, sequenceInfo({ endSeconds: 9 })), /바뀌/);
});

function fakePremiere() {
  let locked = false, records = [], undo = [];
  const record = values => ({ ...values, getName() { return this.name; }, getComments() { return this.comments; } });
  const sequence = { guid: { toString: () => 'pr-sequence' }, name: '시퀀스',
    getFrameSize: async () => ({ width: 320, height: 180 }), getEndTime: async () => ({ seconds: 10 }), getTimebase: async () => '8467200000' };
  const project = { guid: { toString: () => 'pr-project' }, getActiveSequence: async () => sequence,
    lockedAccess: fn => { locked = true; try { fn(); } finally { locked = false; } },
    executeTransaction: fn => {
      assert.equal(locked, true);
      const actions = []; fn({ addAction: action => actions.push(action) });
      undo.push(records.slice()); for (const action of actions) action();
      return true;
    } };
  const collection = { getMarkers: async () => records.slice(),
    createRemoveMarkerAction: marker => { assert.equal(locked, true); return () => { records = records.filter(item => item !== marker); }; },
    createAddMarkerAction: (name, type, start, duration, comments) => {
      assert.equal(locked, true); assert.equal(type, 'Comment');
      return () => records.push(record({ name, comments, start: start.seconds, duration: duration.seconds }));
    } };
  return { api: { Project: { getActiveProject: async () => project }, Markers: { getMarkers: async () => collection },
    TickTime: { createWithSeconds: seconds => ({ seconds }) } },
    add: values => records.push(record(values)), values: () => records.map(({ name, comments, start, duration }) => ({ name, comments, start, duration })),
    undo: () => { records = undo.pop(); } };
}

test('Premiere adapter refreshes scoped markers without duplicates, preserves others, supports empty snapshot and undo', async () => {
  const state = workspace(), { bundle } = await buildPremiereBundle(state, 'v2');
  const binding = bridge.sequenceBinding(bundle, sequenceInfo());
  const host = fakePremiere();
  host.add({ name: '사용자 마커', comments: '남겨두기', start: 0, duration: 0 });
  host.add({ name: '[VI:other-version] 이전 버전', comments: '남겨두기', start: 1, duration: 0 });
  assert.deepEqual(await bridge.syncMarkers(host.api, bundle, binding), { added: 3, replaced: 0 });
  const first = host.values();
  assert.deepEqual(await bridge.syncMarkers(host.api, bundle, binding), { added: 3, replaced: 3 });
  assert.deepEqual(host.values(), first);
  bundle.feedback[0].text = '수정한 댓글';
  await bridge.syncMarkers(host.api, bundle, binding);
  assert.ok(host.values().some(marker => marker.comments.includes('수정한 댓글')));
  host.undo(); assert.deepEqual(host.values(), first);
  const { bundle: empty } = await buildPremiereBundle({ ...state, comments: [] }, 'v2');
  assert.equal(empty.scope, bundle.scope);
  assert.deepEqual(await bridge.syncMarkers(host.api, empty, binding), { added: 0, replaced: 3 });
  assert.equal(host.values().length, 2);
  assert.equal(host.values()[0].name, '사용자 마커');
});

test('invalid external bundles cannot add positions to deleted scenes or load remote image resources', async () => {
  const { bundle } = await buildPremiereBundle(workspace(), 'v2');
  const invalid = mutate => { const copy = structuredClone(bundle); mutate(copy); assert.throws(() => bridge.validateBundle(copy)); };
  invalid(b => { b.schemaVersion = 99; });
  invalid(b => { b.feedback[0].overlays[0].preview = 'https://example.com/image.png'; });
  invalid(b => { b.feedback[0].overlays[0].file = '../../private.png'; });
  invalid(b => { b.feedback[1].ranges = [{ frameIn: 0, frameOut: 1 }]; });
  invalid(b => { b.feedback[0].ranges[0].frameOut = 999; });
  invalid(b => { b.feedback[0].overlays[0].frame = NaN; });
  invalid(b => { b.feedback.push(b.feedback[0]); });
});
