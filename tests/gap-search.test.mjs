import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NEWS_SEARCH_URL_TEMPLATE,
  buildSearchUrl,
  dedupeByCanonical,
  deriveGapQueries,
} from "../src/lib/news/gap-search.ts";

test("deriveGapQueries: manual queries override the derived ones", () => {
  assert.deepEqual(deriveGapQueries(["رتبه‌بندی", "اعتبارسنجی"], ["بورس تهران"]), ["بورس تهران"]);
});

test("deriveGapQueries: longer (more specific) keywords come first", () => {
  const queries = deriveGapQueries(["ریسک", "سلامت مالی شرکت‌ها", "اعتبار"], null);
  assert.equal(queries[0], "سلامت مالی شرکت‌ها");
});

test("deriveGapQueries: caps at max and drops tiny/empty keywords", () => {
  const queries = deriveGapQueries(["", " الف ", "دو", "سه", "چهار", "پنج", "شش", "هفت"], null, 3);
  assert.equal(queries.length, 3);
  assert.ok(queries.every((query) => query.length >= 2));
});

test("deriveGapQueries: case-insensitive dedupe", () => {
  assert.deepEqual(deriveGapQueries(["Bale", "bale", "BALE"], null), ["Bale"]);
});

test("deriveGapQueries: empty everything => empty list", () => {
  assert.deepEqual(deriveGapQueries([], ["", "   "]), []);
});

test("buildSearchUrl: default provider is Bing News RSS with encoded query", () => {
  const url = buildSearchUrl("رتبه‌بندی اعتباری");
  assert.ok(url.startsWith("https://www.bing.com/news/search?q="));
  assert.ok(url.endsWith("&format=rss"));
  assert.ok(url.includes(encodeURIComponent("رتبه‌بندی اعتباری")));
  assert.equal(url, buildSearchUrl("رتبه‌بندی اعتباری", DEFAULT_NEWS_SEARCH_URL_TEMPLATE));
});

test("buildSearchUrl: custom template replaces {query} and encodes", () => {
  const url = buildSearchUrl("a b", "https://example.com/rss?q={query}");
  assert.equal(url, "https://example.com/rss?q=a%20b");
});

test("buildSearchUrl: template without {query} falls back to the default", () => {
  const url = buildSearchUrl("x", "https://example.com/no-placeholder");
  assert.ok(url.startsWith("https://www.bing.com/news/search?q=x"));
});

test("dedupeByCanonical: drops known and repeated URLs, keeps fresh ones", () => {
  const existing = new Set(["https://a.example/x"]);
  const items = [
    { url: "https://a.example/x" },
    { url: "https://b.example/y" },
    { url: "https://c.example/z" },
    { url: "https://b.example/y?utm_source=feed" },
  ];
  const canonicalOf = (item) => item.url.split("?")[0];
  const { fresh, duplicates } = dedupeByCanonical(items, canonicalOf, existing);
  assert.deepEqual(
    fresh.map((item) => item.url),
    ["https://b.example/y", "https://c.example/z"],
  );
  assert.equal(duplicates.length, 2);
});
