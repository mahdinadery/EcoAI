/**
 * Topic / relevance gate — SERVER-SIDE, pure logic (no DB, no network).
 *
 * Runs BEFORE the expensive AI analysis stage:
 *
 *   fetch -> parse -> normalize -> dedupe -> [TOPIC FILTER] -> AI -> delivery
 *
 * Deliberately keyword/rule based (NOT an LLM call): matching is a handful of
 * substring checks, so filtering 50 articles costs microseconds instead of a
 * model round-trip. Articles that fail the gate are STORED with the
 * SKIPPED_OFFTOPIC status (never silently discarded) and can be re-queued from
 * the admin UI after the topics change.
 *
 * FAIL-OPEN CONTRACT (important): when the filter is disabled, has no topics,
 * or no enabled topic carries a keyword, every article passes THE CONFIGURED
 * PART of the filter. The filter can therefore never lose news on its own — it
 * only narrows what reaches the AI when the operator explicitly configured
 * topics.
 *
 * ONE exception is hard-coded on top: BASELINE_BLOCKED_KEYWORDS — a small,
 * conservative deny-list of topics this product must never forward (sports,
 * entertainment, accidents). It applies even when the filter is disabled or
 * absent, because "the bot sent sports news to a credit-rating channel" is
 * never a correct outcome. Operators add their own words via
 * `AiTopicFilterConfig.blockedKeywords`.
 */

import type { AiTopicFilterConfig, AiTopicRule } from "@/lib/ai/config-types";

/**
 * Always-on deny-list (see header). Checked BEFORE the operator configuration,
 * in both modes, even when the topic filter is disabled or not configured.
 * Deliberately tiny and unambiguous: words that can never appear in credit
 * rating / credit risk news for a rating-agency audience. Extend via the
 * configurable `blockedKeywords` deny-list, not by growing this list.
 */
export const BASELINE_BLOCKED_KEYWORDS: readonly string[] = [
  "ورزش",
  "فوتبال",
  "لیگ برتر",
  "لیگ قهرمانان",
  "سرگرمی",
  "هنرمندان",
  "بازیگر",
  "سینما",
  "حوادث",
  "تصادف",
  "تخصیص اعتبار",
  "اعتبارات عمرانی",
  "اعتبارات استانی",
  "کالابرگ",
  "اعتبار کالابرگ",
];

/** Operator override replaces the built-in baseline, including an explicit empty list. */
export function baselineKeywords(filter: AiTopicFilterConfig | null | undefined): readonly string[] {
  return filter?.baselineBlockedKeywords ?? BASELINE_BLOCKED_KEYWORDS;
}

/**
 * Normalizes text for Persian-friendly matching:
 * - lowercases Latin text
 * - folds Arabic letter variants into Persian forms (ي→ی, ك→ک, ...)
 * - strips diacritics, tatweel and zero-width joiners (ZWNJ included, so
 *   «می‌شود» and «میشود» compare equal)
 * - collapses whitespace
 */
export function normalizeForMatch(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // diacritics + tatweel + superscript alef
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "") // zero-width + directional marks (incl. ZWNJ/ZWJ)
    .replace(/[\u064A\u0649\u06D2]/g, "\u06CC") // ي ى ے -> ی
    .replace(/\u0643/g, "\u06A9") // ك -> ک
    .replace(/\u0629/g, "\u0647") // ة -> ه
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627") // آ أ إ ٱ -> ا
    .replace(/\s+/g, " ")
    .trim();
}

function topicMatches(topic: AiTopicRule, haystack: string): boolean {
  if (!topic.enabled) return false;
  for (const raw of topic.keywords) {
    const keyword = normalizeForMatch(raw);
    if (keyword && haystack.includes(keyword)) return true;
  }
  return false;
}

export type TopicFilterArticle = {
  title: string | null | undefined;
  description?: string | null;
  content?: string | null;
};

export type TopicFilterOutcome =
  /** The filter is inactive / not effective: everything passes. */
  | { verdict: "pass"; reason: "filter_disabled" | "no_effective_topics"; matchedTopics: string[] }
  /** Explicit evaluation against configured topics. */
  | { verdict: "pass"; reason: "matched_topic" | "no_excluded_match"; matchedTopics: string[] }
  | {
      verdict: "skip";
      reason: "not_in_selected_topics" | "matched_excluded_topic" | "matched_blocked_keyword";
      matchedTopics: string[];
      /** Only set for "matched_blocked_keyword" — the deny-list words that hit. */
      blockedKeywords?: string[];
    };

/** Enabled topics that actually carry at least one usable keyword. */
function effectiveTopics(filter: AiTopicFilterConfig): AiTopicRule[] {
  return (filter.topics ?? []).filter((topic) => topic.enabled && topic.keywords.some((k) => normalizeForMatch(k)));
}

