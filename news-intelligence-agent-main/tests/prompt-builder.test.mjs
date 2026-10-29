import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_AUDIENCE_FOCUS, buildAIAnalysisPrompt, describeTopicFocus } from "../src/lib/ai/prompt-builder.ts";

const features = {
  summary: { enabled: true, instruction: "خلاصه بنویس." },
  shouldSend: { enabled: true, instruction: "توصیه ارسال بده." },
};

const decisionRules = (overrides = {}) => ({
  minImportanceToSend: 70,
  minRelevanceToSend: 70,
  minNoveltyToSend: 0,
  overallSendThreshold: 70,
  enableAutoRecommendation: true,
  ...overrides,
});

const config = (overrides = {}) => ({
  systemPrompt: "تحلیلگر خبری.",
  features,
  decisionRules: decisionRules(),
  outputSchema: [
    { name: "summary", enabled: true, description: "خلاصه", required: true, type: "string" },
    { name: "shouldSend", enabled: true, description: "ارسال", required: true, type: "boolean" },
  ],
  topicFilter: null,
  ...overrides,
});

const article = {
  title: "خبر آزمایشی",
  description: "متن",
  source: "تست",
  publishedAt: null,
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
        topics: [{ id: "t1", label: "اعتبارسنجی", enabled: true, keywords: ["رتبه‌بندی اعتباری"] }],
        blockedKeywords: ["ورزش", "سرگرمی"],
      },
    }),
    article,
  );
  assert.match(systemPrompt, /اعتبارسنجی/);
  assert.match(systemPrompt, /کلیدواژه‌های ممنوع/);
  assert.match(systemPrompt, /ورزش/);
});

test("the user prompt carries the article content", () => {
  const { userPrompt } = buildAIAnalysisPrompt(config(), article);
  assert.match(userPrompt, /خبر آزمایشی/);
  assert.match(userPrompt, /منبع: تست/);
});

test("only enabled features appear in the output contract", () => {
  const { systemPrompt, enabledFields } = buildAIAnalysisPrompt(config(), article);
  assert.deepEqual(enabledFields, ["summary", "shouldSend"]);
  assert.match(systemPrompt, /"summary"/);
  assert.match(systemPrompt, /"shouldSend"/);
  assert.doesNotMatch(systemPrompt, /"importance"/);
});

// ── Audience focus & relevance anchor ─────────────────────────────────────────

test("default audience focus anchors relevance to the credit-rating audience", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(config(), article);
  assert.ok(systemPrompt.includes("تعریف مخاطب و ملاک امتیاز مرتبط بودن"));
  assert.ok(systemPrompt.includes(DEFAULT_AUDIENCE_FOCUS));
  assert.ok(systemPrompt.includes("شرکت اعتبارسنجی"));
  // Disambiguation: government budget allocation / Kalabarg / road & bridge is NOT credit rating.
  assert.ok(systemPrompt.includes("تخصیص اعتبار کالابرگ"));
  assert.ok(systemPrompt.includes("تخصیص اعتبار ساخت جاده و پل"));
  // Hard rules: importance never compensates for low relevance.
  assert.ok(systemPrompt.includes("relevance زیر ۳۰"));
  assert.ok(systemPrompt.includes("باید relevance پایین و shouldSend=false بگیرد") || systemPrompt.includes("shouldSend=false بگیرد"));
});

test("custom audience focus replaces the default", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(
    config({ audienceFocus: "مخاطب هدف، تحلیلگران بازار سرمایه هستند." }),
    article,
  );
  assert.ok(systemPrompt.includes("مخاطب هدف، تحلیلگران بازار سرمایه هستند."));
  assert.ok(!systemPrompt.includes(DEFAULT_AUDIENCE_FOCUS));
  // The hard relevance rules are present for every audience.
  assert.ok(systemPrompt.includes("قوانین قطعی امتیاز مرتبط بودن"));
});

test("blank audience focus falls back to the default", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(config({ audienceFocus: "   " }), article);
  assert.ok(systemPrompt.includes(DEFAULT_AUDIENCE_FOCUS));
});

test("baseline deny-list keywords are described in the prompt when passed in", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(config(), article, {
    baselineBlockedKeywords: ["ورزش", "حوادث"],
  });
  assert.ok(systemPrompt.includes("کلیدواژه‌های ممنوع همیشگی"));
  assert.ok(systemPrompt.includes("ورزش، حوادث"));
});

test("prompt without any topic focus omits the topic section but keeps the audience block", () => {
  const { systemPrompt } = buildAIAnalysisPrompt(config(), article);
  assert.ok(!systemPrompt.includes("تمرکز موضوعی فعلی سامانه"));
  assert.ok(systemPrompt.includes("تعریف مخاطب و ملاک امتیاز مرتبط بودن"));
});

test("describeTopicFocus combines baseline and config deny-lists", () => {
  const text = describeTopicFocus(
    { enabled: true, mode: "include", topics: [], blockedKeywords: ["قیمت ارز"] },
    ["ورزش"],
  );
  assert.ok(text.includes("کلیدواژه‌های ممنوع همیشگی"));
  assert.ok(text.includes("ورزش"));
  assert.ok(text.includes("قیمت ارز"));
});
