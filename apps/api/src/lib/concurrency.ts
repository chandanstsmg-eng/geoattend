/**
 * Runs `fn` over `items` with at most `limit` running at once and returns the results in the items' order.
 * Used where a report needs one database lookup per day: one after another, 30–90 days of a 1,000-person
 * company took several seconds of pure waiting; a few at a time keeps the results identical and leaves
 * room in the connection pool for other requests.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Day lookups a single report may run at once (the request pool has 15 connections). */
export const DAY_LOOKUPS_AT_ONCE = 4;
