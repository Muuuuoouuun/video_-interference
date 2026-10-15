import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireMicrophone, stopMicrophone } from '../packages/core/microphone-session.mjs';

const fakeStream = () => {
  let stopped = 0;
  return { stream: { getTracks: () => [{ stop: () => stopped++ }, { stop: () => stopped++ }] }, count: () => stopped };
};
test('a microphone permission response after closing the draft immediately stops all tracks', async () => {
  const control = new AbortController(), media = fakeStream();
  let resolveMedia;
  const pending = acquireMicrophone(() => new Promise(resolve => { resolveMedia = resolve; }), control.signal);
  control.abort(); resolveMedia(media.stream);
  assert.equal(await pending, null);
  assert.equal(media.count(), 2);
});
test('active recording receives its stream; stopping releases every track', async () => {
  const control = new AbortController(), media = fakeStream();
  assert.equal(await acquireMicrophone(async constraints => { assert.deepEqual(constraints, { audio: true }); return media.stream; }, control.signal), media.stream);
  assert.equal(media.count(), 0);
  stopMicrophone(media.stream);
  assert.equal(media.count(), 2);
});
test('a canceled recording does not open a microphone permission request', async () => {
  const control = new AbortController(); control.abort();
  let requested = false;
  assert.equal(await acquireMicrophone(async () => { requested = true; }, control.signal), null);
  assert.equal(requested, false);
});
