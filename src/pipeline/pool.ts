/**
 * Concurrency pool: bounded parallel map with order preservation and error
 * isolation.
 *
 * Mirrors Python `asyncio.gather(*(task() for ...))` under a semaphore: every
 * task runs up to `limit` at a time, results keep the input order regardless
 * of completion order, and a rejected task NEVER rejects the pool — each
 * slot captures its own error (like Python's per-task try/except returning a
 * fallback) so the caller decides what a failure means.
 */

/**
 * Map `items` through `fn` with at most `limit` concurrent invocations.
 *
 * Resolves with one entry per item, in input order; each entry is either
 * `{ ok: true, value }` or `{ ok: false, error }`. `fn` receiving an item
 * must never cause the whole pool to reject.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PoolResult<R>[]> {
  const results: PoolResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  const lanes: Promise<void>[] = [];
  for (let w = 0; w < workers; w++) {
    lanes.push(
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          try {
            results[i] = { ok: true, value: await fn(items[i]!, i) };
          } catch (err) {
            results[i] = {
              ok: false,
              error: err instanceof Error ? err : new Error(String(err)),
            };
          }
        }
      })(),
    );
  }
  await Promise.all(lanes);
  return results;
}

export type PoolResult<R> = { ok: true; value: R } | { ok: false; error: Error };
