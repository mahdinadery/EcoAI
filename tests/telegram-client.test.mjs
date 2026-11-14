import assert from "node:assert/strict";
import test from "node:test";

/**
 * Pure Telegram formatting rules: one Bale-shaped Markdown message, rendered
 * for Telegram as escaped HTML with a source-link button.
 */
const {
  candidateTelegramChatIds,
  extractPrimaryUrl,
  markdownMessageToHtml,
  normalizeTelegramChatId,
  splitTelegramMessage,
  stripHtmlForPlainFallback,
} = await import("../src/lib/telegram/client.ts");

test("normalizeTelegramChatId accepts handles, t.me links, and Persian digits", () => {
  assert.equal(normalizeTelegramChatId("@ecoai_channel"), "@ecoai_channel");
  assert.equal(normalizeTelegramChatId("ecoai_channel"), "@ecoai_channel");
  assert.equal(normalizeTelegramChatId("https://t.me/ecoai_channel"), "@ecoai_channel");
  assert.equal(normalizeTelegramChatId("t.me/ecoai_channel/"), "@ecoai_channel");
  assert.equal(normalizeTelegramChatId("  -1001234567890  "), "-1001234567890");
  assert.equal(normalizeTelegramChatId("۱۲۳۴۵۶۷۸۹"), "123456789");
  assert.equal(normalizeTelegramChatId('"@ecoai_channel"'), "@ecoai_channel");
  // Invite links carry no usable chat id and are left untouched.
  assert.equal(normalizeTelegramChatId("https://t.me/joinchat/AAAAAE"), "https://t.me/joinchat/AAAAAE");
  assert.equal(normalizeTelegramChatId("   "), undefined);
  assert.equal(normalizeTelegramChatId(undefined), undefined);
});

test("candidateTelegramChatIds tries the -100 channel encodings", () => {
  assert.deepEqual(candidateTelegramChatIds("123456789"), ["123456789", "-100123456789", "-123456789"]);
  assert.deepEqual(candidateTelegramChatIds("-100123456789"), ["-100123456789", "123456789", "-123456789"]);
  // Handles are already canonical (and the list is de-duplicated).
  assert.deepEqual(candidateTelegramChatIds("@ecoai_channel"), ["@ecoai_channel"]);
});

test("markdownMessageToHtml links the title and escapes the surrounding text", () => {
  const markdown =
    "🤖 [هشدار پژوهشگر سابق آنتروپیک دربارهٔ هوش مصنوعی](https://stanforddaily.com/2026/11/13/x/)\n\n" +
    "نرخ 5% < 10% و 2 > 1 — \\[تأییدشده\\]";
  const html = markdownMessageToHtml(markdown);

  assert.match(html, /<a href="https:\/\/stanforddaily\.com\/2026\/11\/13\/x\/">هشدار پژوهشگر سابق آنتروپیک/);
  // HTML special characters in the operator/AI text can never break the markup.
  assert.match(html, /5% &lt; 10% و 2 &gt; 1/);
  // The Markdown builder's backslash escapes become literal characters again.
  assert.ok(html.includes("[تأییدشده]"));
  assert.ok(!html.includes("\\["));
});

test("markdownMessageToHtml renders bold and never trusts unbalanced markup", () => {
  const html = markdownMessageToHtml("**جمع‌بندی:** 3 < 4 & 5 > 2 *ستاره‌ای*");
  assert.equal(html, "<b>جمع‌بندی:</b> 3 &lt; 4 &amp; 5 &gt; 2 *ستاره‌ای*");

  const injected = markdownMessageToHtml('عنوان <script>alert(1)</script> [لینک](https://a.test/x)');
  assert.ok(!injected.includes("<script>"));
  assert.match(injected, /&lt;script&gt;/);
});

test("stripHtmlForPlainFallback keeps links readable without markup", () => {
  const html = 'ببینید <a href="https://a.test/x">مطالعهٔ کامل</a> — <b>مهم</b>';
  assert.equal(stripHtmlForPlainFallback(html), "ببینید مطالعهٔ کامل (https://a.test/x) — مهم");
});

test("extractPrimaryUrl prefers the markdown link and falls back to a bare url", () => {
  assert.equal(
    extractPrimaryUrl("تیتر [منبع](https://a.test/x) و https://b.test/y"),
    "https://a.test/x",
  );
  assert.equal(extractPrimaryUrl("بدون لینک [تأییدشده]"), null);
  assert.equal(extractPrimaryUrl("بخوانید: https://b.test/y."), "https://b.test/y");
});

test("splitTelegramMessage respects Telegram's 4096-character limit", () => {
  const long = `${"کلمه ".repeat(1200)}\n\n${"پاراگراف دوم"}`;
  const chunks = splitTelegramMessage(long);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 4096, `chunk too long: ${chunk.length}`);
  assert.equal(chunks.join("\n\n").includes("پاراگراف دوم"), true);
});
