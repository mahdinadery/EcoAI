import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NEWS_PACK,
  ENGLISH_ECONOMICS_PACK,
  NEWS_PACKS,
  appendAudienceNote,
  mergeBlockedKeywords,
  getNewsPack,
  mergePackTopics,
  normalizeSourceUrl,
  normalizeTopicLabel,
} from "../src/lib/news/news-packs.ts";

test("english-economics pack is internally consistent and saveable", () => {
  const pack = ENGLISH_ECONOMICS_PACK;

  assert.equal(pack.id, "english-economics");
  assert.equal(DEFAULT_NEWS_PACK.id, "english-economics");
  assert.ok(pack.topics.length >= 6, "pack should cover major analytical economics sub-domains");
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

  assert.ok(pack.sources.length >= 6);
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

  assert.match(pack.audienceNote ?? "", /اقتصاددانان/);
  assert.ok(pack.audienceMarker && (pack.audienceNote ?? "").includes(pack.audienceMarker));
});

test("pack registry exposes the english-economics pack by id", () => {
  assert.equal(getNewsPack("english-economics")?.id, "english-economics");
  assert.equal(getNewsPack("does-not-exist"), undefined);
  assert.ok(NEWS_PACKS.length >= 1);
});

test("mergePackTopics adds every topic with a namespaced id", () => {
  const result = mergePackTopics([], ENGLISH_ECONOMICS_PACK);

  assert.equal(result.added.length, ENGLISH_ECONOMICS_PACK.topics.length);
  assert.equal(result.topics.length, ENGLISH_ECONOMICS_PACK.topics.length);
  assert.equal(result.truncated, 0);
  assert.equal(result.skipped.length, 0);

  for (const topic of result.topics) {
    assert.ok(topic.id.startsWith(`pack-${ENGLISH_ECONOMICS_PACK.id}-`));
    assert.deepEqual(
      topic.keywords,
      ENGLISH_ECONOMICS_PACK.topics.find((item) => item.label === topic.label)?.keywords,
    );
  }
});

test("applying the pack twice does not duplicate topics", () => {
  const first = mergePackTopics([], ENGLISH_ECONOMICS_PACK);
  const second = mergePackTopics(first.topics, ENGLISH_ECONOMICS_PACK);

  assert.equal(second.topics.length, first.topics.length);
  assert.equal(second.added.length, 0);
  assert.equal(second.skipped.length, ENGLISH_ECONOMICS_PACK.topics.length);
  assert.equal(second.truncated, 0);
});

test("labels are compared Persian-friendly (ZWNJ / Arabic variants)", () => {
  const existing = [
    { id: "x", label: "سياست پولي، تورم و بانک‌هاي مرکزي", enabled: true, keywords: ["inflation"] },
    { id: "y", label: "اقتصاد کلان، رشد و سياست مالي", enabled: true, keywords: ["gdp"] },
  ];
  const result = mergePackTopics(existing, ENGLISH_ECONOMICS_PACK);

  assert.equal(result.skipped.includes("سیاست پولی، تورم و بانک‌های مرکزی"), true);
  assert.equal(result.skipped.includes("اقتصاد کلان، رشد و سیاست مالی"), true);
  assert.equal(result.topics.length, existing.length + ENGLISH_ECONOMICS_PACK.topics.length - 2);
});

test("the 30-topic configuration limit is respected", () => {
  const existing = Array.from({ length: 28 }, (_, index) => ({
    id: `existing-${index}`,
    label: `موضوع ${index}`,
    enabled: true,
    keywords: [`کلید ${index}`],
  }));

  const result = mergePackTopics(existing, ENGLISH_ECONOMICS_PACK);

  assert.equal(result.topics.length, 30);
  assert.equal(result.added.length, 2);
  assert.equal(result.truncated, ENGLISH_ECONOMICS_PACK.topics.length - 2);
  assert.deepEqual(
    existing.map((topic) => topic.id),
    Array.from({ length: 28 }, (_, index) => `existing-${index}`),
  );
});

