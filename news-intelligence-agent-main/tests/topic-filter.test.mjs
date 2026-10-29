import assert from "node:assert/strict";
import test from "node:test";

import {
  BASELINE_BLOCKED_KEYWORDS,
  evaluateTopicFilter,
  isTopicGateActive,
  isTopicFilterActive,
  normalizeForMatch,
} from "../src/lib/news/topic-filter.ts";

const filter = (overrides) => ({
  enabled: true,
  mode: "include",
  topics: [],
  ...overrides,
});

const topic = (overrides) => ({
  id: "t1",
  label: "بازار خودرو",
  enabled: true,
  keywords: ["خودرو", "قیمت خودرو"],
  ...overrides,
});

test("normalizeForMatch folds Persian/Arabic variants and ZWNJ", () => {
  // ZWNJ is stripped, so «می‌شود» and «میشود» compare equal; Arabic ي/ك fold to Persian.
  assert.equal(normalizeForMatch("كي‌مي‌شود"), normalizeForMatch("کیمیشود"));
  assert.equal(normalizeForMatch("می‌شود"), normalizeForMatch("میشود"));
  assert.equal(normalizeForMatch("بانك"), normalizeForMatch("بانک"));
  assert.equal(normalizeForMatch("  خودرو  "), "خودرو");
  assert.equal(normalizeForMatch(null), "");
});

test("disabled filter passes everything (fail-open)", () => {
  const outcome = evaluateTopicFilter({ title: "هر خبری" }, filter({ enabled: false }));
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.reason, "filter_disabled");
});

test("missing/null filter passes everything (fail-open)", () => {
  assert.equal(evaluateTopicFilter({ title: "x" }, null).verdict, "pass");
  assert.equal(evaluateTopicFilter({ title: "x" }, undefined).verdict, "pass");
});

test("filter with no effective keywords passes everything (fail-open)", () => {
  const outcome = evaluateTopicFilter(
    { title: "خبر نامرتبط" },
    filter({ topics: [topic({ keywords: [] }), topic({ id: "t2", enabled: false, keywords: ["الف"] })] }),
  );
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.reason, "no_effective_topics");
});

test("include mode: matching topic passes, non-matching is skipped", () => {
  const f = filter({ topics: [topic()] });

  const hit = evaluateTopicFilter({ title: "قیمت خودرو در بازار امروز" }, f);
  assert.equal(hit.verdict, "pass");
  assert.equal(hit.reason, "matched_topic");
  assert.deepEqual(hit.matchedTopics, ["بازار خودرو"]);

  const miss = evaluateTopicFilter({ title: "قیمت طلا و ارز امروز" }, f);
  assert.equal(miss.verdict, "skip");
  assert.equal(miss.reason, "not_in_selected_topics");
});

test("include mode matches across title/description/content and ORs topics", () => {
  const f = filter({
    topics: [topic(), topic({ id: "t2", label: "مسکن", keywords: ["مسکن"] })],
  });

  const viaDescription = evaluateTopicFilter({ title: "تحلیل بازار", description: "روند معاملات مسکن" }, f);
  assert.equal(viaDescription.verdict, "pass");
  assert.deepEqual(viaDescription.matchedTopics, ["مسکن"]);

  const viaContent = evaluateTopicFilter({ title: "گزارش روز", content: "واردات خودرو کاهش یافت" }, f);
  assert.equal(viaContent.verdict, "pass");
  assert.deepEqual(viaContent.matchedTopics, ["بازار خودرو"]);
});

test("multi-word keywords match as phrases", () => {
  const f = filter({ topics: [topic({ keywords: ["قیمت خودرو"] })] });
  assert.equal(evaluateTopicFilter({ title: "قیمت خودرو امروز" }, f).verdict, "pass");
  assert.equal(evaluateTopicFilter({ title: "قیمت مسکن و خودرو" }, f).verdict, "skip");
});

test("Persian keywords match regardless of ZWNJ/Arabic letter variants", () => {
  const f = filter({ topics: [topic({ keywords: ["سیاست پولی"] })] });
  assert.equal(evaluateTopicFilter({ title: "سياست پولي بانک مرکزی" }, f).verdict, "pass");
});

