import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  composeArticleTextForAi,
  extractArticleTextFromHtml,
  shouldFetchFullArticleText,
} from "../src/lib/news/article-extractor-core.ts";
import {
  DEFAULT_OUTPUT_SCHEMA,
  DEFAULT_PUBLISHING_TEMPLATE,
  DEFAULT_SYSTEM_PROMPT,
  LEGACY_GENERAL_ECON_SYSTEM_PROMPT,
  LEGACY_MAIN_EVENT_PUBLISHING_TEMPLATE,
  LEGACY_PROSE_AIECON_SYSTEM_PROMPT,
  LEGACY_PROSE_SUMMARY_INSTRUCTION,
  SUMMARY_DEFAULT_INSTRUCTION,
  upgradeLegacySummaryInstruction,
  upgradeLegacySystemPrompt,
  upgradeLegacyTemplateFooter,
} from "../src/lib/ai/config-types.ts";
import { buildNewsMessage, formatBilingualTitle } from "../src/lib/delivery/message.ts";
import { buildBulletinMessage } from "../src/lib/delivery/bulletin.ts";
import { similarityKeyOf } from "../src/lib/news/corroboration.ts";
import { STEPS } from "../scripts/db-ensure.mjs";

const dir = await mkdtemp(join(tmpdir(), "english-econ-agent-"));
async function load(path, replacements) {
  let source = await readFile(new URL(path, import.meta.url), "utf8");
  for (const [from, target] of replacements) {
    source = source.replaceAll(from, new URL(target, import.meta.url).href);
  }
  const file = join(dir, path.split("/").at(-1));
  await writeFile(file, source);
  return import(pathToFileURL(file).href);
}

const { parseAiOutput } = await load("../src/lib/ai/output-parser.ts", [
  ["./why-guard", "../src/lib/ai/why-guard.ts"],
]);
const { renderPublishingMessage } = await load("../src/lib/delivery/template.ts", [
  ["../ai/why-guard", "../src/lib/ai/why-guard.ts"],
  ["./message", "../src/lib/delivery/message.ts"],
]);
const { parseFeed } = await load("../src/lib/news/rss.ts", [
  ["./feed-client", "../src/lib/news/feed-client.ts"],
]);

test.after(() => rm(dir, { recursive: true, force: true }));

test("extractArticleTextFromHtml extracts clean analytical prose and strips nav/script/boilerplate", () => {
  const html = `
    <html>
      <head><title>IMF Blog</title></head>
      <body>
        <nav><p>Menu item that must be ignored completely by the extractor</p></nav>
        <article>
          <h2>The Fiscal-Monetary Nexus</h2>
          <p>Subscribe now to our newsletter</p>
          <p>Rising neutral real interest rates are fundamentally altering sovereign debt dynamics across advanced and emerging economies alike.</p>
          <p>When real borrowing costs exceed trend GDP growth, primary surpluses become necessary merely to stabilize debt-to-GDP ratios over the medium term.</p>
          <blockquote>Fiscal credibility is an essential anchor for monetary policy effectiveness and long-run price stability.</blockquote>
        </article>
        <footer><p>All rights reserved.</p></footer>
        <script>console.log("ignore me");</script>
      </body>
    </html>
  `;

  const extracted = extractArticleTextFromHtml(html);
  assert.ok(extracted);
  assert.ok(extracted.includes("## The Fiscal-Monetary Nexus"));
  assert.ok(extracted.includes("Rising neutral real interest rates"));
  assert.ok(extracted.includes("primary surpluses become necessary"));
  assert.ok(extracted.includes("Fiscal credibility is an essential anchor"));
  assert.ok(!extracted.includes("Subscribe now"));
  assert.ok(!extracted.includes("Menu item"));
  assert.ok(!extracted.includes("ignore me"));
});

