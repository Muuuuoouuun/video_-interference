import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedMutation } from '../packages/core/confirmed-mutation.mjs';

test('a confirmed request stays saved when the following state fetch fails', async () => {
  const stored = [], stateError = new Error('state connection closed');
  const result = await confirmedMutation(async () => { const request = { id: 'saved-once', text: '2배속' }; stored.push(request); return request; }, async () => { throw stateError; });
  assert.equal(result.result.id, 'saved-once'); assert.equal(result.refreshError, stateError); assert.equal(stored.length, 1);
});

test('a rejected write retains its failure and does not fetch a success state', async () => {
  let refreshed = false;
  await assert.rejects(confirmedMutation(async () => { throw new Error('invalid request'); }, async () => { refreshed = true; }), /invalid request/);
  assert.equal(refreshed, false);
});

test('successful write and refresh preserve the acknowledged response', async () => {
  const response = { id: 'supplement', text: '최종 3배속' }; let refreshed = false;
  const result = await confirmedMutation(async () => response, async () => { refreshed = true; });
  assert.equal(result.result, response); assert.equal(result.refreshError, null); assert.equal(refreshed, true);
});
