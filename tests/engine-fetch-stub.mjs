/** Test-process preload only. It cannot make any outgoing network request. */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const control = process.env.VI_TEST_FETCH_CONTROL;
if (!control) throw new Error('Offline fetch test control directory is required.');
await mkdir(control, { recursive: true });
let count = 0;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== 'https://api.anthropic.com/v1/messages') throw new Error(`Unmocked network request blocked in test process: ${url}`);
  const call = ++count;
  const payload = JSON.parse(options.body);
  const context = JSON.parse(payload.messages[0].content.find(item => item.type === 'text').text);
  await writeFile(join(control, `call-${call}.json`), JSON.stringify({ call, model: payload.model, system: payload.system, context }));
  for (;;) {
    options.signal?.throwIfAborted();
    try { await access(join(control, `release-${call}`)); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ ops: [{ type: 'speed', params: { factor: 2 }, aiNote: 'Offline test proposal' }] }) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