test("shouldFetchFullArticleText triggers only for thin RSS snippets with http(s) URLs", () => {
  assert.equal(
    shouldFetchFullArticleText({
      url: "https://cepr.org/voxeu/columns/example",
      description: "Short two-sentence RSS teaser.",
      content: null,
    }),
    true,
  );
  assert.equal(
    shouldFetchFullArticleText({
      url: "https://cepr.org/voxeu/columns/example",
      description: "Short teaser",
      content: "Rich content paragraph. ".repeat(30),
    }),
    false,
  );
  assert.equal(shouldFetchFullArticleText({ url: "ftp://invalid", description: "short" }), false);
});

test("composeArticleTextForAi deduplicates overlapping teaser and caps full text", () => {
  const snippet = "Global trade fragmentation is reshaping supply chains across Asia and Europe.";
  const body = `${snippet} Economists estimate that tariff escalation reduces long-run productivity through input misallocation.`;
  const composed = composeArticleTextForAi({ description: snippet, content: body });
  assert.equal(composed.summarySnippet, null, "duplicate opening snippet should not be repeated");
  assert.ok(composed.fullText?.includes("tariff escalation reduces long-run productivity"));
});

test("parseFeed handles Atom <feed>/<entry> with <summary>, <content> and rel=alternate link", () => {
  const atomXml = `<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>VoxEU Economic Research</title>
      <entry>
        <title>Industrial Policy and Global Productivity</title>
        <link rel="self" href="https://cepr.org/api/entry/1" />
        <link rel="alternate" href="https://cepr.org/voxeu/columns/industrial-policy" />
        <id>tag:cepr.org,2026:entry-1</id>
        <published>2026-10-28T09:00:00Z</published>
        <summary>A short abstract on industrial subsidies.</summary>
        <content type="html">&lt;p&gt;Detailed empirical evidence from cross-country manufacturing panels.&lt;/p&gt;</content>
      </entry>
    </feed>`;

  const parsed = parseFeed(atomXml, "cepr.org");
  assert.equal(parsed.source, "VoxEU Economic Research");
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].url, "https://cepr.org/voxeu/columns/industrial-policy");
  assert.equal(parsed.items[0].description, "A short abstract on industrial subsidies.");
  assert.equal(parsed.items[0].content, "Detailed empirical evidence from cross-country manufacturing panels.");
});

