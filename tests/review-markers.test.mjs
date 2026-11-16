import test from 'node:test';
import assert from 'node:assert/strict';
import { adjacentMarkerFrame, markerAt, markerLoopRange } from '../packages/core/review-markers.mjs';
import { splitAttachmentFiles } from '../packages/core/comment-attachments.mjs';

const markers = [90, 30, 60, 60].map((frame, index) => ({ id: `m${index}`, frame }));

test('review markers navigate by frame and loop to the next marker or the end', () => {
  assert.equal(markerAt(markers, 60).id, 'm2');
  assert.equal(markerAt(markers, 61), undefined);
  assert.equal(adjacentMarkerFrame(markers, 60, 1), 90, 'next skips the marker under the playhead');
  assert.equal(adjacentMarkerFrame(markers, 60, -1), 30);
  assert.equal(adjacentMarkerFrame(markers, 90, 1), null);
  assert.equal(adjacentMarkerFrame(markers, 30, -1), null);
  assert.deepEqual(markerLoopRange(markers, 30, 120), { in: 30, out: 60 });
  assert.deepEqual(markerLoopRange(markers, 75, 120), { in: 60, out: 90 }, 'between markers loops the span containing the playhead');
  assert.deepEqual(markerLoopRange(markers, 100, 120), { in: 90, out: 120 }, 'last marker loops to the end');
  assert.equal(markerLoopRange(markers, 10, 120), null, 'no marker at or before the playhead');
  assert.equal(markerLoopRange([{ frame: 119 }], 119, 120), null, 'a one-frame span is not a loop');
});

test('attachment files split into images, one voice file and rejected files', () => {
  const file = (name, type) => ({ name, type });
  const { images, voice, extraVoice, rejected } = splitAttachmentFiles([
    file('a.png', 'image/png'), file('memo.m4a', ''), file('b.mp3', 'audio/mpeg'), file('clip.mp4', 'video/mp4'), file('c.gif', 'image/gif'),
  ]);
  assert.deepEqual(images.map(item => item.name), ['a.png']);
  assert.equal(voice.name, 'memo.m4a', 'untyped audio is recognized by extension');
  assert.deepEqual(extraVoice.map(item => item.name), ['b.mp3']);
  assert.deepEqual(rejected.map(item => item.name), ['clip.mp4', 'c.gif']);
});
