import assert from "node:assert/strict";
import test from "node:test";

import { buildNewsMessage } from "../src/lib/delivery/message.ts";

const row = (overrides) => ({
  title: "انتشار رتبه‌بندی اعتباری شرکت‌های بزرگ",
  summary: "خلاصه آزمایشی برای پیام.",
  whyItMatters: null,
  category: "اقتصاد",
  importanceScore: 80,
  url: "https://example.com/news/1",
  ...overrides,
});

test("buildNewsMessage: 'why it matters' block appears after the summary when set", () => {
  const text = buildNewsMessage(row({ whyItMatters: "به سبد اعتباری بانک‌ها مربوط است." }));
  const summaryAt = text.indexOf("خلاصه:");
  const whyAt = text.indexOf("چرا مهم است:");
  assert.ok(summaryAt >= 0);
  assert.ok(whyAt > summaryAt);
  assert.ok(text.includes("به سبد اعتباری بانک‌ها مربوط است."));
  // The block must stay above the category section.
  assert.ok(whyAt < text.indexOf("دسته:"));
});

test("buildNewsMessage: no empty block when the field is missing or blank", () => {
  assert.ok(!buildNewsMessage(row({})).includes("چرا مهم است:"));
  assert.ok(!buildNewsMessage(row({ whyItMatters: "   " })).includes("چرا مهم است:"));
});

test("buildNewsMessage: long explanations are compacted, not dumped raw", () => {
  const text = buildNewsMessage(row({ whyItMatters: "مهم ".repeat(200) }));
  const line = text.split("\n").find((entry) => entry.startsWith("مهم"));
  assert.ok(line.length < 320);
});

test("buildNewsMessage: multi-source story lists every outlet with its link", () => {
  const text = buildNewsMessage(row({ source: "ایرنا", url: "https://irna.example/x" }), {
    corroborationItems: [
      { source: "ایسنا", url: "https://isna.example/y" },
      { source: "مهر", url: "https://mehr.example/z" },
    ],
  });
  const blockAt = text.indexOf("منابع این خبر (۳):");
  assert.ok(blockAt > 0);
  assert.ok(text.includes("• [ایرنا (انتخاب‌شده)](https://irna.example/x)"));
  assert.ok(text.includes("• [ایسنا](https://isna.example/y)"));
  assert.ok(text.includes("• [مهر](https://mehr.example/z)"));
  // The report still ends with the canonical «لینک اصلی خبر» hyperlink.
  const lines = text.split("\n");
  assert.equal(lines[lines.length - 1], "[لینک اصلی خبر](https://irna.example/x)");
  assert.ok(!text.includes("🔗 منبع:"));
});

test("buildNewsMessage: single-source story keeps the classic footer", () => {
  const text = buildNewsMessage(row({ url: "https://example.com/news/1" }));
  // Footer: the label «لینک اصلی خبر» is the hyperlink to the original URL.
  const lines = text.split("\n");
  assert.equal(lines[lines.length - 1], "[لینک اصلی خبر](https://example.com/news/1)");
  assert.ok(!text.includes("🔗 منبع:"));
  assert.ok(!text.includes("منابع این خبر"));
});