test("parseAiOutput parses translatedTitle + structured 4-question Persian summary and renders clean Bale message", () => {
  const aiJson = JSON.stringify({
    translatedTitle: "هوش مصنوعی مولد و بهره‌وری نیروی کار: شواهد میدانی از مراکز پشتیبانی",
    summary: [
      "**❓ پرسش پژوهش:** آیا دسترسی کارشناسان به دستیار هوش مصنوعی مولد باعث افزایش بهره‌وری و کیفیت خدمات می‌شود؟",
      "**📊 داده‌ها:** داده‌های عملکرد ماهانهٔ ۵٬۱۷۹ کارشناس پشتیبانی در یک شرکت نرم‌افزاری طی یک سال.",
      "**🔬 روش:** راه‌اندازی تدریجی (Staggered Rollout) و برآورد تفاضل در تفاضل (DiD).",
      "**📈 نتایج:** بهره‌وری میانگین ۱۴٪ و در نیروهای تازه‌کار ۳۴٪ افزایش یافت و نرخ ترک خدمت کاهش پیدا کرد.",
    ].join("\n"),
    category: "بازار کار و مشاغل",
    importance: 88,
    relevance: 94,
    novelty: 82,
    mainEvent: "افزایش ۱۴ درصدی بهره‌وری با هوش مصنوعی مولد در مطالعهٔ میدانی.",
    whyItMatters:
      "برخلاف موج‌های قبلی اتوماسیون، هوش مصنوعی مولد با انتقال ضمنی مهارت نیروهای خبره به تازه‌کاران شکاف بهره‌وری درون‌بنگاهی را کاهش می‌دهد.",
    hashtags: "#اقتصاد_هوش_مصنوعی #بهره‌وری #بازار_کار",
    entities: ["دفتر ملی پژوهش اقتصادی آمریکا", "استنفورد"],
    shouldSend: true,
    reason: "پژوهش تجربی تراز اول با داده و روش مشخص دربارهٔ اثر هوش مصنوعی بر بهره‌وری نیروی کار.",
  });

  const parsed = parseAiOutput(aiJson, DEFAULT_OUTPUT_SCHEMA);
  assert.equal(parsed.translatedTitle, "هوش مصنوعی مولد و بهره‌وری نیروی کار: شواهد میدانی از مراکز پشتیبانی");
  assert.equal(parsed.shouldSend, true);
  // Markdown bold `**` around labels is stripped cleanly while `\n` line breaks stay intact:
  assert.ok(!parsed.summary.includes("**"));
  assert.equal(parsed.summary.split("\n").length, 4);
  assert.ok(parsed.summary.includes("❓ پرسش پژوهش:"));
  assert.ok(parsed.summary.includes("📊 داده‌ها:"));
  assert.ok(parsed.summary.includes("🔬 روش:"));
  assert.ok(parsed.summary.includes("📈 نتایج:"));

  const articleRow = {
    title: "Generative AI at Work",
    translatedTitle: parsed.translatedTitle,
    summary: parsed.summary,
    category: parsed.category,
    importanceScore: parsed.importance,
    relevanceScore: parsed.relevance,
    noveltyScore: parsed.novelty,
    mainEvent: parsed.mainEvent,
    whyItMatters: parsed.whyItMatters,
    hashtags: parsed.hashtags,
    entityTags: parsed.entities,
    source: "NBER",
    url: "https://www.nber.org/papers/w31161",
    publishedAt: new Date("2026-10-28T10:00:00Z"),
  };

  // 1) Default publishing template renders bilingual title + 4-line structured summary + whyItMatters (without redundant mainEvent)
  const templated = renderPublishingMessage(DEFAULT_PUBLISHING_TEMPLATE, articleRow);
  assert.ok(templated.includes("📰 بازار کار و مشاغل"));
  assert.ok(templated.includes("🇮🇷 هوش مصنوعی مولد و بهره‌وری نیروی کار: شواهد میدانی از مراکز پشتیبانی"));
  assert.ok(templated.includes("🌐 Generative AI at Work"));
  assert.ok(templated.includes("❓ پرسش پژوهش:"));
  assert.ok(templated.includes("\n📊 داده‌ها:"));
  assert.ok(templated.includes("\n🔬 روش:"));
  assert.ok(templated.includes("\n📈 نتایج:"));
  assert.ok(!templated.includes("\\*\\*"), "must not leak escaped asterisks into Bale message");
  assert.ok(templated.includes("چرا مهم است:"));
  assert.ok(!templated.includes("محور اصلی مقاله:"), "redundant mainEvent block must be omitted from default template");
  assert.ok(templated.includes("[لینک اصلی خبر](https://www.nber.org/papers/w31161)"));
  assert.ok(templated.includes("#اقتصاد_هوش_مصنوعی #بهره‌وری #بازار_کار"));

  // Custom templates explicitly requesting `{mainEvent}` still render it cleanly:
  const customWithMain = renderPublishingMessage("{title}\nمحور: {mainEvent}", articleRow);
  assert.ok(customWithMain.includes("محور: افزایش ۱۴ درصدی بهره‌وری"));

  // 2) Built-in fallback message preserves multiline structured summary + bilingual title
  const fallbackMsg = buildNewsMessage(articleRow);
  assert.ok(fallbackMsg.includes("🇮🇷 هوش مصنوعی مولد و بهره‌وری نیروی کار"));
  assert.ok(fallbackMsg.includes("🌐 Generative AI at Work"));
  assert.ok(fallbackMsg.includes("❓ پرسش پژوهش:"));
  assert.ok(fallbackMsg.includes("\n📈 نتایج:"));

  // 3) Bulletin preserves structured lines including `📈 نتایج:` without truncating at 300 chars
  const bulletinMsg = buildBulletinMessage({
    intro: "محور اصلی مقالات امروز، شواهد تجربی اثر هوش مصنوعی مولد بر بهره‌وری نیروی کار بود.",
    items: [
      {
        id: "1",
        title: articleRow.title,
        translatedTitle: articleRow.translatedTitle,
        oneLiner: articleRow.summary,
        whyItMatters: articleRow.whyItMatters,
        url: articleRow.url,
        importanceScore: articleRow.importanceScore,
        hashtags: articleRow.hashtags,
        entityTags: articleRow.entityTags,
        publishedAt: articleRow.publishedAt,
      },
    ],
    generatedAt: new Date("2026-10-29T08:00:00Z"),
    timezone: "Asia/Tehran",
  });
  assert.ok(bulletinMsg.includes("1️⃣ هوش مصنوعی مولد و بهره‌وری نیروی کار"));
  assert.ok(bulletinMsg.includes("🌐 Generative AI at Work"));
  assert.ok(bulletinMsg.includes("❓ پرسش پژوهش:"));
  assert.ok(bulletinMsg.includes("\n📈 نتایج:"));
});

