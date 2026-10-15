import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingVoiceUpload } from '../packages/core/pending-voice-upload.mjs';

const anchor = () => ({ in: 60, out: 90, contextFrame: 75, drawings: [{ id: 'mark', frame: 75, points: [{ x: 0.2, y: 0.3 }] }] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('failed recording retries the exact bytes/name and original frame, range and drawings', async () => {
  const blob = new Blob(['irreplaceable recording'], { type: 'audio/webm' });
  const original = anchor(), captured = structuredClone(original), calls = [], states = [];
  let saved = null;
  const session = createPendingVoiceUpload({
    upload: async recording => { calls.push(recording); if (calls.length === 1) throw new Error('Worker disconnected'); return { id: 'voice-new' }; },
    onChange: pending => states.push(pending?.status ?? 'empty'),
    onSaved: (attachment, anchor) => { saved = { attachment, anchor }; },
  });
  assert.equal(session.stage(blob, 'recording-original.webm', original), true);
  original.in = 100; original.out = 200; original.contextFrame = 150; original.drawings[0].points[0].x = 0.9;
  assert.equal(await session.retry(), false);
  assert.equal(saved, null);
  assert.equal(session.pending.status, 'failed');
  assert.equal(session.pending.error, 'Worker disconnected');
  assert.equal(session.pending.blob, blob);
  assert.deepEqual(session.pending.anchor, captured);
  assert.equal(await session.retry(), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.blob === blob && call.name === 'recording-original.webm'));
  assert.equal(await calls[1].blob.text(), 'irreplaceable recording');
  assert.deepEqual(saved, { attachment: { id: 'voice-new' }, anchor: captured });
  assert.equal(session.pending, null);
  assert.deepEqual(states, ['pending', 'uploading', 'failed', 'uploading', 'empty']);
});

test('a failed replacement preserves the prior attached voice and anchor through discard or successful retry', async () => {
  const old = { attachment: { id: 'voice-old' }, anchor: { in: 1, out: 2, contextFrame: 1, drawings: [] } };
  let attached = old, fail = true;
  const session = createPendingVoiceUpload({
    upload: async () => { if (fail) throw new Error('Upload failed'); return { id: 'voice-new' }; },
    onChange() {}, onSaved: (attachment, anchor) => { attached = { attachment, anchor }; },
  });
  const blob = new Blob(['new']);
  session.stage(blob, 'new.webm', anchor());
  await session.retry();
  assert.equal(attached, old);
  assert.equal(session.stage(new Blob(['replacement']), 'overwrite.webm', { in: 0 }), false);
  assert.equal(session.pending.blob, blob);
  assert.equal(session.discard(), true);
  assert.equal(attached, old);
  assert.equal(session.pending, null);
  session.stage(blob, 'new.webm', anchor());
  await session.retry(); fail = false;
  assert.equal(attached, old);
  await session.retry();
  assert.deepEqual(attached, { attachment: { id: 'voice-new' }, anchor: anchor() });
});

test('double retry and discard during an upload cannot duplicate or lose the recording', async () => {
  const response = deferred(); let requests = 0, saved = 0;
  const session = createPendingVoiceUpload({ upload: () => { requests++; return response.promise; }, onChange() {}, onSaved() { saved++; } });
  const blob = new Blob(['audio']); session.stage(blob, 'voice.webm', anchor());
  const first = session.retry();
  assert.equal(session.pending.status, 'uploading');
  assert.equal(await session.retry(), false);
  assert.equal(session.discard(), false);
  assert.equal(session.stage(new Blob(['other']), 'other.webm', anchor()), false);
  assert.equal(requests, 1);
  assert.equal(session.pending.blob, blob);
  response.resolve({ id: 'voice' });
  assert.equal(await first, true);
  assert.equal(saved, 1);
  assert.equal(session.pending, null);
});

test('unmount ignores a late successful or failed upload and cannot overwrite a later session', async () => {
  for (const lateOutcome of ['success', 'failure']) {
    const late = deferred(), current = deferred(); let calls = 0; const saved = [], states = [];
    const session = createPendingVoiceUpload({
      upload: () => ++calls === 1 ? late.promise : current.promise,
      onChange: pending => states.push(pending?.name ?? 'empty'), onSaved: attachment => saved.push(attachment.id),
    });
    session.stage(new Blob(['old']), 'old.webm', anchor());
    const first = session.retry();
    session.release();
    session.stage(new Blob(['current']), 'current.webm', anchor());
    const second = session.retry();
    const stateCount = states.length;
    if (lateOutcome === 'success') late.resolve({ id: 'voice-stale' }); else late.reject(new Error('Late failure'));
    assert.equal(await first, false);
    assert.equal(states.length, stateCount);
    assert.equal(session.pending.name, 'current.webm');
    assert.equal(session.pending.status, 'uploading');
    assert.deepEqual(saved, []);
    current.resolve({ id: 'voice-current' });
    assert.equal(await second, true);
    assert.deepEqual(saved, ['voice-current']);
    assert.equal(session.pending, null);
  }
});
