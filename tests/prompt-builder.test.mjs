import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_AUDIENCE_FOCUS, buildAIAnalysisPrompt, describeTopicFocus } from "../src/lib/ai/prompt-builder.ts";

const features = {
  translatedTitle: { enabled: true, instruction: "ترجمه فارسی عنوان." },
  summary: { enabled: true, instruction: "خلاصه تحلیلی بنویس." },
  shouldSend: { enabled: true, instruction: "توصیه ارسال بده." },
};

const decisionRules = (overrides = {}) => ({
  minImportanceToSend: 65,
  minRelevanceToSend: 70,
  minNoveltyToSend: 0,
  overallSendThreshold: 70,
  enableAutoRecommendation: true,
  ...overrides,
});

const config = (overrides = {}) => ({
  systemPrompt: "تحلیلگر و مترجم اقتصادی.",
  features,
  decisionRules: decisionRules(),
  outputSchema: [
    { name: "translatedTitle", enabled: true, description: "ترجمه عنوان", required: true, type: "string" },
    { name: "summary", enabled: true, description: "خلاصه", required: true, type: "string" },
    { name: "shouldSend", enabled: true, description: "ارسال", required: true, type: "boolean" },
  ],
  topicFilter: null,
  ...overrides,
});

const article = {
  title: "Why Higher Neutral Interest Rates Are Reshaping Global Fiscal Policy",
  description: "Structural shifts in demographics and investment are lifting r-star.",
  source: "IMF Blog",
  publishedAt: "2026-10-28T10:00:00Z",
};

test("decision rules default to AND (importance AND relevance)", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(config(), article);
  assert.match(systemPrompt, /هم‌زمان برقرار باشند \(منطق AND\)/);
  assert.match(systemPrompt, /اهمیت بالا هرگز جای مرتبط بودن پایین/);
  assert.doesNotMatch(systemPrompt, /حداقل یکی از این شرایط/);
});

test("legacy OR mode is explicit when configured", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(
    config({ decisionRules: decisionRules({ combine: "any" }) }),
    article,
  );
  assert.match(systemPrompt, /منطق OR/);
  assert.doesNotMatch(systemPrompt, /\(منطق AND\)/);
});

test("novelty is only mentioned when a threshold above zero is set", () => {
  const withoutNovelty = buildAIAnalysisPrompt(config(), article).systemPrompt;
  assert.doesNotMatch(withoutNovelty, /تازگی \(novelty\) >=/);

  const withNovelty = buildAIAnalysisPrompt(
    config({ decisionRules: decisionRules({ minNoveltyToSend: 40 }) }),
    article,
  ).systemPrompt;
  assert.match(withNovelty, /تازگی \(novelty\) >= 40/);
});

test("disabled auto recommendation forces shouldSend=false", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(
    config({ decisionRules: decisionRules({ enableAutoRecommendation: false }) }),
    article,
  );
  assert.match(systemPrompt, /همیشه false/);
});

test("the topic focus and deny-list are injected into the prompt", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(
    config({
      topicFilter: {
        enabled: true,
        mode: "include",
        topics: [{ id: "t1", label: "سیاست پولی", enabled: true, keywords: ["monetary policy", "inflation"] }],
        blockedKeywords: ["ورزش", "celebrity gossip"],
      },
    }),
    article,
  );
  assert.match(systemPrompt, /سیاست پولی/);
  assert.match(systemPrompt, /monetary policy/);
  assert.match(systemPrompt, /کلیدواژه‌های ممنوع/);
  assert.match(systemPrompt, /ورزش/);
});

test("the user prompt carries the English article title, source, and full content when provided", () => {
  const { userPrompt } = buildAIAnalysisPrompt(config(), {
    ...article,
    content: "Full multi-paragraph economic analysis on neutral interest rates and debt dynamics.",
  });
  assert.match(userPrompt, /Why Higher Neutral Interest Rates/);
  assert.match(userPrompt, /منبع: IMF Blog/);
  assert.match(userPrompt, /چکیده فید:/);
  assert.match(userPrompt, /متن مقاله:/);
  assert.match(userPrompt, /Full multi-paragraph economic analysis/);
});

test("only enabled features appear in the output contract", () => {
  const { systemPrompt, enabledFields } = buildAIAnalysisPrompt(config(), article);
  assert.deepEqual(enabledFields, ["translatedTitle", "summary", "shouldSend"]);
  assert.match(systemPrompt, /"translatedTitle"/);
  assert.match(systemPrompt, /"summary"/);
  assert.match(systemPrompt, /"shouldSend"/);
  assert.doesNotMatch(systemPrompt, /"importance"/);
});

test("default audience focus anchors relevance to analytical economics & English research", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(config(), article);
  assert.ok(systemPrompt.includes("تعریف مخاطب و ملاک امتیاز مرتبط بودن"));
  assert.ok(systemPrompt.includes(DEFAULT_AUDIENCE_FOCUS));
  assert.ok(systemPrompt.includes("اقتصاددانان"));
  assert.ok(systemPrompt.includes("سیاست پولی"));
  assert.ok(systemPrompt.includes("IMF"));
  assert.ok(systemPrompt.includes("relevance زیر ۳۰"));
  assert.ok(systemPrompt.includes("shouldSend=false"));
});

test("custom audience focus replaces the default", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(
    config({ audienceFocus: "مخاطب هدف، پژوهشگران تجارت بین‌الملل هستند." }),
    article,
  );
  assert.ok(systemPrompt.includes("مخاطب هدف، پژوهشگران تجارت بین‌الملل هستند."));
  assert.ok(!systemPrompt.includes(DEFAULT_AUDIENCE_FOCUS));
  assert.ok(systemPrompt.includes("قوانین قطعی امتیاز مرتبط بودن"));
});

test("blank audience focus falls back to the default", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(config({ audienceFocus: "   " }), article);
  assert.ok(systemPrompt.includes(DEFAULT_AUDIENCE_FOCUS));
});

test("baseline deny-list keywords are described in the prompt when passed in", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(config(), article, {
    baselineBlockedKeywords: ["nfl", "ورزش", "حوادث"],
  });
  assert.ok(systemPrompt.includes("کلیدواژه‌های ممنوع همیشگی"));
  assert.ok(systemPrompt.includes("nfl، ورزش، حوادث"));
});

test("prompt without any topic focus omits the topic section but keeps the audience block", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(config(), article);
  assert.ok(!systemPrompt.includes("تمرکز موضوعی فعلی سامانه"));
  assert.ok(systemPrompt.includes("تعریف مخاطب و ملاک امتیاز مرتبط بودن"));
});

test("describeTopicFocus combines baseline and config deny-lists", () => {
  const text = describeTopicFocus(
    { enabled: true, mode: "include", topics: [], blockedKeywords: ["horoscope"] },
    ["ورزش"],
  );
  assert.ok(text.includes("کلیدواژه‌های ممنوع همیشگی"));
  assert.ok(text.includes("ورزش"));
  assert.ok(text.includes("horoscope"));
});
