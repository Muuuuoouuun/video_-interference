import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveMediaBinary } from '../apps/worker/engine.mjs';

test('media binaries prefer an explicit path, then known installs, then PATH, then the bare name', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vi-media-binary-')); t.after(() => rm(root, { recursive: true, force: true }));
  const brew = join(root, 'brew'), first = join(root, 'first'), second = join(root, 'second');
  for (const folder of [brew, first, second]) await mkdir(folder);
  const executable = async path => { await writeFile(path, '#!/bin/sh\n'); await chmod(path, 0o755); };
  await executable(join(second, 'ffmpeg')); await writeFile(join(first, 'ffmpeg'), 'not executable');
  const searchPath = [first, second].join(delimiter);
  assert.equal(resolveMediaBinary('ffmpeg', '/custom/ffmpeg', { searchPath, candidates: [] }), '/custom/ffmpeg', 'FFMPEG_PATH is never second-guessed');
  assert.equal(resolveMediaBinary('ffmpeg', undefined, { searchPath, candidates: [join(brew, 'ffmpeg')] }), join(second, 'ffmpeg'), 'a missing Homebrew binary and a non-executable PATH entry are skipped');
  await executable(join(brew, 'ffmpeg'));
  assert.equal(resolveMediaBinary('ffmpeg', undefined, { searchPath, candidates: [join(brew, 'ffmpeg')] }), join(brew, 'ffmpeg'));
  assert.equal(resolveMediaBinary('ffprobe', undefined, { searchPath, candidates: [] }), 'ffprobe', 'spawn still gets a usable command when nothing is found');
});
