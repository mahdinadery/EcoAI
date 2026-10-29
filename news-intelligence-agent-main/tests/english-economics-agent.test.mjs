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
import { DEFAULT_OUTPUT_SCHEMA, DEFAULT_PUBLISHING_TEMPLATE } from "../src/lib/ai/config-types.ts";
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

test("parseAiOutput parses translatedTitle + Persian summary and renders bilingual Bale message", () => {
  const aiJson = JSON.stringify({
    translatedTitle: "چرا نرخ بهرهٔ خنثی بالاتر در حال بازآرایی سیاست مالی جهان است",
    summary:
      "این مقاله نشان می‌دهد که تغییرات ساختاری جمعیتی، سرمایه‌گذاری در گذار سبز و هزینه‌های دفاعی، نرخ بهرهٔ حقیقی خنثی را بالاتر از سطح پیش از همه‌گیری نگه داشته است؛ در نتیجه دولت‌ها دیگر نمی‌توانند به استقراض ارزان برای تثبیت نسبت بدهی به تولید ناخالص داخلی تکیه کنند.",
    category: "سیاست پولی و بانک مرکزی",
    importance: 88,
    relevance: 94,
    novelty: 82,
    mainEvent: "افزایش ساختاری نرخ بهرهٔ خنثی فشار پایداری بدهی دولت‌ها را در اقتصاد جهانی تشدید کرده است.",
    whyItMatters:
      "بالا ماندن هزینهٔ استقراض دولتی فضای مالی کشورها را محدود کرده و هماهنگی سیاست پولی و مالی بانک‌های مرکزی را دشوارتر می‌کند.",
    hashtags: "#اقتصاد_کلان #سیاست_پولی #بدهی_عمومی",
    entities: ["صندوق بین‌المللی پول", "فدرال رزرو"],
    shouldSend: true,
    reason: "مقاله تحلیلی عمیق با استدلال روشن دربارهٔ نرخ بهرهٔ خنثی و سیاست مالی جهانی.",
  });

  const parsed = parseAiOutput(aiJson, DEFAULT_OUTPUT_SCHEMA);
  assert.equal(parsed.translatedTitle, "چرا نرخ بهرهٔ خنثی بالاتر در حال بازآرایی سیاست مالی جهان است");
  assert.equal(parsed.shouldSend, true);

  const articleRow = {
    title: "Why Higher Neutral Interest Rates Are Reshaping Global Fiscal Policy",
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
    source: "IMF Blog",
    url: "https://www.imf.org/en/Blogs/Articles/2026/10/28/neutral-rates",
    publishedAt: new Date("2026-10-28T10:00:00Z"),
  };

  // 1) Default publishing template renders bilingual title + Persian summary + link + hashtags
  const templated = renderPublishingMessage(DEFAULT_PUBLISHING_TEMPLATE, articleRow);
  assert.ok(templated.includes("📰 سیاست پولی و بانک مرکزی"));
  assert.ok(templated.includes("🇮🇷 چرا نرخ بهرهٔ خنثی بالاتر در حال بازآرایی سیاست مالی جهان است"));
  assert.ok(templated.includes("🌐 Why Higher Neutral Interest Rates Are Reshaping Global Fiscal Policy"));
  assert.ok(templated.includes("نرخ بهرهٔ حقیقی خنثی"));
  assert.ok(templated.includes("چرا مهم است:"));
  assert.ok(templated.includes("محور اصلی مقاله:"));
  assert.ok(templated.includes("[لینک اصلی خبر](https://www.imf.org/en/Blogs/Articles/2026/10/28/neutral-rates)"));
  assert.ok(templated.includes("#اقتصاد_کلان #سیاست_پولی #بدهی_عمومی"));

  // 2) Built-in fallback message also renders bilingual title
  const fallbackMsg = buildNewsMessage(articleRow);
  assert.ok(fallbackMsg.includes("🇮🇷 چرا نرخ بهرهٔ خنثی بالاتر"));
  assert.ok(fallbackMsg.includes("🌐 Why Higher Neutral Interest Rates"));

  // 3) Bulletin renders bilingual title per item
  const bulletinMsg = buildBulletinMessage({
    intro: "محور اصلی مقالات امروز، تعامل نرخ بهرهٔ خنثی و پایداری مالی دولت‌ها بود.",
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
  assert.ok(bulletinMsg.includes("1️⃣ چرا نرخ بهرهٔ خنثی بالاتر"));
  assert.ok(bulletinMsg.includes("🌐 Why Higher Neutral Interest Rates"));
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
