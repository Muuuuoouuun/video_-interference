import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { run, ffmpegPath, probe, ingest, renderVideo } from '../apps/worker/engine.mjs';

const work = await mkdtemp(join(tmpdir(), 'video-interference-av-sync-'));
const rate = 48000;
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const op = (type, frameIn, frameOut, params = {}) => ({ id: `${type}-${frameIn}`, type, sourceRanges: [{ frameIn, frameOut }], params });

async function makeSource(name, videoStart, audioStart) {
  const source = join(work, `${name}.mov`);
  const audioLength = audioStart < videoStart ? 3.3 : 3;
  const firstTone = audioStart < videoStart ? 0.6 : 0;
  const audio = `aevalsrc=if(between(t\\,${firstTone}\\,${firstTone + 0.2})+between(t\\,${firstTone + 1}\\,${firstTone + 1.2})\\,0.5*sin(2*PI*600*t)\\,0):s=${rate}:d=${audioLength}`;
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=3', '-f', 'lavfi', '-i', audio, '-filter_complex', `[0:v]setpts=PTS+${videoStart}/TB[v];[1:a]asetpts=PTS+${audioStart}/TB[a]`, '-map', '[v]', '-map', '[a]', '-fps_mode', 'passthrough', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-video_track_timescale', '90000', source]);
  return source;
}

async function pcm(path, name) {
  const output = join(work, `${name}.pcm`);
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', String(rate), '-f', 's16le', output]);
  return readFile(output);
}

function rms(buffer, start, end) {
  let squares = 0, count = 0;
  for (let offset = Math.round(start * rate) * 2; offset < Math.min(buffer.length, Math.round(end * rate) * 2); offset += 2) { squares += buffer.readInt16LE(offset) ** 2; count++; }
  return Math.sqrt(squares / count);
}

function firstTone(buffer) {
  for (let sample = 0; sample < buffer.length / 2 - 480; sample += 48) if (rms(buffer, sample / rate, (sample + 480) / rate) > 2000) return sample / rate;
  return null;
}

async function assertDuration(path, expectedFrames) {
  const info = await probe(path), video = info.streams.find(s => s.codec_type === 'video'), audio = info.streams.find(s => s.codec_type === 'audio');
  assert.equal(video.r_frame_rate, '30/1'); assert.equal(Number(video.nb_frames), expectedFrames);
  assert.ok(Math.abs(Number(video.duration) - expectedFrames / 30) < 0.002);
  assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 1 / 30, `audio/video duration differ: ${audio.duration} vs ${video.duration}`);
  return info;
}

for (const scenario of [{ name: 'audio-delayed', videoStart: 0, audioStart: 0.3 }, { name: 'audio-earlier', videoStart: 0.3, audioStart: 0 }, { name: 'common-nonzero-start', videoStart: 1.2, audioStart: 1.5 }]) {
  await test(`${scenario.name}: proxy, original render and cut/speed preserve source audio content alignment`, async () => {
    const source = await makeSource(scenario.name, scenario.videoStart, scenario.audioStart), originalHash = await hash(source);
    const sourceInfo = await probe(source), sourceVideo = sourceInfo.streams.find(s => s.codec_type === 'video'), sourceAudio = sourceInfo.streams.find(s => s.codec_type === 'audio');
    assert.ok(Math.abs(Number(sourceAudio.start_time) - Number(sourceVideo.start_time) - (scenario.audioStart - scenario.videoStart)) < 0.002, 'fixture must contain the intended stream offset');
    const proxy = join(work, `${scenario.name}-proxy.mp4`), thumb = join(work, `${scenario.name}-thumb.jpg`);
    const asset = await ingest(source, proxy, thumb);
    assert.ok(Math.abs(asset.audioOffsetSeconds - (scenario.audioStart - scenario.videoStart)) < 0.002);
    assert.equal(asset.durationFrames, 90); await assertDuration(proxy, 90);
    const proxyPcm = await pcm(proxy, `${scenario.name}-proxy`);
    assert.ok(Math.abs(firstTone(proxyPcm) - 0.3) < 0.025, `proxy content onset should be 0.3 s, got ${firstTone(proxyPcm)}`);
    assert.ok(rms(proxyPcm, 0.05, 0.2) < 30); assert.ok(rms(proxyPcm, 0.34, 0.46) > 3000); assert.ok(rms(proxyPcm, 1.34, 1.46) > 3000);
    const unchanged = join(work, `${scenario.name}-render.mp4`);
    await renderVideo({ asset, sourcePath: source, ops: [], outputPath: unchanged, workingDirectory: join(work, `${scenario.name}-render`) });
    await assertDuration(unchanged, 90);
    const outputPcm = await pcm(unchanged, `${scenario.name}-render`);
    assert.ok(Math.abs(firstTone(outputPcm) - firstTone(proxyPcm)) < 0.012, `preview onset ${firstTone(proxyPcm)} and render onset ${firstTone(outputPcm)} must agree`);
    const edited = join(work, `${scenario.name}-edited.mp4`);
    const result = await renderVideo({ asset, sourcePath: source, ops: [op('cut', 0, 6), op('speed', 6, 36, { factor: 2 })], outputPath: edited, workingDirectory: join(work, `${scenario.name}-edited`) });
    assert.equal(result.durationFrames, 69); await assertDuration(edited, 69);
    const editedPcm = await pcm(edited, `${scenario.name}-edited`);
    assert.ok(Math.abs(firstTone(editedPcm) - 0.05) < 0.035, `cut/speed must move audio with source scene, got ${firstTone(editedPcm)}`);
    assert.ok(rms(editedPcm, 0.63, 0.76) > 3000, 'the second source marker follows the cut/speed map');
    assert.equal(await hash(source), originalHash, 'all transforms preserve original source bytes');
  });
}

await test('legacy asset metadata probes the original offset and zero-audio sources retain exact silence', async () => {
  const source = join(work, 'audio-delayed.mov'), asset = await ingest(source, join(work, 'legacy-proxy.mp4'), join(work, 'legacy-thumb.jpg'));
  delete asset.audioOffsetSeconds;
  const output = join(work, 'legacy-render.mp4');
  await renderVideo({ asset, sourcePath: source, ops: [], outputPath: output, workingDirectory: join(work, 'legacy-render') });
  const legacyOnset = firstTone(await pcm(output, 'legacy-render')); assert.ok(Math.abs(legacyOnset - 0.3) < 0.025, `legacy onset should be 0.3, got ${legacyOnset}`);
  const silent = join(work, 'silent.mov'); await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', source, '-map', '0:v:0', '-an', '-c:v', 'copy', silent]);
  const silentAsset = await ingest(silent, join(work, 'silent-proxy.mp4'), join(work, 'silent-thumb.jpg')); assert.equal(silentAsset.audioOffsetSeconds, 0);
  const silentOutput = join(work, 'silent-render.mp4'); await renderVideo({ asset: silentAsset, sourcePath: silent, ops: [], outputPath: silentOutput, workingDirectory: join(work, 'silent-render') });
  assert.ok(rms(await pcm(silentOutput, 'silent-render'), 0, 2.8) < 1, 'float normalization must continue to prevent silent DC offset');
});

await rm(work, { recursive: true, force: true });