test("mergePackTopics never mutates the input keywords", () => {
  const existing = [{ id: "a", label: "موضوع", enabled: true, keywords: ["inflation"] }];
  const result = mergePackTopics(existing, ENGLISH_ECONOMICS_PACK);
  result.topics[0].keywords.push("تغییر");

  assert.deepEqual(existing[0].keywords, ["inflation"]);
});

test("normalizeSourceUrl ignores case, trailing slashes and fragments", () => {
  assert.equal(
    normalizeSourceUrl("https://Example.COM/rss/"),
    normalizeSourceUrl("https://example.com/rss#section"),
  );
  assert.equal(normalizeSourceUrl("https://example.com/feeds?x=1"), "https://example.com/feeds?x=1");
  assert.equal(normalizeSourceUrl("not a url///"), "not a url");
});

test("appendAudienceNote adds the analytical economics context exactly once", () => {
  const prompt = "شما یک تحلیلگر و مترجم اقتصادی حرفه‌ای هستید.";
  const first = appendAudienceNote(prompt, ENGLISH_ECONOMICS_PACK);

  assert.equal(first.alreadyPresent, false);
  assert.ok(first.prompt.startsWith(prompt));
  assert.ok(first.prompt.includes(ENGLISH_ECONOMICS_PACK.audienceNote));

  const second = appendAudienceNote(first.prompt, ENGLISH_ECONOMICS_PACK);
  assert.equal(second.alreadyPresent, true);
  assert.equal(second.prompt, first.prompt);
});

test("pack ships a bilingual deny-list of off-topic keywords", () => {
  assert.ok((ENGLISH_ECONOMICS_PACK.blockedKeywords ?? []).includes("nfl"));
  assert.ok((ENGLISH_ECONOMICS_PACK.blockedKeywords ?? []).includes("celebrity gossip"));
  assert.ok((ENGLISH_ECONOMICS_PACK.blockedKeywords ?? []).includes("ورزش"));
  assert.ok((ENGLISH_ECONOMICS_PACK.blockedKeywords ?? []).includes("حوادث"));
});

test("mergeBlockedKeywords appends only new keywords", () => {
  const first = mergeBlockedKeywords(["ورزش"], ENGLISH_ECONOMICS_PACK);
  assert.ok(first.added.includes("حوادث"));
  assert.ok(first.skipped.includes("ورزش"));
  assert.equal(first.blockedKeywords[0], "ورزش");

  const second = mergeBlockedKeywords(first.blockedKeywords, ENGLISH_ECONOMICS_PACK);
  assert.deepEqual(second.added, []);
  assert.equal(second.blockedKeywords.length, first.blockedKeywords.length);
});

test("mergeBlockedKeywords ignores letter variants and blanks", () => {
  const result = mergeBlockedKeywords(["فوتبال"], {
    ...ENGLISH_ECONOMICS_PACK,
    blockedKeywords: ["فوتبال", "  ", "فوتبال"],
  });
  assert.deepEqual(result.added, []);
});

test("english economics pack covers core analytical economics keywords and sources", () => {
  const allKeywords = ENGLISH_ECONOMICS_PACK.topics.flatMap((topic) => topic.keywords);
  for (const key of ["monetary policy", "inflation", "fiscal policy", "international trade", "imf", "productivity"]) {
    assert.ok(allKeywords.includes(key), `expected keyword "${key}" in pack`);
  }
  const sourceHosts = ENGLISH_ECONOMICS_PACK.sources.map((s) => new URL(s.url).hostname);
  assert.ok(sourceHosts.some((h) => h.includes("imf.org")));
  assert.ok(sourceHosts.some((h) => h.includes("project-syndicate.org")));
  assert.ok(sourceHosts.some((h) => h.includes("cepr.org")));
});
