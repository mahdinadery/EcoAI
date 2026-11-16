/**
 * Bulk-analysis planning — PURE (no DB, no `@/` imports) so `node --test` can
 * exercise the chunking and the deadline math directly.
 *
 * The normal queue (`drainArticleQueue`) analyzes strictly one article at a
 * time, oldest first, and stops at the first failure, because delivery must keep
 * arrival order and a failed head row must not be skipped silently. That is the
 * right rule for the automatic pipeline, but it means an operator with spare API
 * quota still only gets ~10 articles/minute.
 *
 * A bulk run is different by design: it spends quota on *analysis only* (no
 * sending, no ordering guarantee, no queue lock), many articles at once, and it
 * is bounded by a wall-clock budget instead of an article count so that a single
 * request never gets killed mid-flight by the host's `maxDuration`.
 */

export const BULK_ANALYSIS = {
  /** Articles to attempt per request (the caller loops for more). */
  defaultTarget: 120,
  maxTarget: 500,
  /**
   * Keep the request under the platform limit (Render's free tier cuts at 60s);
   * the remainder is headroom for the final DB writes and the JSON response.
   */
  budgetMs: 50_000,
  defaultConcurrency: 6,
  maxConcurrency: 8,
  /**
   * Rough per-article AI cost, used only to decide when the remaining time is too
   * short to start another wave. Actual pace is fed back in from the previous
   * wave when available.
   */
  estimatedItemMs: 9_000,
} as const;

export function clampBulkTarget(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return BULK_ANALYSIS.defaultTarget;
  return Math.max(1, Math.min(BULK_ANALYSIS.maxTarget, Math.round(parsed)));
}

export function clampBulkConcurrency(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return BULK_ANALYSIS.defaultConcurrency;
  return Math.max(1, Math.min(BULK_ANALYSIS.maxConcurrency, Math.round(parsed)));
}

export type BulkStopReason = "ok" | "target_reached" | "queue_empty" | "budget_exhausted";

/**
 * Decide the next wave of a bounded bulk run.
 *
 * `chunk` is never larger than the time left can plausibly finish (waves of
 * `concurrency` at `itemMs` each) and never larger than what the caller still
 * wants or what the queue still holds — so a request ends on its own terms with
 * a truthful "remaining" number instead of being truncated by the host.
 */
export function planBulkChunk(args: {
  targetRemaining: number;
  queueRemaining: number;
  elapsedMs: number;
  budgetMs?: number;
  concurrency?: number;
  itemMs?: number;
}): { run: boolean; chunk: number; reason: BulkStopReason; concurrency: number } {
  const budgetMs = args.budgetMs ?? BULK_ANALYSIS.budgetMs;
  const itemMs = Math.max(500, Math.round(args.itemMs ?? BULK_ANALYSIS.estimatedItemMs));
  const concurrency = clampBulkConcurrency(args.concurrency);
  // A missing/NaN argument is a caller bug: stop with a reason instead of
  // computing NaN and letting the route loop on it.
  const targetRemaining = Number.isFinite(args.targetRemaining) ? Math.max(0, Math.floor(args.targetRemaining)) : 0;
  const queueRemaining = Number.isFinite(args.queueRemaining) ? Math.max(0, Math.floor(args.queueRemaining)) : 0;

  if (targetRemaining <= 0) return { run: false, chunk: 0, reason: "target_reached", concurrency };
  if (queueRemaining <= 0) return { run: false, chunk: 0, reason: "queue_empty", concurrency };

  const timeLeftMs = budgetMs - Math.max(0, args.elapsedMs);
  const wavesFit = Math.floor(timeLeftMs / itemMs);
  if (timeLeftMs < itemMs || wavesFit < 1) {
    return { run: false, chunk: 0, reason: "budget_exhausted", concurrency };
  }

  const chunk = Math.max(1, Math.min(targetRemaining, queueRemaining, concurrency * wavesFit));
  return { run: true, chunk, reason: "ok", concurrency };
}

/**
 * Pace estimate for the next wave, so a slow provider (or a quota throttle)
 * shrinks the following chunk instead of over-claiming work the request cannot
 * finish. Returns the previous `itemMs` when there is nothing to measure yet.
 */
export function estimateItemMs(args: {
  previousItemMs?: number;
  waveElapsedMs: number;
  waveCompleted: number;
}): number {
  const fallback = Math.max(500, Math.round(args.previousItemMs ?? BULK_ANALYSIS.estimatedItemMs));
  if (!(args.waveCompleted > 0) || !(args.waveElapsedMs > 0)) return fallback;
  const measured = args.waveElapsedMs / args.waveCompleted;
  // Smooth: a single fast wave must not make the planner promise 1 ms per item.
  return Math.max(500, Math.round((fallback + measured) / 2));
}
