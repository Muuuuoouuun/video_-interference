import test from 'node:test';
import assert from 'node:assert/strict';
import { createRangePlaybackController } from '../packages/core/range-playback.mjs';

const config = { versionId: 'first', durationFrames: 300, frameIn: 60, frameOut: 90, loop: false };
const media = (frame, extra = {}) => ({ currentTime: frame / 30, readyState: 4, paused: false, ended: false, seeking: false, ...extra });
function ready(overrides = {}) {
  const controller = createRangePlaybackController();
  controller.configure(config);
  controller.configure({ ...config, loop: true, ...overrides });
  return controller;
}

test('enabling a range is passive; play starts at IN only when outside its half-open range', () => {
  for (const frame of [0, 59, 90, 299]) {
    const controller = ready(); assert.equal(controller.playingRequested, false);
    assert.equal(controller.observeFrame(media(frame, { paused: true })), null);
    assert.deepEqual(controller.requestPlay(media(frame, { paused: true })), { seekFrame: 60, play: true });
  }
  for (const frame of [60, 75, 89]) assert.deepEqual(ready().requestPlay(media(frame, { paused: true })), { play: true });
});

test('OUT is excluded and asynchronous seeks are issued once, then can loop again', () => {
  const controller = ready(); controller.requestPlay(media(60));
  assert.equal(controller.observeFrame(media(89)), null);
  assert.deepEqual(controller.observeFrame(media(90)), { seekFrame: 60 });
  assert.equal(controller.observeFrame(media(93)), null, 'stale frame while seek is pending');
  controller.observeSeeked();
  assert.equal(controller.observeFrame(media(60)), null);
  assert.deepEqual(controller.observeFrame(media(90)), { seekFrame: 60 });
});

test('manual pause and paused frame selection cannot auto-resume even at OUT or EOF', () => {
  const controller = ready(); controller.requestPlay(media(60)); controller.requestPause();
  controller.observeSeeked();
  for (const frame of [0, 90, 300]) assert.equal(controller.observeFrame(media(frame, { paused: true, ended: frame === 300 })), null);
  assert.equal(controller.playingRequested, false);
});

test('full-video range survives the native pause-before-ended sequence and restarts at IN', () => {
  const controller = ready({ frameIn: 0, frameOut: 300 }); controller.requestPlay(media(299));
  const ended = media(300, { paused: true, ended: true });
  assert.equal(controller.observePause(ended), null); assert.equal(controller.playingRequested, true);
  assert.deepEqual(controller.observeFrame(ended), { seekFrame: 0, play: true });
  assert.equal(controller.observeFrame(ended), null);
});

test('a user pause wins over queued native end and over an in-flight loop seek', () => {
  const controller = ready({ frameOut: 300 }); controller.requestPlay(media(299));
  const ended = media(300, { paused: true, ended: true });
  controller.observePause(ended); controller.requestPause();
  assert.equal(controller.observeFrame(ended), null);
  controller.requestPlay(media(80)); controller.observeFrame(ended); controller.requestPause(); controller.observeSeeked();
  assert.equal(controller.observeFrame(media(60, { paused: true })), null);
});

test('an EOF timeupdate restart survives a stale queued pause event after play has begun', () => {
  const controller = ready({ frameOut: 300 }); controller.requestPlay(media(299));
  assert.deepEqual(controller.observeFrame(media(300, { paused: true, ended: true })), { seekFrame: 60, play: true });
  assert.equal(controller.observePause(media(60, { paused: false })), null);
  assert.equal(controller.playingRequested, true);
  controller.observeSeeked(); assert.equal(controller.observeFrame(media(60)), null);
  controller.requestPause(); assert.equal(controller.observeFrame(media(300, { ended: true, paused: true })), null);
});

test('changing the selected range relocates active playback but keeps a paused position untouched', () => {
  const controller = ready(); controller.requestPlay(media(75));
  const changed = { ...config, loop: true, frameIn: 150, frameOut: 180 };
  assert.equal(controller.configure(changed), null);
  assert.deepEqual(controller.observeFrame(media(75)), { seekFrame: 150 });
  controller.requestPause(); controller.configure({ ...changed, frameIn: 210, frameOut: 240 });
  assert.equal(controller.observeFrame(media(75, { paused: true })), null);
});

test('missing ranges, invalid ranges, version changes and editing locks cannot reuse a stale loop', () => {
  for (const overrides of [{ rangeAvailable: false }, { frameIn: 90, frameOut: 90 }, { frameIn: -1 }, { frameOut: 301 }]) {
    const controller = ready(overrides); controller.requestPlay(media(60));
    assert.equal(controller.loopEnabled, false); assert.equal(controller.observeFrame(media(90)), null);
  }
  const controller = ready(); controller.requestPlay(media(80));
  assert.deepEqual(controller.configure({ ...config, versionId: 'second', loop: true }), { pause: true });
  assert.equal(controller.loopEnabled, false); assert.equal(controller.playingRequested, false);
  controller.configure({ ...config, versionId: 'second', loop: true, locked: true });
  assert.deepEqual(controller.requestPlay(media(80)), { pause: true });
});

test('loading, media failure and unsolicited pause clear intent; stalled playback does not seek', () => {
  for (const state of [media(80, { readyState: 0 }), media(80, { readyState: 1 }), media(80, { error: true })]) assert.deepEqual(ready().requestPlay(state), { pause: true });
  const controller = ready(); controller.requestPlay(media(80));
  assert.equal(controller.observeFrame(media(90, { readyState: 1 })), null);
  assert.equal(controller.observeFrame(media(90, { seeking: true })), null);
  assert.deepEqual(controller.observePause(media(80, { paused: true })), { pause: true });
  assert.equal(controller.playingRequested, false);
  controller.requestPlay(media(80)); assert.deepEqual(controller.observeFrame(media(90, { error: true })), { pause: true });
});

test('ordinary playback ends once; replay starts at zero and CFR display stays inside the last frame', () => {
  const controller = ready({ loop: false }); controller.requestPlay(media(299));
  assert.deepEqual(controller.observeFrame(media(300, { ended: true, paused: true })), { pause: true });
  assert.deepEqual(controller.requestPlay(media(300, { ended: true, paused: true })), { seekFrame: 0, play: true });
  assert.equal(controller.frameAt(0), 0); assert.equal(controller.frameAt(1 / 30), 1); assert.equal(controller.frameAt(10), 299);
});
