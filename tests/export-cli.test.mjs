import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ffmpegPath, run } from '../apps/worker/engine.mjs';
import { openStore } from '../apps/worker/store.mjs';
import { entryDigest } from '../apps/worker/handoff.mjs';
import { validateHandoffManifest } from '../scripts/handoff-schema.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');

function cli(args, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/export-feedback.mjs', ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timed out')); }, 60_000);
    child.once('exit', code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}

test('the export CLI reads the app store read-only and prints AI-first text, with model observations kept separate', { timeout: 120_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'video-interference-export-cli-')); t.after(() => rm(storage, { recursive: true, force: true }));
  const video = join(storage, 'canonical.mp4'), reference = join(storage, 'reference.png');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  await sharp({ create: { width: 24, height: 24, channels: 3, background: '#00FF00' } }).png().toFile(reference);
  const version = { id: 'version_one', assetId: 'asset_one', number: 1, parentVersionId: null, durationFrames: 90, mediaUrl: '/media/original', thumbnailUrl: '/media/thumb', opIds: [], timelineMap: [{ sourceIn: 0, sourceOut: 90, outputIn: 0, outputOut: 90, speed: 1, volume: 1 }], status: 'ready', label: '원본', createdAt: '2026-10-15T00:00:00Z' };
  const comment = (id, frameIn, frameOut, text, extra = {}) => ({ id, versionId: version.id, frameIn, frameOut, contextFrame: frameIn, kind: 'request', text, drawings: [], attachmentIds: [], sourceRanges: [{ frameIn, frameOut }], status: 'received', createdAt: `2026-10-15T00:0${frameIn % 10}:00Z`, ...extra });
  const store = openStore(storage);
  store.data.state = { project: { id: 'project_cli', name: 'CLI 검증', activeVersionId: version.id, createdAt: '2026-10-15T00:00:00Z' }, asset: { id: 'asset_one', name: 'cli.mp4', durationFrames: 90, fps: 30, width: 320, height: 180, hasAudio: false }, versions: [version], ops: [], jobs: [], attachments: [{ id: 'reference_one', name: '참고.png', role: 'reference', mimeType: 'image/png', mediaUrl: '/media/reference_one', createdAt: '2026-10-15T00:00:00Z' }],
    comments: [comment('first', 15, 45, '빨간 부분 제목을 크게', { sceneDescription: '빨간 화면', drawings: [{ id: 'arrow', kind: 'arrow', color: '#FFFF00', frame: 20, points: [{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.5 }] }], attachmentIds: ['reference_one'] }), comment('second', 60, 61, '여기서 끝내 주세요'), comment('gone', 70, 75, '삭제한 피드백', { deletedAt: '2026-10-15T01:00:00Z' })] };
  store.data.files = { original: { path: video, mimeType: 'video/mp4', name: 'cli.mp4' }, reference_one: { path: reference, normalizedPath: reference, mimeType: 'image/png', name: '참고.png' } };
  store.data.snapshots = { [version.id]: [] }; store.save(); store.close();
  const database = join(storage, 'project.sqlite'), before = await hash(database);
  const env = { VI_STORAGE_ROOT: storage };

  const jsonl = await cli(['--format', 'jsonl'], env); assert.equal(jsonl.code, 0, jsonl.stderr);
  const lines = jsonl.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].type, 'handoff'); assert.deepEqual(lines.slice(1).map(line => line.id), ['first', 'second'], 'deleted feedback is not exported');
  assert.deepEqual(lines[0].overview.shots.map(shot => shot.frames), [[0, 30], [30, 90]], 'the overview finds the red→blue cut');
  assert.match(lines[1].drawings[0].where, /^노란 화살표/); assert.equal(lines[1].scene.text, '빨간 화면');
  const paths = JSON.parse((await cli(['--format', 'paths', '--storage', storage])).stdout);
  const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')); await validateHandoffManifest(manifest);
  assert.equal((await readFile(paths.jsonl, 'utf8')), jsonl.stdout, 'the same content reuses the cached export');
  assert.equal(await hash(database), before, 'the CLI never writes to the app database');

  const first = manifest.feedback.find(entry => entry.id === 'first'), second = manifest.feedback.find(entry => entry.id === 'second');
  const observations = join(storage, 'observations.json');
  await writeFile(observations, JSON.stringify({ kind: 'video-feedback-observations', schemaVersion: 1, provider: 'gemini', model: 'gemini-test', createdAt: '2026-10-15T02:00:00Z', items: [
    { id: 'first', entryDigest: entryDigest(first), observedScene: '빨간 단색 화면이 보입니다.', feedbackSummary: '제목을 크게 해 달라는 요청입니다.', questions: ['어느 제목인지 확인이 필요합니다.'], evidenceFrames: [15] },
    { id: 'second', entryDigest: 'outdated-digest', observedScene: '파란 화면입니다.', feedbackSummary: '여기서 끝내 달라는 요청입니다.', questions: [], evidenceFrames: [60] },
    { id: 'unknown', entryDigest: 'x', observedScene: '없음', feedbackSummary: '없음', questions: [], evidenceFrames: [] }] }));
  const observed = await cli(['--format', 'json', '--observations', observations, '--out', join(storage, 'handoff')], env); assert.equal(observed.code, 0, observed.stderr);
  const observedManifest = JSON.parse(observed.stdout); await validateHandoffManifest(observedManifest);
  assert.equal(observedManifest.modelCalled, false, 'attaching saved observations is not a model call'); assert.equal(observedManifest.modelObservationsIncluded, true);
  assert.deepEqual(observedManifest.feedback.map(entry => entry.observations.map(item => item.stale)), [[false], [true]]);
  assert.equal(observedManifest.stats.unmatchedObservationCount, 1);
  assert.equal(observedManifest.feedback[0].sceneDescription.text, '빨간 화면', 'model text never replaces the user scene description');
  const markdown = await readFile(join(storage, 'handoff', 'feedback.md'), 'utf8');
  assert.match(markdown, /### AI 관찰 · gemini gemini-test \(모델 결과, 사용자 기록 아님\)/); assert.match(markdown, /이후 피드백이 바뀌어 이전 자료 기준/);
  const observedLines = (await readFile(join(storage, 'handoff', 'feedback.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(observedLines[1].observations[0].source, 'model'); assert.equal(observedLines[1].observations[0].observedScene, '빨간 단색 화면이 보입니다.');
  assert.equal(await hash(database), before);

  const missing = await cli(['--version', '9'], env); assert.equal(missing.code, 1); assert.match(missing.stderr, /v9 버전을 찾지 못했습니다/);
  const bad = await cli(['--format', 'pdf'], env); assert.equal(bad.code, 1); assert.match(bad.stderr, /형식은/);
  const empty = await cli([], { VI_STORAGE_ROOT: join(storage, 'nothing') }); assert.equal(empty.code, 1); assert.match(empty.stderr, /프로젝트를 찾지 못했습니다/);
});
