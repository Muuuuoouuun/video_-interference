import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('native process shutdown stops work without a job signal and waits for FFmpeg to close', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-interference-native-shutdown-'));
  const script = `
    const { run, ffmpegPath, ffprobePath, shutdownMediaProcesses } = await import(process.env.VI_ENGINE_URL);
    const pending = run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30:d=60', '-c:v', 'libx264', process.env.VI_TEST_OUTPUT]);
    pending.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 150));
    const begin = Date.now(); await shutdownMediaProcesses();
    let stopped = false; try { await pending; } catch (error) { stopped = error.name === 'AbortError'; }
    let blocked = false; try { await run(ffprobePath, ['-version']); } catch (error) { blocked = error.name === 'AbortError'; }
    if (!stopped || !blocked) process.exit(1);
    process.stdout.write(JSON.stringify({ stopped, blocked, closeMs: Date.now() - begin }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, VI_ENGINE_URL: new URL('../apps/worker/engine.mjs', import.meta.url).href, VI_TEST_OUTPUT: join(directory, 'incomplete.mp4') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout); assert.equal(result.stopped, true); assert.equal(result.blocked, true); assert.ok(result.closeMs < 2000, 'native process close should fit the bounded worker shutdown');
});