test("formatBilingualTitle avoids duplicating identical single-language titles", () => {
  assert.equal(formatBilingualTitle("عنوان یکسان", "عنوان یکسان"), "عنوان یکسان");
  assert.equal(formatBilingualTitle("عنوان بدون ترجمه", null), "عنوان بدون ترجمه");
});

test("similarityKeyOf groups paraphrased English economic headlines across outlets", () => {
  const k1 = similarityKeyOf("Federal Reserve Signals Patience Over Disinflation Trajectory");
  const k2 = similarityKeyOf("Disinflation Trajectory: Why the Federal Reserve Signals Patience");
  assert.ok(k1.length > 0);
  assert.equal(k1, k2);
});

test("db-ensure includes additive translated_title columns on news and ai_analyses", () => {
  assert.ok(STEPS.some((s) => s.name === "column news.translated_title" && s.sql.includes("IF NOT EXISTS")));
  assert.ok(STEPS.some((s) => s.name === "column ai_analyses.translated_title" && s.sql.includes("IF NOT EXISTS")));
});

test("upgradeLegacySystemPrompt, upgradeLegacySummaryInstruction & upgradeLegacyTemplateFooter auto-upgrade untouched defaults while preserving custom edits", () => {
  assert.equal(upgradeLegacySystemPrompt(LEGACY_GENERAL_ECON_SYSTEM_PROMPT), DEFAULT_SYSTEM_PROMPT);
  assert.equal(upgradeLegacySystemPrompt(LEGACY_PROSE_AIECON_SYSTEM_PROMPT), DEFAULT_SYSTEM_PROMPT);
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes("اقتصاد هوش مصنوعی"));
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes("❓ پرسش پژوهش:"));
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes("📊 داده‌ها:"));
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes("🔬 روش:"));
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes("📈 نتایج:"));
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes("⚙️ سازوکار اقتصادی:"));
  assert.equal(
    upgradeLegacySystemPrompt("پرامپت سفارشی اپراتور برای تحلیل خاص"),
    "پرامپت سفارشی اپراتور برای تحلیل خاص",
  );

  assert.equal(upgradeLegacySummaryInstruction(LEGACY_PROSE_SUMMARY_INSTRUCTION), SUMMARY_DEFAULT_INSTRUCTION);
  assert.equal(upgradeLegacySummaryInstruction("دستور خلاصهٔ سفارشی"), "دستور خلاصهٔ سفارشی");

  assert.equal(upgradeLegacyTemplateFooter(LEGACY_MAIN_EVENT_PUBLISHING_TEMPLATE), DEFAULT_PUBLISHING_TEMPLATE);
  assert.equal(upgradeLegacyTemplateFooter("{title}\nمحور سفارشی: {mainEvent}"), "{title}\nمحور سفارشی: {mainEvent}");
});