/** Non-empty deny-list keywords, trimmed for display (matching is normalized). */
function effectiveBlockedKeywords(filter: AiTopicFilterConfig): string[] {
  return (filter.blockedKeywords ?? []).map((keyword) => keyword.trim()).filter(Boolean);
}

/**
 * Evaluates one article against the topic filter.
 *
 * Order of evaluation:
 *   1. BASELINE_BLOCKED_KEYWORDS (always on) — see the file header;
 *   2. the configured deny-list (`blockedKeywords`) wins in BOTH modes — an
 *      article that contains a blocked keyword is skipped even when it matches
 *      a topic;
 *   3. include mode: pass iff at least one enabled topic matches (OR across topics);
 *   4. exclude mode: skip iff at least one enabled topic matches.
 *
 * A deny-list-only configuration (no topics) is valid: everything passes unless
 * a blocked keyword is found.
 */
export function evaluateTopicFilter(
  article: TopicFilterArticle,
  filter: AiTopicFilterConfig | null | undefined,
): TopicFilterOutcome {
  const haystack = normalizeForMatch([article.title, article.description, article.content].filter(Boolean).join(" \u2000 "));

  const baselineHits = baselineKeywords(filter).filter((keyword) => haystack.includes(normalizeForMatch(keyword)));
  if (baselineHits.length > 0) {
    return { verdict: "skip", reason: "matched_blocked_keyword", matchedTopics: [], blockedKeywords: [...baselineHits] };
  }

  if (!filter || !filter.enabled) {
    return { verdict: "pass", reason: "filter_disabled", matchedTopics: [] };
  }

  const topics = effectiveTopics(filter);
  const blocked = effectiveBlockedKeywords(filter);
  if (topics.length === 0 && blocked.length === 0) {
    // Misconfiguration safety net: never drop news just because nothing is configured.
    return { verdict: "pass", reason: "no_effective_topics", matchedTopics: [] };
  }

  const blockedHits = blocked.filter((keyword) => haystack.includes(normalizeForMatch(keyword)));
  if (blockedHits.length > 0) {
    return { verdict: "skip", reason: "matched_blocked_keyword", matchedTopics: [], blockedKeywords: blockedHits };
  }

  const matchedTopics: string[] = [];
  for (const topic of topics) {
    if (topicMatches(topic, haystack)) matchedTopics.push(topic.label.trim() || topic.id);
  }

  const matched = matchedTopics.length > 0;

  if (filter.mode === "exclude") {
    return matched
      ? { verdict: "skip", reason: "matched_excluded_topic", matchedTopics }
      : { verdict: "pass", reason: "no_excluded_match", matchedTopics: [] };
  }

  // Deny-list-only configuration: nothing to require, so unblocked wins pass.
  if (topics.length === 0) {
    return { verdict: "pass", reason: "no_excluded_match", matchedTopics: [] };
  }

  return matched
    ? { verdict: "pass", reason: "matched_topic", matchedTopics }
    : { verdict: "skip", reason: "not_in_selected_topics", matchedTopics: [] };
}

/** True when the filter would actually narrow anything (used to skip work entirely). */
export function isTopicFilterActive(filter: AiTopicFilterConfig | null | undefined): boolean {
  if (!filter || !filter.enabled) return false;
  return effectiveTopics(filter).length > 0 || effectiveBlockedKeywords(filter).length > 0;
}

/**
 * True when evaluateTopicFilter() would actually drop something: the baseline
 * deny-list is always armed, so hot paths must NOT skip evaluation entirely.
 * (Kept separate from isTopicFilterActive() which reports only the configured
 * part and is used by the admin UI.)
 */
export function isTopicGateActive(filter: AiTopicFilterConfig | null | undefined): boolean {
  return baselineKeywords(filter).length > 0 || isTopicFilterActive(filter);
}

/** Preset topic suggestions offered by the admin UI (labels + starter keywords). */
export const TOPIC_PRESETS: Array<{ label: string; keywords: string[] }> = [
  { label: "بازار خودرو", keywords: ["خودرو", "خودروساز", "قیمت خودرو", "واردات خودرو", "بازار خودرو"] },
  { label: "مسکن", keywords: ["مسکن", "ملک", "ساخت‌وساز", "قیمت مسکن", "رهن", "اجاره"] },
  { label: "انرژی", keywords: ["انرژی", "نفت", "گاز", "برق", "بنزین", "پتروشیمی"] },
  { label: "سیاست پولی", keywords: ["بانک مرکزی", "نرخ بهره", "نقدینگی", "تورم", "ارز", "دلار", "سیاست پولی"] },
  { label: "تجارت خارجی", keywords: ["تجارت خارجی", "صادرات", "واردات", "گمرک", "ترجیحی", "توافق‌نامه تجاری"] },
];
