import assert from "node:assert/strict";
import test from "node:test";

import {
  describeRule,
  evaluateArticle,
  loadAutoSendRule,
  policyToRule,
} from "../src/lib/agent/rules.ts";

const rule = (overrides) => ({
  enabled: true,
  destination: "local",
  minImportance: 50,
  minRelevance: 50,
  minNovelty: 0,
  requireAiRecommendation: false,
  categories: null,
  maxItemsPerPass: 20,
  ...overrides,
});

const article = (overrides) => ({
  id: "a1",
  title: "خبر",
  analyzedAt: new Date(),
  summary: "خلاصه",
  importanceScore: 60,
  relevanceScore: 60,
  noveltyScore: 40,
  shouldSend: false,
  category: "اقتصاد",
  ...overrides,
});

test("unanalyzed articles never match", () => {
  const check = evaluateArticle(article({ analyzedAt: null }), rule());
  assert.equal(check.matches, false);
  assert.deepEqual(check.reasons, ["not_analyzed"]);
});

test("articles meeting thresholds match", () => {
  const check = evaluateArticle(article(), rule());
  assert.equal(check.matches, true);
});

test("low scores fail with explicit reasons", () => {
  const check = evaluateArticle(article({ importanceScore: 10, relevanceScore: 10 }), rule());
  assert.equal(check.matches, false);
  assert.ok(check.reasons.includes("importance_below_threshold"));
  assert.ok(check.reasons.includes("relevance_below_threshold"));
});

test("an AI recommendation can never bypass the score thresholds", () => {
  // Regression: this used to pass through a `shouldSend === true && importance >= 40`
  // shortcut, which is how important-but-irrelevant news reached the channel.
  const check = evaluateArticle(
    article({ importanceScore: 45, relevanceScore: 10, noveltyScore: 5, shouldSend: true }),
    rule(),
  );
  assert.equal(check.matches, false);
  assert.ok(check.reasons.includes("relevance_below_threshold"));
});

test("importance alone is not enough — relevance must pass too", () => {
  const check = evaluateArticle(article({ importanceScore: 95, relevanceScore: 20 }), rule());
  assert.equal(check.matches, false);
  assert.deepEqual(check.reasons, ["relevance_below_threshold"]);
});

test("relevance alone is not enough — importance must pass too", () => {
  const check = evaluateArticle(article({ importanceScore: 20, relevanceScore: 95 }), rule());
  assert.equal(check.matches, false);
  assert.deepEqual(check.reasons, ["importance_below_threshold"]);
});

test("all score reasons are reported at once so thresholds can be tuned", () => {
  const check = evaluateArticle(
    article({ importanceScore: 30, relevanceScore: 40, noveltyScore: 5 }),
    rule({ minImportance: 50, minRelevance: 60, minNovelty: 10 }),
  );
  assert.deepEqual(check.reasons, [
    "importance_below_threshold",
    "relevance_below_threshold",
    "novelty_below_threshold",
  ]);
});

test("requireAiRecommendation blocks when AI said no", () => {
  const check = evaluateArticle(article({ shouldSend: false }), rule({ requireAiRecommendation: true }));
  assert.equal(check.matches, false);
  assert.ok(check.reasons.includes("ai_no_recommendation"));
});

test("category allow-list filters articles", () => {
  const check = evaluateArticle(article({ category: "ورزش" }), rule({ categories: ["اقتصاد", "بازار"] }));
  assert.equal(check.matches, false);
  assert.ok(check.reasons.includes("category_excluded"));
});

test("novelty threshold is enforced when configured", () => {
  const check = evaluateArticle(article({ noveltyScore: 5 }), rule({ minNovelty: 30 }));
  assert.equal(check.matches, false);
  assert.ok(check.reasons.includes("novelty_below_threshold"));
});

test("loadAutoSendRule reads env with safe defaults", () => {
  const saved = { ...process.env };
  try {
    delete process.env.AUTO_SEND_MIN_IMPORTANCE;
    delete process.env.AUTO_SEND_DESTINATION;
    process.env.AUTO_SEND_MIN_IMPORTANCE = "80";
    process.env.AUTO_SEND_DESTINATION = "bale";

    const loaded = loadAutoSendRule();
    assert.equal(loaded.minImportance, 80);
    assert.equal(loaded.destination, "bale");
    // untouched knobs keep defaults
    assert.equal(loaded.minRelevance, 50);
    assert.equal(loaded.maxItemsPerPass, 20);
    assert.equal(loaded.enabled, true);
  } finally {
    process.env = saved;
  }
});

test("loadAutoSendRule clamps invalid env values", () => {
  const saved = { ...process.env };
  try {
    process.env.AUTO_SEND_MIN_IMPORTANCE = "999";
    process.env.AUTO_SEND_MAX_ITEMS = "-3";
    process.env.AUTO_SEND_DESTINATION = "somewhere";
    const loaded = loadAutoSendRule();
    assert.equal(loaded.minImportance, 100);
    assert.equal(loaded.maxItemsPerPass, 20);
    assert.equal(loaded.destination, "local");
  } finally {
    process.env = saved;
  }
});

test("policyToRule maps dashboard policy and clamps values", () => {
  const mapped = policyToRule({
    useCustom: true,
    enabled: true,
    destination: "both",
    minImportance: 150,
    minRelevance: -5,
    minNovelty: 20,
    requireAiRecommendation: true,
    categories: [],
    maxItemsPerPass: 1000,
  });

  assert.equal(mapped.destination, "both");
  assert.equal(mapped.minImportance, 100);
  assert.equal(mapped.minRelevance, 0);
  assert.equal(mapped.minNovelty, 20);
  assert.equal(mapped.requireAiRecommendation, true);
  assert.equal(mapped.categories, null); // empty list => unrestricted
  assert.equal(mapped.maxItemsPerPass, 100);
});

test("describeRule renders policy summary", () => {
  const lines = describeRule(rule({ categories: ["اقتصاد"], minNovelty: 10, requireAiRecommendation: true }));
  assert.ok(lines.some((line) => line.includes("روشن")));
  assert.ok(lines.some((line) => line.includes("اقتصاد")));
  assert.ok(lines.some((line) => line.includes("shouldSend")));
  assert.ok(lines.some((line) => line.includes("AND")));
});
