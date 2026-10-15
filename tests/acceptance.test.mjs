import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ffmpegPath, run, probe, renderVideo, mapToSource, mapToOutput } from '../apps/worker/engine.mjs';

test('60 second CFR acceptance: 12–18s at 2x yields 57s, with the original 24s picture and sound at 21s', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-interference-acceptance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.mkv'), outputPath = join(directory, 'result.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=60', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=60', '-vf', "drawbox=x=0:y=0:w=60:h=60:color=red:t=fill:enable='gte(t,24)*lt(t,25)'", '-af', "volume=0:enable='lt(t,24)+gte(t,25)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', sourcePath]);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const originalHash = hash(await readFile(sourcePath));
  const result = await renderVideo({ asset: { durationFrames: 1800, fps: 30, width: 320, height: 180, hasAudio: true }, sourcePath, ops: [{ id: 'speed-12-18', type: 'speed', params: { factor: 2 }, sourceRanges: [{ frameIn: 360, frameOut: 540 }], status: 'approved' }], outputPath, workingDirectory: join(directory, 'job') });
  const info = await probe(outputPath), video = info.streams.find(s => s.codec_type === 'video'), audio = info.streams.find(s => s.codec_type === 'audio');
  assert.equal(result.durationFrames, 1710); assert.equal(Number(video.nb_frames), 1710);
  assert.ok(Math.abs(Number(video.duration) - 57) < 1 / 30);
  assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 1 / 30);
  assert.deepEqual(mapToOutput(result.timelineMap, [{ frameIn: 720, frameOut: 750 }]), [{ frameIn: 630, frameOut: 660 }]);
  assert.deepEqual(mapToSource(result.timelineMap, 630, 660), [{ frameIn: 720, frameOut: 750 }]);
  for (const [frame, color] of [[627, 'blue'], [633, 'red']]) {
    const still = join(directory, `frame-${frame}.png`);
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', outputPath, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', still]);
    const pixels = await sharp(still).removeAlpha().raw().toBuffer(); const index = (20 * 320 + 20) * 3;
    const rgb = [...pixels.subarray(index, index + 3)];
    assert.ok(color === 'red' ? rgb[0] > 180 && rgb[2] < 30 : rgb[2] > 180 && rgb[0] < 30, `${color} marker at output frame ${frame}: ${rgb}`);
  }
  const pcmPath = join(directory, 'audio.pcm');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', outputPath, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', pcmPath]);
  const pcm = await readFile(pcmPath);
  const rms = (start, end) => { let sum = 0, count = 0; for (let sample = Math.round(start * 48000); sample < Math.round(end * 48000); sample++) { const value = pcm.readFloatLE(sample * 4); sum += value * value; count++; } return Math.sqrt(sum / count); };
  assert.ok(rms(20.7, 20.9) < 0.001); assert.ok(rms(21.1, 21.5) > 0.05); assert.ok(rms(22.1, 22.4) < 0.001);
  let onset;
  for (let sample = 20 * 48000; sample < 22 * 48000; sample++) if (Math.abs(pcm.readFloatLE(sample * 4)) > 0.02) { onset = sample / 48000; break; }
  assert.ok(Math.abs(onset - 21) < 0.04, `sound onset ${onset} must align with the video marker at 21s`);
  assert.equal(hash(await readFile(sourcePath)), originalHash);
});

test('canceling an active native FFmpeg process waits for termination and rejects with AbortError', { timeout: 10_000 }, async () => {
  const control = new AbortController(), started = performance.now();
  await assert.rejects(run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=30', '-f', 'null', '-', '-progress', 'pipe:1', '-stats_period', '0.1', '-nostats'], { signal: control.signal, durationSeconds: 30, onProgress: () => control.abort() }), error => error.name === 'AbortError');
  assert.ok(performance.now() - started < 4000, 'cancellation must stop the 30s realtime process promptly');
});

test('an already canceled native task does not launch a process', async () => {
  const control = new AbortController(); control.abort();
  await assert.rejects(run('/nonexistent/binary', [], { signal: control.signal }), error => error.name === 'AbortError');
});