test("exclude mode: matching topic is skipped, others pass", () => {
  const f = filter({ mode: "exclude", topics: [topic({ label: "قیمت‌ها", keywords: ["قیمت طلا"] })] });

  const noise = evaluateTopicFilter({ title: "قیمت طلا امروز" }, f);
  assert.equal(noise.verdict, "skip");
  assert.equal(noise.reason, "matched_excluded_topic");

  const keep = evaluateTopicFilter({ title: "رتبه‌بندی اعتباری ناشران" }, f);
  assert.equal(keep.verdict, "pass");
});

test("disabled topic rows are ignored", () => {
  const f = filter({ topics: [topic({ enabled: false })] });
  const outcome = evaluateTopicFilter({ title: "خودرو" }, f);
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.reason, "no_effective_topics");
});

test("blocked keywords win in include mode even when a topic matches", () => {
  const f = filter({ topics: [topic()], blockedKeywords: ["ورزش", "فوتبال"] });
  const outcome = evaluateTopicFilter({ title: "قیمت خودرو و حاشیه‌های فوتبال" }, f);
  assert.equal(outcome.verdict, "skip");
  assert.equal(outcome.reason, "matched_blocked_keyword");
  assert.deepEqual(outcome.blockedKeywords, ["فوتبال"]);
  assert.deepEqual(outcome.matchedTopics, []);
});

test("blocked keywords win in exclude mode too", () => {
  const f = filter({ mode: "exclude", topics: [topic()], blockedKeywords: ["حوادث"] });
  const outcome = evaluateTopicFilter({ title: "گزارش حوادث جاده‌ای" }, f);
  assert.equal(outcome.verdict, "skip");
  assert.equal(outcome.reason, "matched_blocked_keyword");
});

test("deny-list-only configuration filters blocked news and passes the rest", () => {
  const f = filter({ topics: [], blockedKeywords: ["ورزش", "سرگرمی"] });

  const blocked = evaluateTopicFilter({ title: "نتایج مسابقات ورزشی" }, f);
  assert.equal(blocked.verdict, "skip");
  assert.equal(blocked.reason, "matched_blocked_keyword");

  const allowed = evaluateTopicFilter({ title: "انتشار صورت‌های مالی بانک" }, f);
  assert.equal(allowed.verdict, "pass");
  assert.equal(allowed.reason, "no_excluded_match");
});

test("blocked keyword matching is Persian-normalized", () => {
  const f = filter({ topics: [topic()], blockedKeywords: ["سینما"] });
  const outcome = evaluateTopicFilter({ title: "بازگشت هنرمندان به سينما" }, f);
  assert.equal(outcome.verdict, "skip");
  assert.equal(outcome.reason, "matched_blocked_keyword");
});

test("isTopicFilterActive recognises a deny-list-only configuration", () => {
  assert.equal(isTopicFilterActive(filter({ topics: [], blockedKeywords: ["ورزش"] })), true);
  assert.equal(isTopicFilterActive(filter({ topics: [], blockedKeywords: ["  "] })), false);
});

test("isTopicFilterActive reflects real narrowing only", () => {
  assert.equal(isTopicFilterActive(null), false);
  assert.equal(isTopicFilterActive(filter({ enabled: false })), false);
  assert.equal(isTopicFilterActive(filter({ topics: [topic({ keywords: [] })] })), false);
  assert.equal(isTopicFilterActive(filter({ topics: [topic()] })), true);
});

// ── Baseline deny-list (always on) ─────────────────────────────────────────────

test("baseline deny-list blocks off-topic news even when the filter is disabled", () => {
  const outcome = evaluateTopicFilter({ title: "تجاری‌شدن ورزش کودکان" }, filter({ enabled: false }));
  assert.equal(outcome.verdict, "skip");
  assert.equal(outcome.reason, "matched_blocked_keyword");
  assert.deepEqual(outcome.blockedKeywords, ["ورزش"]);
});

test("baseline deny-list applies when no filter is configured at all", () => {
  const outcome = evaluateTopicFilter({ title: "تصادف زنجیره‌ای در جاده" }, null);
  assert.equal(outcome.verdict, "skip");
  assert.equal(outcome.reason, "matched_blocked_keyword");
  assert.deepEqual(outcome.blockedKeywords, ["تصادف"]);
});

