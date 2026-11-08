import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeUrl } from "../src/lib/news/canonical-url.ts";
import { runBoundedConcurrentPool } from "../src/lib/news/concurrent-pool.ts";
import { buildNewsMessage } from "../src/lib/delivery/message.ts";
import { DEFAULT_AUTO_SEND_POLICY, DEFAULT_TOPIC_FILTER } from "../src/lib/ai/config-types.ts";

test("canonicalizeUrl strips tracking params but keeps identity params", () => {
  const canonical = canonicalizeUrl("https://example.com/a?utm_source=x&id=5&gclid=abc");
  assert.ok(canonical.includes("id=5"));
  assert.ok(!canonical.includes("utm_source"));
  assert.ok(!canonical.includes("gclid"));
});

test("canonicalizeUrl survives unparseable input unchanged", () => {
  assert.equal(canonicalizeUrl("not a url"), "not a url");
});

test("buildNewsMessage renders the shared delivery text", () => {
  const text = buildNewsMessage({
    title: "عنوان خبر",
    summary: "خلاصه خبر",
    category: "اقتصاد",
    importanceScore: 80,
    url: "https://example.com/news/1",
  });

  assert.ok(text.includes("عنوان خبر"));
  assert.ok(text.includes("خلاصه خبر"));
  assert.ok(text.includes("اقتصاد"));
  assert.ok(text.includes("80 از ۱۰۰"));
  assert.ok(text.includes("https://example.com/news/1"));
});

test("buildNewsMessage tolerates missing analysis fields", () => {
  const text = buildNewsMessage({ title: "t", summary: null, category: null, importanceScore: null, url: "u" });
  assert.ok(text.includes("—"));
  assert.ok(text.includes("ثبت نشده"));
});

test("default topic filter is inactive (fail-open) and default policy is env-driven", () => {
  assert.equal(DEFAULT_TOPIC_FILTER.enabled, false);
  assert.equal(DEFAULT_TOPIC_FILTER.topics.length, 0);
  assert.equal(DEFAULT_AUTO_SEND_POLICY.useCustom, false);
  assert.equal(DEFAULT_AUTO_SEND_POLICY.destination, "local");
});

test("runBoundedConcurrentPool processes up to N items concurrently and preserves input order", async () => {
  let active = 0;
  let peakActive = 0;
  const items = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];

  const results = await runBoundedConcurrentPool(
    items,
    async (id, idx) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, idx % 2 === 0 ? 18 : 6));
      active -= 1;
      return `${id}-done`;
    },
    { concurrency: 4 },
  );

  assert.equal(peakActive, 4);
  assert.deepEqual(results, items.map((id) => `${id}-done`));
});

test("runBoundedConcurrentPool trips circuit breaker on fatal errors and respects maxDurationMs", async () => {
  const started = [];
  const res = await runBoundedConcurrentPool(
    [1, 2, 3, 4, 5, 6],
    async (n) => {
      started.push(n);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { n, fatal: n === 2 };
    },
    { concurrency: 2, shouldAbort: (r) => r.fatal },
  );
  assert.ok(started.length <= 3);
  assert.ok(res.some((r) => r.fatal));

  let fakeNow = 1_000;
  const timed = await runBoundedConcurrentPool(
    ["a", "b", "c", "d", "e"],
    async (x) => {
      fakeNow += 300;
      return x;
    },
    { concurrency: 2, maxDurationMs: 500, nowFn: () => fakeNow },
  );
  assert.deepEqual(timed, ["a", "b"]);
});
