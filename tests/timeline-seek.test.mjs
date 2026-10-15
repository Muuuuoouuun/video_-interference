import test from 'node:test';
import assert from 'node:assert/strict';
import { seekFrameAtPointer, timelineSeekKey } from '../packages/core/timeline-seek.mjs';

test('pointer seeking uses the timeline offset and clamps outside both edges to playable frames', () => {
  assert.equal(seekFrameAtPointer(100, 100, 600, 900), 0);
  assert.equal(seekFrameAtPointer(250, 100, 600, 900), 225);
  assert.equal(seekFrameAtPointer(400, 100, 600, 900), 450);
  assert.equal(seekFrameAtPointer(700, 100, 600, 900), 899);
  assert.equal(seekFrameAtPointer(-500, 100, 600, 900), 0);
  assert.equal(seekFrameAtPointer(1500, 100, 600, 900), 899);
});

test('fractional geometry preserves nearest-frame rounding and the same coordinate on relocated timelines', () => {
  assert.equal(seekFrameAtPointer(153.625, 73.25, 321.5, 600), 150);
  assert.equal(seekFrameAtPointer(234, 73.25, 321.5, 600), 300);
  assert.equal(seekFrameAtPointer(46.49, 45.5, 600, 300), 0);
  assert.equal(seekFrameAtPointer(46.5, 45.5, 600, 300), 1);
  assert.equal(seekFrameAtPointer(48.49, 45.5, 600, 300), 1);
  assert.equal(seekFrameAtPointer(48.5, 45.5, 600, 300), 2);
  for (const left of [-200, 0, 73.25, 1200]) {
    assert.equal(seekFrameAtPointer(left + 80.375, left, 321.5, 600), 150);
  }
});

test('long clips and one-frame clips never seek to the exclusive EOF boundary', () => {
  const duration = 1_080_000; // Ten hours at 30 fps.
  assert.equal(seekFrameAtPointer(720, 240, 960, duration), 540_000);
  assert.equal(seekFrameAtPointer(1199, 240, 960, duration), 1_078_875);
  assert.equal(seekFrameAtPointer(1200, 240, 960, duration), duration - 1);
  for (const x of [-100, 0, 25, 50, 100, 10000]) assert.equal(seekFrameAtPointer(x, 0, 100, 1), 0);
  assert.equal(seekFrameAtPointer(1, 0, 1, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER - 1);
  assert.equal(seekFrameAtPointer(Number.MAX_VALUE, -Number.MAX_VALUE, 1, duration), duration - 1);
  assert.equal(seekFrameAtPointer(-Number.MAX_VALUE, Number.MAX_VALUE, 1, duration), 0);
});

test('pointer seeking refuses invalid measurements and non-canonical durations', () => {
  for (const value of [NaN, Infinity, -Infinity, null, '10']) {
    assert.equal(seekFrameAtPointer(value, 0, 100, 300), null);
    assert.equal(seekFrameAtPointer(50, value, 100, 300), null);
    assert.equal(seekFrameAtPointer(50, 0, value, 300), null);
  }
  for (const width of [0, -1]) assert.equal(seekFrameAtPointer(50, 0, width, 300), null);
  for (const duration of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '300']) {
    assert.equal(seekFrameAtPointer(50, 0, 100, duration), null);
  }
});

test('keyboard seeking moves by frames, seconds and pages with consistent directions', () => {
  assert.equal(timelineSeekKey('ArrowLeft', 300, 900), 299);
  assert.equal(timelineSeekKey('ArrowRight', 300, 900), 301);
  assert.equal(timelineSeekKey('ArrowLeft', 300, 900, true), 270);
  assert.equal(timelineSeekKey('ArrowRight', 300, 900, true), 330);
  for (const shift of [false, true]) {
    assert.equal(timelineSeekKey('PageUp', 300, 900, shift), 150);
    assert.equal(timelineSeekKey('PageDown', 300, 900, shift), 450);
    assert.equal(timelineSeekKey('Home', 300, 900, shift), 0);
    assert.equal(timelineSeekKey('End', 300, 900, shift), 899);
  }
});

test('keyboard seeking stops at either boundary and supports one-frame media and long clips', () => {
  for (const key of ['ArrowLeft', 'PageUp', 'Home']) assert.equal(timelineSeekKey(key, 0, 900, true), 0);
  for (const key of ['ArrowRight', 'PageDown', 'End']) assert.equal(timelineSeekKey(key, 899, 900, true), 899);
  assert.equal(timelineSeekKey('ArrowLeft', 10, 900, true), 0);
  assert.equal(timelineSeekKey('PageUp', 149, 900), 0);
  assert.equal(timelineSeekKey('ArrowRight', 890, 900, true), 899);
  assert.equal(timelineSeekKey('PageDown', 800, 900), 899);
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
    assert.equal(timelineSeekKey(key, 0, 1), 0);
    assert.equal(timelineSeekKey(key, 0, 1, true), 0);
  }
  assert.equal(timelineSeekKey('ArrowRight', 1_079_998, 1_080_000), 1_079_999);
  assert.equal(timelineSeekKey('End', 0, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER - 1);
  assert.equal(timelineSeekKey('PageDown', Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER - 1);
  assert.equal(timelineSeekKey('ArrowLeft', -10, 900), 0);
  assert.equal(timelineSeekKey('ArrowRight', 1000, 900), 899);
});

test('unhandled keys and invalid frame inputs return null rather than triggering a seek', () => {
  for (const key of ['ArrowUp', 'ArrowDown', ' ', 'Enter', 'Escape', 'i', '', null, undefined]) {
    assert.equal(timelineSeekKey(key, 30, 900), null);
  }
  for (const current of [NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '30']) {
    assert.equal(timelineSeekKey('ArrowRight', current, 900), null);
    assert.equal(timelineSeekKey('Home', current, 900), null);
  }
  for (const duration of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '900']) {
    assert.equal(timelineSeekKey('ArrowRight', 30, duration), null);
  }
});
