/**
 * Bounded-concurrency async worker pool with time-budget & circuit-breaker guards.
 *
 * Pure TypeScript module (no `@/` aliases or DB imports) so `node --test` can
 * exercise concurrency, time-budget cutoffs, and fatal-error circuit breaking directly.
 */

export const DEFAULT_AI_CONCURRENCY = 4;

export type ConcurrentPoolOptions<R> = {
  /** Number of parallel workers (clamped to 1..8, defaults to 4). */
  concurrency?: number;
  /** Stop claiming *new* items once elapsed wall-clock time reaches this budget. */
  maxDurationMs?: number;
  /** Return `true` on fatal provider/auth/quota errors to trip the circuit breaker immediately. */
  shouldAbort?: (result: R) => boolean;
  /** Clock override for deterministic tests. */
  nowFn?: () => number;
};

export async function runBoundedConcurrentPool<T, R>(
  items: readonly T[],
  workerFn: (item: T, index: number) => Promise<R>,
  options: ConcurrentPoolOptions<R> = {},
): Promise<R[]> {
  if (items.length === 0) return [];

  const concurrency = Math.max(
    1,
    Math.min(8, Math.round(options.concurrency ?? DEFAULT_AI_CONCURRENCY), items.length),
  );
  const maxDurationMs = options.maxDurationMs ?? 65_000;
  const nowFn = options.nowFn ?? Date.now;
  const startedAt = nowFn();

  const indexedResults: Array<{ index: number; value: R }> = [];
  let cursor = 0;
  let completed = 0;
  let aborted = false;

  async function worker(): Promise<void> {
    while (!aborted && cursor < items.length) {
      if ((completed > 0 || cursor >= concurrency) && nowFn() - startedAt >= maxDurationMs) {
        break;
      }
      const idx = cursor;
      cursor += 1;

      const value = await workerFn(items[idx], idx);
      completed += 1;
      indexedResults.push({ index: idx, value });

      if (options.shouldAbort?.(value)) {
        aborted = true;
        break;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  indexedResults.sort((a, b) => a.index - b.index);
  return indexedResults.map((entry) => entry.value);
}
