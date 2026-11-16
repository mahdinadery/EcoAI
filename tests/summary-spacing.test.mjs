import assert from "node:assert/strict";
import test from "node:test";

import { buildNewsMessage, separateSummarySections } from "../src/lib/delivery/message.ts";

const RESEARCH =
  "❓ پرسش پژوهش: آیا هدف شرکت‌ها بهره‌وری است یا کاهش هزینهٔ دستمزد؟ " +
  "📊 داده‌ها: داده‌های ACS و ۴۹ صنعت در بازهٔ ۱۹۸۰ تا ۲۰۱۶. " +
  "🔬 روش: تحلیل تجربی اثرات اتوماسیون بر گروه‌های جمعیتی. " +
  "📈 نتایج: اتوماسیون مسئول ۵۲ درصد از رشد نابرابری درآمدی است.";

const ANALYTICAL =
  "❓ مسئلهٔ محوری: شناسایی راهکارهای AI برای کاهش فقر. " +
  "⚙️ سازوکار اقتصادی: اتصال دولت‌ها و شرکت‌ها به اقتصاددانان. " +
  "📈 جمع‌بندی و نتایج: تخصیص بودجه به هشت مطالعهٔ اولیه.";

test("one glued paragraph becomes one paragraph per section (the reported bug)", () => {
  const out = separateSummarySections(RESEARCH);
  const blocks = out.split("\n\n");
  assert.equal(blocks.length, 4);
  assert.ok(blocks[0].startsWith("❓"), blocks[0].slice(0, 30));
  assert.ok(blocks[1].startsWith("📊"));
  assert.ok(blocks[2].startsWith("🔬"));
  assert.ok(blocks[3].startsWith("📈"));
  // Nothing was added or lost — only whitespace changed.
  assert.equal(out.replace(/\s+/g, " ").trim(), RESEARCH.replace(/\s+/g, " ").trim());
});

test("the analytical shape gets the same treatment", () => {
  const blocks = separateSummarySections(ANALYTICAL).split("\n\n");
  assert.equal(blocks.length, 3);
  assert.ok(blocks[1].startsWith("⚙️"));
});

test("sections already on consecutive lines get a blank line between them", () => {
  const stacked = "❓ پرسش: متن اول\n📊 داده‌ها: متن دوم\n📈 نتایج: متن سوم";
  assert.equal(separateSummarySections(stacked), "❓ پرسش: متن اول\n\n📊 داده‌ها: متن دوم\n\n📈 نتایج: متن سوم");
});

test("spacing is already correct or idempotent — never doubled", () => {
  for (const input of [RESEARCH, ANALYTICAL, "❓ الف: ۱\n\n📈 ب: ۲"]) {
    const once = separateSummarySections(input);
    assert.equal(separateSummarySections(once), once, "second run must be a no-op");
    assert.equal(once.includes("\n\n\n"), false, "no triple newlines");
  }
});

test("everything that is not a labeled summary is left alone", () => {
  const prose =
    "این یک خلاصهٔ معمولی است که در دو جمله نوشته شده و هیچ برچسب بخش‌بندی ندارد. " +
    "ادامهٔ همان متن با یک ارجاع به «۵۲ درصد» و بدون هیچ ایموجیِ بخش.";
  assert.equal(separateSummarySections(prose), prose);

  // A single marker is one section — splitting a sentence on it would be wrong.
  const one = "متن پیش از نشان ❓ که نباید از هم بپاشد.";
  assert.equal(separateSummarySections(one), one);

  // An emoji inside the prose (not at a line start) is not a section either.
  const inline = "📈 نتایج: نکتهٔ اول با یک 📊 داخل جمله ادامه دارد.\n🔬 روش: روش آزمایش.";
  const parts = separateSummarySections(inline).split("\n\n");
  assert.equal(parts.length, 2);
  assert.ok(parts[0].includes("📊 داخل جمله"), parts[0]);
});

test("operator-defined section labels are separated too", () => {
  const custom = "🧭 توصیهٔ سیاستی: الف\n📌 پیامد بازار: ب\n🔎 شکاف دانش: ج";
  assert.equal(separateSummarySections(custom).split("\n\n").length, 3);
});

test("markdown links and Persian text survive the reshaping", () => {
  const withLink =
    "❓ پرسش: چرا؟ [منبع اصلی](https://example.com/a_b)\n📈 نتایج: ۵۲٪ از رشد نابرابری.\n\n✅ تأییدشده";
  const out = separateSummarySections(withLink);
  assert.ok(out.includes("[منبع اصلی](https://example.com/a_b)"), out);
  assert.equal(out.split("\n\n").length, 3);
});

test("empty and null summaries render as nothing instead of a stray separator", () => {
  for (const value of [null, undefined, "", "   ", "\n\n"]) {
    assert.equal(separateSummarySections(value), "");
  }
});

const row = (overrides = {}) => ({
  title: "اثر اتوماسیون بر نابرابری دستمزد",
  summary: RESEARCH,
  category: "پژوهش",
  importanceScore: 82,
  url: "https://example.com/study/1",
  translatedTitle: "اتوماسیون و شکاف دستمزد",
  whyItMatters: "برای سیاست‌گذاری بازار کار و بودجهٔ آموزشی مهم است.",
  ...overrides,
});

test("buildNewsMessage spaces the summary but keeps every other block intact", () => {
  const text = buildNewsMessage(row());

  // The summary stays under its «خلاصه:» label, and every section after the
  // first one begins a new paragraph (exactly one blank line before it).
  assert.match(text, /خلاصه:\n❓ پرسش پژوهش:/);
  for (const marker of ["📊", "🔬", "📈"]) {
    const at = text.indexOf(marker);
    assert.ok(at > 0, `missing ${marker}`);
    assert.equal(text.slice(at - 2, at), "\n\n", `${marker} must start a paragraph`);
  }
  assert.equal(text.includes("\n\n\n"), false, "never doubled spacing");

  // The untouched parts: title header, the "why" block and the link footer.
  assert.ok(text.includes("اتوماسیون و شکاف دستمزد"));
  assert.ok(text.includes("چرا مهم است:"));
  assert.ok(text.includes("[لینک اصلی خبر](https://example.com/study/1)"));
  assert.ok(text.indexOf("چرا مهم است:") > text.lastIndexOf("📈 نتایج:"), "why block still after the summary");

  // A summary without sections must not gain anything.
  const plain = buildNewsMessage(row({ summary: "فقط یک پاراگراف ساده." }));
  assert.ok(plain.includes("فقط یک پاراگراف ساده."));
  assert.equal(plain.includes("\n\n\n"), false);
});
