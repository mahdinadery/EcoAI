import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeWhyItMatters } from "../src/lib/ai/why-guard.ts";
import {
  DEFAULT_FEATURES,
  LEGACY_WHY_IT_MATTERS_INSTRUCTION,
  WHY_IT_MATTERS_DEFAULT_INSTRUCTION,
  upgradeLegacyWhyItMattersInstruction,
} from "../src/lib/ai/config-types.ts";
import { buildNewsMessage, stripEmptyLabelBlocks } from "../src/lib/delivery/message.ts";

const row = (overrides = {}) => ({
  title: "انتشار رتبه‌بندی اعتباری شرکت‌های بزرگ",
  summary: "خلاصه آزمایشی برای پیام.",
  whyItMatters: null,
  category: "اقتصاد",
  importanceScore: 80,
  url: "https://example.com/news/1",
  ...overrides,
});

// ── sanitizeWhyItMatters ────────────────────────────────────────────────────

test("rejects the exact legacy canned phrase (with and without period)", () => {
  assert.equal(sanitizeWhyItMatters("برای مخاطب هدف اهمیت مشخصی ندارد"), null);
  assert.equal(sanitizeWhyItMatters("برای مخاطب هدف اهمیت مشخصی ندارد."), null);
  assert.equal(sanitizeWhyItMatters("  برای مخاطب هدف اهمیت مشخصی ندارد.  "), null);
});

test("rejects close boilerplate/negation variants", () => {
  assert.equal(sanitizeWhyItMatters("این خبر اهمیت خاصی ندارد."), null);
  assert.equal(sanitizeWhyItMatters("به نظر مهم نیست و تأثیری ندارد."), null);
  assert.equal(sanitizeWhyItMatters("این مورد بدون اهمیت است برای مخاطبان ما."), null);
});

test("rejects empty, tiny and placeholder garbage", () => {
  assert.equal(sanitizeWhyItMatters(null), null);
  assert.equal(sanitizeWhyItMatters(42), null);
  assert.equal(sanitizeWhyItMatters(""), null);
  assert.equal(sanitizeWhyItMatters("   "), null);
  assert.equal(sanitizeWhyItMatters("ندارد"), null);
  assert.equal(sanitizeWhyItMatters("—"), null);
  assert.equal(sanitizeWhyItMatters("-"), null);
  assert.equal(sanitizeWhyItMatters("خیلی کوتاه"), null); // < 12 chars
});

test("keeps a concrete one-liner, trimmed and whitespace-collapsed", () => {
  assert.equal(
    sanitizeWhyItMatters("  افزایش   نقدینگی، هزینهٔ تأمین مالی بانک‌ها و ریسک اعتباری مشتریان را تحت تأثیر می‌گذارد.  "),
    "افزایش نقدینگی، هزینهٔ تأمین مالی بانک‌ها و ریسک اعتباری مشتریان را تحت تأثیر می‌گذارد.",
  );
});

// ── legacy instruction upgrade ──────────────────────────────────────────────

test("legacy instruction is upgraded to the fixed default, verbatim match only", () => {
  const upgraded = upgradeLegacyWhyItMattersInstruction(LEGACY_WHY_IT_MATTERS_INSTRUCTION);
  assert.equal(upgraded, WHY_IT_MATTERS_DEFAULT_INSTRUCTION);
  assert.equal(DEFAULT_FEATURES.whyItMatters.instruction, WHY_IT_MATTERS_DEFAULT_INSTRUCTION);
  // The new text must demand concrete reasons and forbid the canned filler.
  assert.match(upgraded, /هرگز/);
  assert.notEqual(upgraded, LEGACY_WHY_IT_MATTERS_INSTRUCTION);
});

test("operator-customized instructions are never overwritten", () => {
  const custom = "دستور سفارشی مدیر — متن دلخواه.";
  assert.equal(upgradeLegacyWhyItMattersInstruction(custom), custom);
  assert.equal(upgradeLegacyWhyItMattersInstruction(` ${custom} `), ` ${custom} `);
});

// ── stripEmptyLabelBlocks ───────────────────────────────────────────────────

test("drops label lines whose value is empty or «—», keeps real values", () => {
  const text = ["خلاصه:", "متن خلاصه.", "", "چرا مهم است:", "", "رویداد اصلی:", "—", "", "اهمیت: ۸۰ از ۱۰۰"].join("\n");
  const cleaned = stripEmptyLabelBlocks(text);
  assert.ok(!cleaned.includes("چرا مهم است:"));
  assert.ok(!cleaned.includes("رویداد اصلی:"));
  assert.ok(cleaned.includes("خلاصه:"));
  assert.ok(cleaned.includes("متن خلاصه."));
  assert.ok(cleaned.includes("اهمیت: ۸۰ از ۱۰۰"));
});

test("inline labels with values survive; colon-ending prose lines are untouched", () => {
  const text = ["منبع: ایرنا", "چرا مهم است: اثر مستقیم بر نقدینگی بانک‌ها.", "جمله بدون برچسب:"].join("\n");
  const cleaned = stripEmptyLabelBlocks(text);
  assert.ok(cleaned.includes("منبع: ایرنا"));
  assert.ok(cleaned.includes("اثر مستقیم بر نقدینگی بانک‌ها."));
  // A trailing bare label at end-of-text has no value → dropped.
  assert.ok(!cleaned.includes("جمله بدون برچسب:"));
});

// ── buildNewsMessage display guard (legacy rows) ────────────────────────────

test("canned filler in a legacy row never reaches the message", () => {
  const text = buildNewsMessage(row({ whyItMatters: "برای مخاطب هدف اهمیت مشخصی ندارد" }));
  assert.ok(!text.includes("اهمیت مشخصی ندارد"));
  assert.ok(!text.includes("چرا مهم است:"));
});

test("a real why still renders after the summary", () => {
  const text = buildNewsMessage(row({ whyItMatters: "فشار بر نقدینگی بانک‌ها را بیشتر می‌کند." }));
  assert.ok(text.includes("چرا مهم است:"));
  assert.ok(text.includes("فشار بر نقدینگی بانک‌ها را بیشتر می‌کند."));
});
