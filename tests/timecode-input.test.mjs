import test from 'node:test';
import assert from 'node:assert/strict';
import { commitTimecodeInput, parseTimecodeInput } from '../packages/core/timecode-input.mjs';

test('time inputs accept seconds and minute/hour labels without confusing decimal seconds with frame suffixes', () => {
  for (const [text, expected] of [
    ['0', 0], ['  5.25\n', 158], ['.5', 15], ['0001.000', 30],
    ['1:2', 1860], ['01:02.5', 1875], ['100:00', 180000],
    ['1:2:3', 111690], ['100:2:3.125', 10803694],
  ]) assert.equal(parseTimecodeInput(text), expected, text);
});

test('rounding chooses the nearest frame, including half-frame, minute and EOF boundaries', () => {
  for (const [text, expected] of [
    ['0.016', 0], ['0.017', 1], ['0.033', 1], ['0.049', 1], ['0.050', 2],
    ['0.067', 2], ['59.999', 1800], ['0:59.999', 1800], ['1:59.999', 3600],
    ['00:35.00', 1050],
  ]) assert.equal(parseTimecodeInput(text), expected, text);
  assert.equal(parseTimecodeInput('0.125', 24), 3);
  assert.equal(parseTimecodeInput('1.5', 60), 90);
  assert.equal(parseTimecodeInput('10', 29.97), 300);
});

test('malformed drafts never silently become a zero frame or a different unit', () => {
  for (const text of [
    '', ' ', '\n\t', '-1', '+1', '-0', '1e3', 'NaN', 'Infinity',
    '1.', '.', '1.0001', '.0001', '1,5', '1 2', '1초',
    ':01', '01:', '1:.5', '1: 2', '1:60', '1:60.001', '1:2:60',
    '1:60:00', '1:2:3:4', '1.5:02', '1:2.5:03',
  ]) assert.equal(parseTimecodeInput(text), null, JSON.stringify(text));
  for (const text of [null, undefined, 5]) assert.equal(parseTimecodeInput(text), null);
  for (const fps of [0, -30, NaN, Infinity, -Infinity, '30']) assert.equal(parseTimecodeInput('1', fps), null);
});

test('safe-integer boundaries are checked after exact frame rounding', () => {
  assert.equal(parseTimecodeInput('9007199254740991', 1), Number.MAX_SAFE_INTEGER);
  assert.equal(parseTimecodeInput('9007199254740991.499', 1), Number.MAX_SAFE_INTEGER);
  assert.equal(parseTimecodeInput('9007199254740991.500', 1), null);
  assert.equal(parseTimecodeInput('300239975158033.033'), Number.MAX_SAFE_INTEGER);
  assert.equal(parseTimecodeInput('300239975158033.050'), null);
  assert.equal(parseTimecodeInput('9'.repeat(400)), null);
  assert.equal(parseTimecodeInput('9007199254740991000', 0.001), Number.MAX_SAFE_INTEGER);
});

test('commits preserve invalid drafts, bound IN before OUT and allow the exclusive end of media', () => {
  for (const text of ['', ' ', '-', '-1', '1:60', '1e2', '9'.repeat(400)]) {
    assert.equal(commitTimecodeInput(text, 150, 0, 269), 150, text);
  }
  assert.equal(commitTimecodeInput('10', 150, 0, 269), 269, 'IN cannot reach OUT');
  assert.equal(commitTimecodeInput('0', 270, 151, 1050), 151, 'OUT leaves at least one frame');
  assert.equal(commitTimecodeInput('35', 270, 151, 1050), 1050, 'OUT may equal EOF');
  assert.equal(commitTimecodeInput('999', 270, 151, 1050), 1050);
  assert.equal(commitTimecodeInput('0.033', 1, 1, 1), 1, 'single-frame media retains its end boundary');
  assert.equal(commitTimecodeInput('2', 150, 0, 269, 24), 48);
  for (const [min, max] of [[-1, 30], [10, 9], [0.5, 30], [0, Infinity]]) {
    assert.equal(commitTimecodeInput('1', 150, min, max), 150);
  }
});

test('the hundredth-second display roundtrips every 30 fps frame through an hour, including EOF', () => {
  // This is the public display convention used by apps/web/src/format.ts.
  const display = frame => {
    const seconds = frame / 30;
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
  };
  for (let frame = 0; frame <= 108000; frame++) {
    assert.equal(parseTimecodeInput(display(frame)), frame, `frame ${frame}`);
  }
  for (const frame of [179999, 180000, 180001, 647999, 648000, 648001, 10799999, 10800000]) {
    assert.equal(parseTimecodeInput(display(frame)), frame, `long-video frame ${frame}`);
  }
});
