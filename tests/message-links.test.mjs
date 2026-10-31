import assert from "node:assert/strict";
import test from "node:test";

import { buildNewsMessage, escapeMd, mdLink } from "../src/lib/delivery/message.ts";
import { buildBulletinMessage } from "../src/lib/delivery/bulletin.ts";
import { upgradeLegacyTemplateFooter } from "../src/lib/ai/config-types.ts";

const URL = "https://www.eghtesadonline.com/fa/news/2168992/رکود-اقتصاد";

const row = (overrides = {}) => ({
  title: "رکود اقتصاد ایران ۱۸ ماهه شد",
  summary: "خلاصه آزمایشی برای پیام.",
  whyItMatters: "اثر مستقیم بر ترازنامه بانک‌ها دارد.",
  category: "اقتصاد",
  importanceScore: 80,
  source: "ایسنا",
  url: URL,
  ...overrides,
});

test("mdLink builds a markdown hyperlink and escapes markup in the label", () => {
  assert.equal(mdLink("عنوان ساده", "https://x.example/a"), "[عنوان ساده](https://x.example/a)");
  assert.equal(mdLink("الف [و] _ب_", "https://x.example/a"), "[الف \\[و\\] \\_ب\\_](https://x.example/a)");
  assert.equal(mdLink("متن", "https://x.example/a b(c)"), "[متن](https://x.example/a%20b%28c%29)");
});

test("escapeMd escapes every markdown control character", () => {
  assert.equal(escapeMd("a_b*c[d]e`f\\g"), "a\\_b\\*c\\[d\\]e\\`f\\\\g");
});

test("the report ends with «لینک اصلی خبر» hyperlinked to the original URL", () => {
  const text = buildNewsMessage(row());
  const lines = text.split("\n");
  assert.equal(lines[lines.length - 1], `[لینک اصلی خبر](${URL})`, "footer label must be the hyperlink");
  // The old «منبع» footer is gone; the title stays plain text (not a link).
  assert.ok(!text.includes("🔗 منبع:"));
  assert.ok(!text.includes("منبع"));
  assert.ok(text.includes("\nرکود اقتصاد ایران ۱۸ ماهه شد\n"), "title is plain");
  assert.ok(!text.includes(`[رکود اقتصاد ایران`), "title must NOT be a hyperlink");
});

test("multi-source: outlet names are hyperlinks and the report still ends with «لینک اصلی خبر»", () => {
  const other = "https://other.example/x";
  const text = buildNewsMessage(row(), { corroborationItems: [{ source: "مهر", url: other }] });
  assert.ok(text.includes(`• [ایسنا (انتخاب‌شده)](${URL})`));
  assert.ok(text.includes(`• [مهر](${other})`));
  const lines = text.split("\n");
  assert.equal(lines[lines.length - 1], `[لینک اصلی خبر](${URL})`);
});

test("a title with markdown characters renders as escaped plain text", () => {
  const text = buildNewsMessage(row({ title: "گزارش [ماهانه] _شاخص_ بانک‌ها" }));
  assert.ok(text.includes("گزارش \\[ماهانه\\] \\_شاخص\\_ بانک‌ها"));
  assert.ok(!text.includes("[گزارش"));
});

test("bulletin items end with «لینک اصلی خبر» and keep plain titles", () => {
  const text = buildBulletinMessage({
    intro: null,
    items: [
      {
        id: "1",
        title: "خبر آزمایشی مهم",
        oneLiner: "توضیح کوتاه.",
        whyItMatters: "اثر مستقیم بر نقدینگی بانک‌ها.",
        url: URL,
        importanceScore: 85,
        publishedAt: new Date("2026-10-18T10:00:00.000Z"),
      },
    ],
    generatedAt: new Date("2026-10-19T10:00:00.000Z"),
    timezone: "Asia/Tehran",
  });
  assert.ok(text.includes("1️⃣ خبر آزمایشی مهم"), "bulletin title is plain");
  assert.ok(text.includes(`[لینک اصلی خبر](${URL})`));
  assert.ok(!text.includes("🔗"));
});

test("legacy template footer «منبع: {sourceName} + {originalUrl}» migrates to the link line", () => {
  const legacy = "{title}\n{summary}\n\nمنبع: {sourceName}\n{originalUrl}\n#{category}";
  assert.equal(
    upgradeLegacyTemplateFooter(legacy),
    "{title}\n{summary}\n\n{originalUrl}\n#{category}",
  );
  // Operator-customized templates without the exact pair stay untouched.
  const custom = "{title}\n\nمنبع: {sourceName}";
  assert.equal(upgradeLegacyTemplateFooter(custom), custom);
});

test("no short links anywhere", () => {
  assert.ok(!buildNewsMessage(row()).includes("/s/"));
});

test('hashtag underscores stay readable while ordinary Markdown is escaped', async () => {
  const { escapeMd } = await import('../src/lib/delivery/message.ts');
  assert.equal(escapeMd('#بازار_سهام #نقدینگی'), '#بازار_سهام #نقدینگی');
  assert.equal(escapeMd('#بازار\\_سهام'), '#بازار_سهام');
  assert.equal(escapeMd('ordinary_name *text*'), 'ordinary\\_name \\*text\\*');
});
