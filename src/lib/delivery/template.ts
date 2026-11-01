/**
 * Publishing template rendering (Milestone 8+).
 *
 * News + AI translation/analysis + a configurable template -> the Bale/Local
 * delivery artifact. Formatting is deliberately NOT inside the AI service: the
 * AI translates and analyzes, this layer composes. The rendered text is stored
 * on the delivery row, so later edits never mutate the news or the analysis.
 *
 * Unknown placeholders are left visible rather than silently dropped, so a
 * typo in the admin template is obvious instead of producing a blank message.
 */

import type { NewsRow } from "@/db/schema";
import { sanitizeWhyItMatters } from "../ai/why-guard";
import {
  buildNewsMessage,
  escapeMd,
  formatBilingualTitle,
  mdLink,
  stripEmptyLabelBlocks,
  type MessageExtras,
} from "./message";

/** Variables supported by the publishing template engine. */
export const PUBLISHING_TEMPLATE_VARS = [
  "bilingualTitle",
  "translatedTitle",
  "originalTitle",
  "title",
  "summary",
  "hashtags",
  "category",
  "importanceScore",
  "relevanceScore",
  "noveltyScore",
  "mainEvent",
  "whyItMatters",
  "sourceName",
  "originalUrl",
  "publishedAt",
] as const;

export type PublishingTemplateVar = (typeof PUBLISHING_TEMPLATE_VARS)[number];

export const DEFAULT_PUBLISHING_TEMPLATE = `📰 {category}

{bilingualTitle}

{summary}

چرا مهم است:
{whyItMatters}

اهمیت: {importanceScore} از ۱۰۰

{originalUrl}

{hashtags}`;

const MAX_FIELD_LENGTH = 1500;

function value(varName: PublishingTemplateVar, article: NewsRow): string {
  switch (varName) {
    case "bilingualTitle":
      return formatBilingualTitle(article.title, article.translatedTitle, 320);
    case "translatedTitle":
      return escapeMd((article.translatedTitle ?? "").trim() || article.normalizedTitle || article.title);
    case "originalTitle":
      return escapeMd(article.title);
    case "title":
      return escapeMd((article.translatedTitle ?? "").trim() || article.normalizedTitle || article.title);
    case "hashtags":
      return escapeMd(article.hashtags ?? "");
    case "summary":
      return escapeMd(article.summary ?? "—");
    case "category":
      return escapeMd(article.category ?? "اقتصاد");
    case "importanceScore":
    case "relevanceScore":
    case "noveltyScore": {
      const score =
        varName === "importanceScore"
          ? article.importanceScore
          : varName === "relevanceScore"
            ? article.relevanceScore
            : article.noveltyScore;
      return score === null || score === undefined ? "—" : String(score);
    }
    case "mainEvent":
      return escapeMd(article.mainEvent ?? "");
    case "whyItMatters":
      return escapeMd(sanitizeWhyItMatters(article.whyItMatters) ?? "");
    case "sourceName":
      return escapeMd(article.source);
    case "originalUrl":
      // The label «لینک اصلی خبر» IS the hyperlink to the original article URL.
      return mdLink("لینک اصلی خبر", article.url);
    case "publishedAt":
      return article.publishedAt ? article.publishedAt.toISOString().slice(0, 10) : "—";
  }
}

function compact(text: string, limit = MAX_FIELD_LENGTH): string {
  const collapsed = text.replace(/\n{3,}/g, "\n\n").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit).trimEnd()}…` : collapsed;
}

/**
 * Renders the template against one article. An empty/blank template falls back
 * to the built-in layout so older configurations keep producing a complete
 * message.
 */
export function renderPublishingMessage(
  template: string | null | undefined,
  article: NewsRow,
  extras: MessageExtras = {},
): string {
  const source = template?.trim();
  if (!source) return buildNewsMessage(article, extras);

  const rendered = source.replace(/\{([a-zA-Z]+)\}/g, (match, rawKey: string) => {
    if (!(PUBLISHING_TEMPLATE_VARS as readonly string[]).includes(rawKey)) return match;
    return compact(value(rawKey as PublishingTemplateVar, article));
  });

  // Optional fields that came back empty leave dangling «label:» lines —
  // drop those blocks, then collapse 3+ blank lines.
  const cleaned = stripEmptyLabelBlocks(rendered);
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

/** Unknown placeholder names in a template (used for admin validation). */
export function findUnknownTemplateVars(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{([a-zA-Z]+)\}/g)) {
    const key = match[1];
    if (key && !(PUBLISHING_TEMPLATE_VARS as readonly string[]).includes(key)) found.add(key);
  }
  return [...found];
}
