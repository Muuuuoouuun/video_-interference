import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { writeZip } from '../apps/worker/zip.mjs';

const exec = promisify(execFile);
const unzipAvailable = await access('/usr/bin/unzip').then(() => true, () => false);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vi-zip-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scenes/version-001'), { recursive: true }); await mkdir(join(root, 'attachments'));
  const files = {
    'feedback.md': Buffer.from('# 시간별 피드백\n\n'.repeat(400)),
    'manifest.json': Buffer.from(JSON.stringify({ feedback: Array.from({ length: 50 }, (_, index) => ({ index, text: '자막 위치 확인' })) })),
    'empty.vtt': Buffer.alloc(0),
    'scenes/version-001/frame-000001.jpg': await sharp({ create: { width: 64, height: 36, channels: 3, background: '#3366ff' } }).jpeg().toBuffer(),
    'attachments/asset-0001.m4a': Buffer.from(Array.from({ length: 70_000 }, (_, index) => (index * 7919) % 251)),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, name), bytes);
  return { root, files };
}

async function unpackAndCompare(t, root, archive, files) {
  const listed = (await exec('/usr/bin/unzip', ['-Z1', archive])).stdout.trim().split('\n');
  assert.deepEqual(listed, Object.keys(files), 'entries keep the requested order and relative paths');
  await exec('/usr/bin/unzip', ['-tq', archive]);
  const out = join(root, 'unpacked'); await exec('/usr/bin/unzip', ['-q', archive, '-d', out]);
  for (const [name, bytes] of Object.entries(files)) assert.deepEqual(await readFile(join(out, name)), bytes, name);
  const verbose = (await exec('/usr/bin/unzip', ['-v', archive])).stdout;
  assert.match(verbose, /Defl:N.*feedback\.md/, 'text is deflated'); assert.match(verbose, /Stored.*frame-000001\.jpg/, 'JPEG is stored');
}

test('built-in ZIP round-trips through the platform unzip with stored media and deflated text', { skip: !unzipAvailable && 'unzip is not installed' }, async t => {
  const { root, files } = await fixture(t), archive = join(root, 'feedback.zip');
  const result = await writeZip(root, archive, Object.keys(files));
  assert.equal(result.entries, 5); assert.equal(result.zip64, false);
  await unpackAndCompare(t, root, archive, files);
});

test('ZIP64 records stay readable when they are required', { skip: !unzipAvailable && 'unzip is not installed' }, async t => {
  const { root, files } = await fixture(t), archive = join(root, 'large.zip');
  const result = await writeZip(root, archive, Object.keys(files), { forceZip64: true });
  assert.equal(result.zip64, true);
  await unpackAndCompare(t, root, archive, files);
});

test('ZIP writing rejects unsafe names and leaves nothing behind on abort or failure', async t => {
  const { root, files } = await fixture(t), archive = join(root, 'out.zip');
  for (const names of [['../escape.md'], ['/abs.md'], ['a\\b.md'], ['feedback.md', 'feedback.md'], ['./feedback.md'], []]) {
    if (!names.length) continue;
    await assert.rejects(writeZip(root, archive, names), /ZIP 항목/);
  }
  await assert.rejects(writeZip(root, archive, ['feedback.md', 'missing.jpg']), /ENOENT/);
  const controller = new AbortController(); controller.abort(new Error('사용자 취소'));
  await assert.rejects(writeZip(root, archive, Object.keys(files), { signal: controller.signal }), /사용자 취소/);
  assert.deepEqual((await readdir(root)).filter(name => name.includes('.zip')), [], 'no archive or partial file remains');
});
