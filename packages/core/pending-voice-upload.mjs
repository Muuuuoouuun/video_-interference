/** Keeps one recording and its original anchor until upload succeeds or it is discarded. */
export function createPendingVoiceUpload({ upload, onChange, onSaved }) {
  let pending = null;
  let activeAttempt = null;
  const publish = () => onChange(pending);
  return {
    get pending() { return pending; },
    stage(blob, name, anchor) {
      if (pending || activeAttempt) return false;
      pending = { blob, name, anchor: structuredClone(anchor), status: 'pending' };
      publish();
      return true;
    },
    async retry() {
      if (!pending || activeAttempt) return false;
      const recording = pending;
      const attempt = {};
      activeAttempt = attempt;
      pending = { ...recording, status: 'uploading', error: undefined };
      publish();
      let attachment;
      try { attachment = await upload(recording); }
      catch (error) {
        if (activeAttempt !== attempt) return false;
        activeAttempt = null;
        pending = { ...recording, status: 'failed', error: error instanceof Error ? error.message : '음성 파일을 저장하지 못했습니다.' };
        publish();
        return false;
      }
      if (activeAttempt !== attempt) return false;
      activeAttempt = null;
      pending = null;
      onSaved(attachment, recording.anchor);
      publish();
      return true;
    },
    discard() {
      if (!pending || activeAttempt) return false;
      pending = null;
      publish();
      return true;
    },
    // Ignore late responses after unmount, including React's effect cleanup/restart.
    release() { activeAttempt = null; pending = null; },
  };
}
