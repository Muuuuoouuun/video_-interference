const FPS = 30;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Playback intent is separate from native paused/ended events, which can arrive in either batch. */
export function createRangePlaybackController() {
  let config = { versionId: '', durationFrames: 1, frameIn: 0, frameOut: 1, loop: false, locked: false };
  let requested = false, waitingForSeek = false;
  const pause = () => { requested = false; waitingForSeek = false; return { pause: true }; };
  const validMedia = media => !media.error && media.readyState >= 2 && Number.isFinite(media.currentTime) && media.currentTime >= 0;
  const seek = (frame, play = false) => { waitingForSeek = true; return { seekFrame: frame, ...(play ? { play: true } : {}) }; };

  return {
    get playingRequested() { return requested; },
    get loopEnabled() { return config.loop; },
    configure({ versionId, durationFrames, frameIn, frameOut, loop, rangeAvailable = true, locked = false }) {
      const changedVersion = config.versionId !== versionId;
      const duration = Number.isInteger(durationFrames) && durationFrames > 0 ? durationFrames : 1;
      const validRange = Number.isInteger(frameIn) && Number.isInteger(frameOut) && frameIn >= 0 && frameOut > frameIn && frameOut <= duration;
      config = { versionId, durationFrames: duration, frameIn: validRange ? frameIn : 0, frameOut: validRange ? frameOut : duration, loop: Boolean(loop && rangeAvailable && validRange && !changedVersion), locked: Boolean(locked) };
      return changedVersion || locked ? pause() : null;
    },
    requestPlay(media) {
      if (config.locked || !validMedia(media)) return pause();
      requested = true;
      const outside = media.currentTime < config.frameIn / FPS || media.currentTime >= config.frameOut / FPS;
      if (config.loop && (outside || media.ended)) return seek(config.frameIn, true);
      if (media.ended || media.currentTime >= config.durationFrames / FPS) return seek(0, true);
      return { play: true };
    },
    requestPause: pause,
    observePause(media) {
      // A queued EOF pause can arrive after the loop already called play().
      if (media.paused === false && !config.locked && !media.error) return null;
      // Native end-of-file pauses before firing ended. A user pause has already cleared intent.
      if (media.ended && requested && config.loop && !config.locked && validMedia(media)) return null;
      return pause();
    },
    observeFrame(media) {
      if (config.locked || media.error) return pause();
      if (!requested || !validMedia(media) || waitingForSeek || media.seeking) return null;
      if (config.loop && (media.ended || media.currentTime < config.frameIn / FPS || media.currentTime >= config.frameOut / FPS)) return seek(config.frameIn, Boolean(media.paused || media.ended));
      if (media.ended) return pause();
      return null;
    },
    observeSeeked() { waitingForSeek = false; },
    frameAt(seconds) { return clamp(Math.floor(seconds * FPS + 0.001), 0, config.durationFrames - 1); },
  };
}
