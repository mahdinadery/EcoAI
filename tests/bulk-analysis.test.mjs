import assert from "node:assert/strict";
import test from "node:test";

import {
  BULK_ANALYSIS,
  clampBulkConcurrency,
  clampBulkTarget,
  estimateItemMs,
  planBulkChunk,
} from "../src/lib/news/bulk-analysis.ts";

test("clampBulkTarget / clampBulkConcurrency keep a hand-written request inside the safe band", () => {
  assert.equal(clampBulkTarget(undefined), BULK_ANALYSIS.defaultTarget);
  assert.equal(clampBulkTarget(0), BULK_ANALYSIS.defaultTarget, "0 must not mean 'analyze nothing'");
  assert.equal(clampBulkTarget(-4), BULK_ANALYSIS.defaultTarget);
  assert.equal(clampBulkTarget("abc"), BULK_ANALYSIS.defaultTarget);
  assert.equal(clampBulkTarget("150"), 150);
  assert.equal(clampBulkTarget(12.7), 13, "rounded, never floored to 0");
  assert.equal(clampBulkTarget(100_000), BULK_ANALYSIS.maxTarget, "one request stays bounded; the caller loops");

  assert.equal(clampBulkConcurrency(undefined), BULK_ANALYSIS.defaultConcurrency);
  assert.equal(clampBulkConcurrency("2"), 2);
  assert.equal(clampBulkConcurrency(99), BULK_ANALYSIS.maxConcurrency, "provider rate limits are respected");
  assert.equal(clampBulkConcurrency(0), BULK_ANALYSIS.defaultConcurrency);
});

test("planBulkChunk stops for the right reason and says so", () => {
  const base = { targetRemaining: 120, queueRemaining: 1000, elapsedMs: 0, budgetMs: 50_000, concurrency: 6, itemMs: 9_000 };

  const stopped = planBulkChunk({ ...base, targetRemaining: 0 });
  assert.deepEqual({ run: stopped.run, reason: stopped.reason }, { run: false, reason: "target_reached" });
  assert.equal(planBulkChunk({ ...base, targetRemaining: 120, queueRemaining: 0 }).reason, "queue_empty");
  // 43s of a 50s budget gone: less than one item fits, so starting a wave is waste.
  assert.equal(planBulkChunk({ ...base, targetRemaining: 120, elapsedMs: 43_000 }).reason, "budget_exhausted");
  assert.equal(planBulkChunk({ ...base, targetRemaining: 120, elapsedMs: 50_000 }).reason, "budget_exhausted");
  assert.equal(planBulkChunk({ ...base, targetRemaining: 120 }).reason, "ok");
});

test("planBulkChunk sizes a wave from the time actually left", () => {
  const base = { budgetMs: 50_000, concurrency: 6, itemMs: 9_000, queueRemaining: 1000, elapsedMs: 0, targetRemaining: 120 };

  // 50s / 9s per item = 5 waves of 6 lanes.
  assert.equal(planBulkChunk(base).chunk, 30);
  // Missing/mis-typed inputs stop with a reason; they never produce NaN work.
  assert.equal(planBulkChunk({ ...base, targetRemaining: undefined }).reason, "target_reached");
  assert.equal(planBulkChunk({ ...base, queueRemaining: "lots" }).reason, "queue_empty");
  // Never more than the caller asked for, nor more than the queue holds.
  assert.equal(planBulkChunk({ ...base, targetRemaining: 5 }).chunk, 5);
  assert.equal(planBulkChunk({ ...base, queueRemaining: 3 }).chunk, 3);
  // Half the budget left => a smaller wave, not the same one truncated by the host.
  assert.equal(planBulkChunk({ ...base, elapsedMs: 25_000 }).chunk, 12);
  // Faster provider => bigger wave (still capped by the target).
  assert.equal(planBulkChunk({ ...base, itemMs: 2_000, targetRemaining: 120 }).chunk, 120);
  // A chunk is never empty while `run` is true, even with one lane and one item.
  const tight = planBulkChunk({ ...base, concurrency: 1, itemMs: 49_000, queueRemaining: 1, targetRemaining: 1 });
  assert.equal(tight.chunk, 1);
});

test("estimateItemMs learns the real pace without over-promising", () => {
  assert.equal(estimateItemMs({ waveElapsedMs: 0, waveCompleted: 0 }), BULK_ANALYSIS.estimatedItemMs, "nothing measured yet");
  assert.equal(estimateItemMs({ previousItemMs: 9_000, waveElapsedMs: 20_000, waveCompleted: 10 }), 5_500, "smoothed average");
  // One lucky fast wave must not collapse the estimate to ~0.
  const fast = estimateItemMs({ previousItemMs: 9_000, waveElapsedMs: 100, waveCompleted: 10 });
  assert.ok(fast >= 500 && fast < 9_000, `got ${fast}`);
  // A throttled provider stretches it, and the floor keeps it positive.
  assert.equal(estimateItemMs({ previousItemMs: 9_000, waveElapsedMs: 600_000, waveCompleted: 10 }), Math.round((9_000 + 60_000) / 2));
  assert.ok(estimateItemMs({ previousItemMs: 0, waveElapsedMs: 0, waveCompleted: 0 }) >= 500);
});
