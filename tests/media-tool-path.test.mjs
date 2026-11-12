import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, chmod, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const engineUrl = new URL('../apps/worker/engine.mjs', import.meta.url).href;

test('media tools resolve from PATH and explicit overrides take precedence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vi-media-path-'));
  try {
    for (const [name, result] of [['ffmpeg', 'path-video'], ['ffprobe', 'path-probe'], ['custom-video', 'custom-video'], ['custom-probe', 'custom-probe']]) {
      const path = join(directory, name);
      await writeFile(path, `#!/bin/sh\nprintf '${result}'\n`);
      await chmod(path, 0o755);
    }
    const script = `const {ffmpegPath, ffprobePath, run} = await import(${JSON.stringify(engineUrl)}); console.log(JSON.stringify([await run(ffmpegPath, []), await run(ffprobePath, [])]));`;
    const env = { ...process.env, PATH: directory, FFMPEG_PATH: '', FFPROBE_PATH: '' };
    const first = await exec(process.execPath, ['--input-type=module', '-e', script], { env });
    assert.deepEqual(JSON.parse(first.stdout), ['path-video', 'path-probe']);
    const overridden = await exec(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...env, FFMPEG_PATH: join(directory, 'custom-video'), FFPROBE_PATH: join(directory, 'custom-probe') },
    });
    assert.deepEqual(JSON.parse(overridden.stdout), ['custom-video', 'custom-probe']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
