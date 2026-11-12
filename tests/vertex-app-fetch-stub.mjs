import { appendFile } from 'node:fs/promises';
import { GoogleAuth } from 'google-auth-library';
import sharp from 'sharp';

GoogleAuth.prototype.getClient = async () => ({ getRequestHeaders: async () => new Headers({ authorization: 'Bearer offline-test-token' }) });
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (!/^https:\/\/(?:aiplatform\.googleapis\.com|us-central1-aiplatform\.googleapis\.com)\/v1\/projects\/sample-project-123\//.test(url)) throw new Error('offline test blocks external network');
  const kind = url.includes(':predictLongRunning') ? 'video-submit' : url.includes(':fetchPredictOperation') ? 'video-check' : url.includes('tts:generateContent') ? 'audio' : 'image';
  await appendFile(process.env.VI_TEST_VERTEX_CALLS, `${kind}\n`);
  if (kind === 'video-submit') return new Response(JSON.stringify({ name: 'projects/sample-project-123/locations/us-central1/operations/offline-job' }));
  if (kind === 'video-check') return new Response(JSON.stringify({ done: false }));
  if (kind === 'audio') {
    const b = Buffer.alloc(44 + 480); b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(480, 40);
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: b.toString('base64') } }] } }] }));
  }
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toBuffer();
  return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: image.toString('base64') } }] } }] }));
};
