import test from 'node:test';
import assert from 'node:assert/strict';
import { importProgressLabel } from '../packages/core/import-progress.mjs';

test('import progress names each step with bounded percentages and a late, conservative estimate', () => {
  assert.deepEqual(importProgressLabel({ stage: 'receiving', progress: 0.5, sentBytes: 100_000_000, totalBytes: 200_000_000, stageElapsedMs: 1000 }), { step: 1, title: '영상 파일 받는 중', detail: '100MB / 200MB', percent: 50, indeterminate: false });
  assert.match(importProgressLabel({ stage: 'receiving', progress: 0.25, sentBytes: 5e7, totalBytes: 2e8, stageElapsedMs: 10_000 }).detail, /약 30초 남음$/);
  const converting = importProgressLabel({ stage: 'converting', progress: 0.4, stageElapsedMs: 120_000 });
  assert.equal(converting.step, 2); assert.equal(converting.percent, 40); assert.match(converting.detail, /약 3분 남음$/);
  assert.equal(importProgressLabel({ stage: 'converting', progress: 0 }).indeterminate, true, 'no fake percentage before the worker reports one');
  assert.equal(importProgressLabel({ stage: 'converting', progress: 0.99 }).step, 3, 'thumbnail and save time is not shown as 99%');
  assert.equal(importProgressLabel({ stage: 'receiving', progress: 7, totalBytes: 10 }).percent, 100);
  assert.equal(importProgressLabel({ stage: 'receiving', progress: Number.NaN }).percent, 0);
  assert.equal(importProgressLabel({ stage: 'receiving', progress: 0.5, totalBytes: 0 }).indeterminate, true);
});
