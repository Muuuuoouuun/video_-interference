import { availableParallelism } from 'node:os';

/** Parallel single-threaded media tasks: up to `limit`, never more than the machine's cores. */
export const mediaConcurrency = (limit = 4) => Math.max(1, Math.min(limit, availableParallelism()));

/**
 * Runs task(item, index, signal) with at most `limit` in flight and returns results in input order.
 * The first failure aborts the shared signal, waits for every started task to settle, then rethrows,
 * so no native process is left writing into a folder the caller is about to remove.
 */
export async function mapLimit(items, limit, task, signal) {
  const results = new Array(items.length), controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal?.aborted) forward(); else signal?.addEventListener('abort', forward, { once: true });
  let next = 0, failed = false, failure;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await task(items[index], index, controller.signal); }
      catch (error) { if (!failed) { failed = true; failure = error; controller.abort(error); } }
    }
  };
  try { await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)); }
  finally { signal?.removeEventListener('abort', forward); }
  if (failed) throw failure;
  return results;
}