test("baseline deny-list wins even when an included topic matches", () => {
  const f = filter({ topics: [topic({ label: "کودکان", keywords: ["کودکان"] })] });
  const outcome = evaluateTopicFilter({ title: "تجاری‌شدن ورزش کودکان" }, f);
  assert.equal(outcome.verdict, "skip");
  assert.equal(outcome.reason, "matched_blocked_keyword");
});

test("baseline hits short-circuit before the configurable deny-list", () => {
  const f = filter({ topics: [], blockedKeywords: ["کودکان"] });
  const outcome = evaluateTopicFilter({ title: "ورزش کودکان" }, f);
  assert.equal(outcome.verdict, "skip");
  assert.deepEqual(outcome.blockedKeywords, ["ورزش"]);
});

test("config deny-list still reports its own hits when baseline misses", () => {
  const f = filter({ topics: [], blockedKeywords: ["قیمت ارز"] });
  const outcome = evaluateTopicFilter({ title: "قیمت ارز و طلا" }, f);
  assert.equal(outcome.verdict, "skip");
  assert.deepEqual(outcome.blockedKeywords, ["قیمت ارز"]);
});

test("isTopicGateActive is always armed (baseline) while isTopicFilterActive is not", () => {
  assert.equal(isTopicGateActive(null), true);
  assert.equal(isTopicGateActive(filter({ enabled: false })), true);
  assert.equal(isTopicFilterActive(null), false);
});

test("baseline list is conservative and non-empty", () => {
  assert.ok(BASELINE_BLOCKED_KEYWORDS.length > 0);
  assert.ok(BASELINE_BLOCKED_KEYWORDS.includes("ورزش"));
  // Must never contain credit-domain words that could shadow real news.
  for (const forbidden of ["بانک", "اعتبار", "رتبه", "بورس", "اقتصاد"]) {
    assert.equal(BASELINE_BLOCKED_KEYWORDS.includes(forbidden), false);
  }
});

test("government budget allocation and Kalabarg news are blocked and not confused with credit scoring", () => {
  const kalabarg = evaluateTopicFilter(
    { title: "تخصیص اعتبار کالابرگ الکترونیکی برای دهک‌های درآمدی" },
    null,
  );
  assert.equal(kalabarg.verdict, "skip");
  assert.equal(kalabarg.reason, "matched_blocked_keyword");

  const roadBridge = evaluateTopicFilter(
    { title: "تخصیص اعتبار ساخت جاده و پل در استان‌های مرزی" },
    filter({ topics: [topic({ label: "اعتبارسنجی", keywords: ["اعتبارسنجی", "بانک مرکزی"] })] }),
  );
  assert.equal(roadBridge.verdict, "skip");
  assert.equal(roadBridge.reason, "matched_blocked_keyword");

  const civilBudget = evaluateTopicFilter(
    { title: "افزایش اعتبارات عمرانی و اعتبارات استانی در لایحه جدید" },
    null,
  );
  assert.equal(civilBudget.verdict, "skip");
  assert.equal(civilBudget.reason, "matched_blocked_keyword");

  // Real credit rating news still passes!
  const realCreditRating = evaluateTopicFilter(
    { title: "صدور گواهی رتبه‌بندی اعتباری ناشران توسط شرکت اعتبارسنجی" },
    filter({ topics: [topic({ label: "اعتبارسنجی", keywords: ["اعتبارسنجی", "رتبه‌بندی اعتباری"] })] }),
  );
  assert.equal(realCreditRating.verdict, "pass");
});

test('operator baseline override replaces defaults even when topic filter is off', () => {
  const filter = { enabled: false, mode: 'include', topics: [], baselineBlockedKeywords: ['نمونه ممنوع'] };
  assert.equal(evaluateTopicFilter({title:'خبر فوتبال'}, filter).verdict, 'pass');
  assert.equal(evaluateTopicFilter({title:'نمونه ممنوع'}, filter).verdict, 'skip');
  assert.equal(evaluateTopicFilter({title:'خبر فوتبال'}, {...filter, baselineBlockedKeywords: []}).verdict, 'pass');
  assert.equal(evaluateTopicFilter({title:'خبر فوتبال'}, null).verdict, 'skip');
});
