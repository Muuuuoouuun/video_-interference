import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { ffmpegPath, ingest, probe, renderVideo, run } from '../apps/worker/engine.mjs';
import { resolveLayerSnapshot, visualLayerId } from '../packages/core/layer-snapshot.mjs';

const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const checkedModules = ['apps/worker/engine.mjs', 'apps/worker/drawings.mjs', 'packages/core/layer-snapshot.mjs'];

/** Isolated native acceptance runner. Never opens or modifies the live project's workspace. */
export async function verifyLayerRevisions({ sourcePath, directory, durationFrames = 180 }) {
  sourcePath = resolve(sourcePath); directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  const actualSource = await realpath(sourcePath), actualDirectory = await realpath(directory);
  assert.ok(actualSource !== actualDirectory && !actualSource.startsWith(`${actualDirectory}${sep}`), 'Choose an output directory separate from the original video.');
  assert.ok(Number.isInteger(durationFrames) && durationFrames >= 90, 'Provide at least three seconds of verification footage.');
  const codeHashes = Object.fromEntries(await Promise.all(checkedModules.map(async path => [path, await hash(new URL(`../${path}`, import.meta.url))])));
  const sourceHash = await hash(sourcePath);
  const canonicalPath = join(directory, 'canonical.mp4');
  const asset = await ingest(sourcePath, canonicalPath, join(directory, 'thumbnail.jpg'));
  assert.ok(asset.durationFrames >= durationFrames, `The source must contain ${durationFrames} frames.`);
  const frameIn = Math.floor(durationFrames / 6), frameOut = Math.floor(durationFrames * 5 / 6), upperIn = Math.floor(durationFrames / 3), sampleFrame = Math.floor(durationFrames / 2);
  const range = (frameIn, frameOut) => [{ frameIn, frameOut }];
  const base = freeze([{ id: 'keep-test-range', type: 'trim', params: {}, sourceRanges: range(0, durationFrames), status: 'approved' }]);
  const drawing = (id, color, region, sourceRanges = range(frameIn, frameOut)) => ({ id, type: 'overlay', params: { kind: 'drawing', drawings: [{ id: `${id}-shape`, frame: sampleFrame, kind: 'rect', color, fill: color, strokeWidth: 2, region, points: [] }] }, sourceRanges, status: 'approved' });
  const bottom = drawing('bottom', '#ff0000', { x: .08, y: .08, w: .42, h: .5 });
  const imagePath = join(directory, 'yellow-image.png');
  await sharp({ create: { width: Math.round(asset.width * .28), height: Math.round(asset.height * .24), channels: 4, background: '#ffff00' } }).png().toFile(imagePath);
  const image = { id: 'image', type: 'overlay', params: { kind: 'image', assetRef: 'yellow' }, region: { x: .23, y: .28, w: .28, h: .24 }, sourceRanges: range(upperIn, durationFrames), status: 'approved' };
  const upper = drawing('upper', '#00ffff', { x: .4, y: .3, w: .2, h: .2 }, range(upperIn, durationFrames));
  const firstSnapshot = freeze(resolveLayerSnapshot(base, [bottom, image, upper]));
  const originalSnapshotJson = JSON.stringify(firstSnapshot);
  const change = (target, id, action, replacement = target) => ({ ...structuredClone(replacement), id, layerId: visualLayerId(target), layerChange: { action, targetLayerId: visualLayerId(target), targetOpId: target.id } });
  const moved = drawing('blue', '#0000ff', { x: .3, y: .08, w: .45, h: .5 });
  const revisedSnapshot = freeze(resolveLayerSnapshot(firstSnapshot, [change(bottom, 'bottom-blue', 'replace', moved), change(image, 'image-removed', 'remove')]));
  const branch = drawing('green', '#00ff00', { x: .08, y: .08, w: .42, h: .5 });
  const branchSnapshot = freeze(resolveLayerSnapshot(firstSnapshot, [change(bottom, 'bottom-green', 'replace', branch)]));
  assert.deepEqual(revisedSnapshot.map(op => op.id), ['keep-test-range', 'bottom-blue', 'upper'], 'Replacing the bottom drawing preserves its stack slot.');
  assert.equal(revisedSnapshot[1].layerId, 'bottom');
  assert.ok(!revisedSnapshot.some(op => op.layerChange), 'Effective snapshots contain no commands for future render replay.');
  assert.equal(JSON.stringify(firstSnapshot), originalSnapshotJson, 'Branch resolution never edits a parent snapshot.');

  const versions = {}, outputs = {}, stills = {};
  for (const [name, snapshot] of [['v1-original', base], ['v2-inserted', firstSnapshot], ['v3-revised', revisedSnapshot], ['v2-branch', branchSnapshot]]) {
    const outputPath = join(directory, `${name}.mp4`);
    const rendered = await renderVideo({ asset, sourcePath, ops: snapshot, outputPath, workingDirectory: join(directory, `${name}-job`), files: { yellow: { normalizedPath: imagePath } } });
    assert.equal(rendered.durationFrames, durationFrames);
    const info = await probe(outputPath);
    assert.equal(Number(info.streams.find(stream => stream.codec_type === 'video').nb_frames), durationFrames);
    outputs[name] = { outputPath, hash: await hash(outputPath) };
    versions[name] = { snapshot, diagnostics: rendered.diagnostics };
    for (const previous of Object.values(outputs)) assert.equal(await hash(previous.outputPath), previous.hash, 'Later render must not overwrite an older version file.');
  }
  const still = async (name, frame) => {
    const key = `${name}-${frame}`;
    if (!stills[key]) {
      const path = join(directory, `${key}.png`);
      await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', outputs[name].outputPath, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', path]);
      stills[key] = path;
    }
    return stills[key];
  };
  const pointRgb = async (name, frame, x, y) => [...await sharp(await still(name, frame)).extract({ left: Math.floor(x * asset.width), top: Math.floor(y * asset.height), width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  const checks = [];
  const color = async (name, x, y, expected, label, frame = sampleFrame) => {
    const rgb = await pointRgb(name, frame, x, y);
    assert.ok(rgb.every((value, index) => Math.abs(value - expected[index]) < 40), `${label}: ${rgb}`);
    checks.push({ label, name, frame, point: [x, y], rgb, expected });
  };
  const sameBackground = async (name, frame, x, y, label) => {
    const region = { left: Math.floor(x * asset.width) - 4, top: Math.floor(y * asset.height) - 4, width: 9, height: 9 };
    const pixels = async version => sharp(await still(version, frame)).extract(region).removeAlpha().raw().toBuffer();
    const [before, after] = await Promise.all([pixels('v1-original'), pixels(name)]);
    const mae = before.reduce((sum, value, index) => sum + Math.abs(value - after[index]), 0) / before.length;
    assert.ok(mae < 12, `${label}: background error ${mae}`);
    checks.push({ label, name, frame, point: [x, y], meanAbsoluteError: mae });
  };
  await color('v2-inserted', .15, .15, [255, 0, 0], 'Original bottom drawing');
  await color('v2-inserted', .26, .36, [255, 255, 0], 'Original inserted image');
  await color('v2-inserted', .45, .4, [0, 255, 255], 'Original top drawing');
  await sameBackground('v3-revised', sampleFrame, .15, .15, 'Old drawing position is restored to source');
  await sameBackground('v3-revised', sampleFrame, .26, .36, 'Removed image is restored to source');
  await color('v3-revised', .66, .15, [0, 0, 255], 'New drawing position and blue style');
  await color('v3-revised', .45, .4, [0, 255, 255], 'Replacement remains below the existing top drawing');
  await sameBackground('v3-revised', frameIn - 1, .66, .15, 'Replacement is absent before original in point');
  await color('v3-revised', .66, .15, [0, 0, 255], 'Replacement starts at original in point', frameIn);
  await color('v3-revised', .66, .15, [0, 0, 255], 'Replacement remains on last original included frame', frameOut - 1);
  await sameBackground('v3-revised', frameOut, .66, .15, 'Replacement disappears at original exclusive out point');
  await color('v2-branch', .15, .15, [0, 255, 0], 'Branch changes the older bottom drawing to green');
  await color('v2-branch', .26, .36, [255, 255, 0], 'Branch retains the old image removed only in the sibling');
  await color('v2-branch', .45, .4, [0, 255, 255], 'Branch preserves old top stack order');
  assert.equal(JSON.stringify(firstSnapshot), originalSnapshotJson);
  assert.equal(await hash(sourcePath), sourceHash, 'Original source remains byte-for-byte unchanged.');
  for (const path of checkedModules) assert.equal(await hash(new URL(`../${path}`, import.meta.url)), codeHashes[path], `Checked module changed during verification: ${path}`);
  const report = { checkedAt: new Date().toISOString(), sourcePath, sourceHash, sourcePreserved: true, previousVersionFilesPreserved: true, parentSnapshotsPreserved: true, codeHashes, asset, outputFrames: durationFrames, outputs, versions, checks, scope: 'Native FFmpeg layer replacement/removal, stable layer identity and stack slot, original half-open timing and branching on isolated local media. Does not verify UI interaction or external AI.' };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], 'Usage: node scripts/verify-layer-revisions.mjs SOURCE.mp4 [OUTPUT_DIRECTORY]');
  const report = await verifyLayerRevisions({ sourcePath: process.argv[2], directory: process.argv[3] || 'storage/qa/layer-revisions' });
  console.log(JSON.stringify({ outputFrames: report.outputFrames, checks: report.checks.length, sourcePreserved: report.sourcePreserved, previousVersionFilesPreserved: report.previousVersionFilesPreserved, outputs: report.outputs }, null, 2));
}
