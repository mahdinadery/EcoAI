import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDIT_RATING_PACK,
  NEWS_PACKS,
  appendAudienceNote,
  mergeBlockedKeywords,
  getNewsPack,
  mergePackTopics,
  normalizeSourceUrl,
  normalizeTopicLabel,
} from "../src/lib/news/news-packs.ts";

test("credit-rating pack is internally consistent and saveable", () => {
  const pack = CREDIT_RATING_PACK;

  assert.equal(pack.id, "credit-rating");
  assert.ok(pack.topics.length >= 6, "pack should cover several credit-rating sub-domains");
  assert.ok(pack.topics.length <= 30);

  const labels = new Set();
  const ids = new Set();
  for (const topic of pack.topics) {
    assert.ok(topic.label.trim().length > 0);
    assert.ok(topic.label.length <= 80);
    assert.equal(topic.enabled, true);
    assert.ok(topic.keywords.length > 0);
    assert.ok(topic.keywords.length <= 50);
    for (const keyword of topic.keywords) {
      assert.ok(keyword.trim().length > 0);
      assert.ok(keyword.length <= 120);
    }
    assert.equal(labels.has(normalizeTopicLabel(topic.label)), false, `duplicate label: ${topic.label}`);
    labels.add(normalizeTopicLabel(topic.label));
    assert.equal(ids.has(topic.id), false, `duplicate id: ${topic.id}`);
    ids.add(topic.id);
  }

  assert.ok(pack.sources.length >= 4);
  const urls = new Set();
  for (const source of pack.sources) {
    assert.equal(source.type, "rss");
    assert.match(source.url, /^https:\/\//);
    assert.ok(source.name.trim().length > 0);
    assert.ok(source.priority >= 1 && source.priority <= 5);
    assert.ok(source.fetchIntervalMinutes >= 5 && source.fetchIntervalMinutes <= 1440);
    assert.ok(source.maxItemsPerFetch >= 1 && source.maxItemsPerFetch <= 200);
    const normalized = normalizeSourceUrl(source.url);
    assert.equal(urls.has(normalized), false, `duplicate source: ${source.url}`);
    urls.add(normalized);
  }

  assert.match(pack.audienceNote ?? "", /شرکت اعتبارسنجی/);
  assert.ok(pack.audienceMarker && (pack.audienceNote ?? "").includes(pack.audienceMarker));
});

test("pack registry exposes the credit-rating pack by id", () => {
  assert.equal(getNewsPack("credit-rating")?.id, "credit-rating");
  assert.equal(getNewsPack("does-not-exist"), undefined);
  assert.ok(NEWS_PACKS.length >= 1);
});

test("mergePackTopics adds every topic with a namespaced id", () => {
  const result = mergePackTopics([], CREDIT_RATING_PACK);

  assert.equal(result.added.length, CREDIT_RATING_PACK.topics.length);
  assert.equal(result.topics.length, CREDIT_RATING_PACK.topics.length);
  assert.equal(result.truncated, 0);
  assert.equal(result.skipped.length, 0);

  for (const topic of result.topics) {
    assert.ok(topic.id.startsWith(`pack-${CREDIT_RATING_PACK.id}-`));
    assert.deepEqual(topic.keywords, CREDIT_RATING_PACK.topics.find((item) => item.label === topic.label)?.keywords);
  }
});

test("applying the pack twice does not duplicate topics", () => {
  const first = mergePackTopics([], CREDIT_RATING_PACK);
  const second = mergePackTopics(first.topics, CREDIT_RATING_PACK);

  assert.equal(second.topics.length, first.topics.length);
  assert.equal(second.added.length, 0);
  assert.equal(second.skipped.length, CREDIT_RATING_PACK.topics.length);
  assert.equal(second.truncated, 0);
});

test("labels are compared Persian-friendly (ZWNJ / Arabic variants)", () => {
  const existing = [
    { id: "x", label: "اعتبارسنجي و رتبه‌بندي اعتباري", enabled: true, keywords: ["اعتبارسنجی"] },
    { id: "y", label: "ريسک اعتباري و نکول", enabled: true, keywords: ["ریسک"] },
  ];
  const result = mergePackTopics(existing, CREDIT_RATING_PACK);

  // Both Arabic-letter variants match the pack's «اعتبارسنجی» and «ریسک اعتباری».
  assert.equal(result.skipped.includes("اعتبارسنجی و رتبه‌بندی اعتباری"), true);
  assert.equal(result.skipped.includes("ریسک اعتباری و نکول"), true);
  assert.equal(result.topics.length, existing.length + CREDIT_RATING_PACK.topics.length - 2);
});

test("the 30-topic configuration limit is respected", () => {
  const existing = Array.from({ length: 28 }, (_, index) => ({
    id: `existing-${index}`,
    label: `موضوع ${index}`,
    enabled: true,
    keywords: [`کلید ${index}`],
  }));

  const result = mergePackTopics(existing, CREDIT_RATING_PACK);

  assert.equal(result.topics.length, 30);
  assert.equal(result.added.length, 2);
  assert.equal(result.truncated, CREDIT_RATING_PACK.topics.length - 2);
  assert.deepEqual(existing.map((topic) => topic.id), Array.from({ length: 28 }, (_, index) => `existing-${index}`));
});

test("mergePackTopics never mutates the input keywords", () => {
  const existing = [{ id: "a", label: "موضوع", enabled: true, keywords: ["یک"] }];
  const result = mergePackTopics(existing, CREDIT_RATING_PACK);
  result.topics[0].keywords.push("تغییر");

  assert.deepEqual(existing[0].keywords, ["یک"]);
});

test("normalizeSourceUrl ignores case, trailing slashes and fragments", () => {
  assert.equal(
    normalizeSourceUrl("https://Example.COM/rss/"),
    normalizeSourceUrl("https://example.com/rss#section"),
  );
  assert.equal(normalizeSourceUrl("https://example.com/feeds?x=1"), "https://example.com/feeds?x=1");
  assert.equal(normalizeSourceUrl("not a url///"), "not a url");
});

test("appendAudienceNote adds the company context exactly once", () => {
  const prompt = "شما یک تحلیلگر خبری حرفه‌ای هستید.";
  const first = appendAudienceNote(prompt, CREDIT_RATING_PACK);

  assert.equal(first.alreadyPresent, false);
  assert.ok(first.prompt.startsWith(prompt));
  assert.ok(first.prompt.includes(CREDIT_RATING_PACK.audienceNote));

  const second = appendAudienceNote(first.prompt, CREDIT_RATING_PACK);
  assert.equal(second.alreadyPresent, true);
  assert.equal(second.prompt, first.prompt);
});

// ── Deny-list merge + tightened keywords ───────────────────────────────────────

test("pack ships a deny-list of off-topic keywords", () => {
  assert.ok((CREDIT_RATING_PACK.blockedKeywords ?? []).includes("ورزش"));
  assert.ok((CREDIT_RATING_PACK.blockedKeywords ?? []).includes("حوادث"));
  assert.ok((CREDIT_RATING_PACK.blockedKeywords ?? []).includes("تخصیص اعتبار"));
  assert.ok((CREDIT_RATING_PACK.blockedKeywords ?? []).includes("کالابرگ"));
  assert.ok((CREDIT_RATING_PACK.blockedKeywords ?? []).includes("اعتبارات عمرانی"));
});

test("mergeBlockedKeywords appends only new keywords", () => {
  const first = mergeBlockedKeywords(["ورزش"], CREDIT_RATING_PACK);
  assert.ok(first.added.includes("حوادث"));
  assert.ok(first.skipped.includes("ورزش"));
  assert.equal(first.blockedKeywords[0], "ورزش");

  const second = mergeBlockedKeywords(first.blockedKeywords, CREDIT_RATING_PACK);
  assert.deepEqual(second.added, []);
  assert.equal(second.blockedKeywords.length, first.blockedKeywords.length);
});

test("mergeBlockedKeywords ignores letter variants and blanks", () => {
  const result = mergeBlockedKeywords(["فوتبال"], {
    ...CREDIT_RATING_PACK,
    blockedKeywords: ["فوتبال", "  ", "فوتبال"],
  });
  assert.deepEqual(result.added, []);
});

test("credit pack no longer carries generic economy keywords that leak unrelated news", () => {
  const all = CREDIT_RATING_PACK.topics.flatMap((topic) => topic.keywords);
  for (const broad of ["مالیات", "تورم", "بودجه", "وام", "تسهیلات", "بدهی", "بیمه"]) {
    assert.equal(all.includes(broad), false, `«${broad}» should not be a pack keyword`);
  }
  for (const narrow of ["تسهیلات بانکی", "بیمه اعتبار", "کسری بودجه", "بدهی دولت"]) {
    assert.ok(all.includes(narrow), `«${narrow}» should stay`);
  }
});
