/**
 * Topic / relevance gate — SERVER-SIDE, pure logic (no DB, no network).
 *
 * Runs BEFORE the expensive AI analysis stage:
 *
 *   fetch -> parse -> normalize -> dedupe -> [TOPIC FILTER] -> AI -> delivery
 *
 * Deliberately keyword/rule based (NOT an LLM call): matching is a handful of
 * substring / token checks, so filtering 50 articles costs microseconds instead
 * of a model round-trip. Articles that fail the gate are STORED with the
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
 * conservative deny-list of off-topic categories this product must never
 * forward (sports, entertainment, celebrity gossip, accidents). It applies even
 * when the filter is disabled or absent. Operators add their own words via
 * `AiTopicFilterConfig.blockedKeywords`.
 */

import type { AiTopicFilterConfig, AiTopicRule } from "@/lib/ai/config-types";

/**
 * Always-on deny-list (see header). Checked BEFORE the operator configuration,
 * in both modes, even when the topic filter is disabled or not configured.
 * Deliberately conservative and unambiguous in both English and Persian so real
 * economic articles are never shadowed (short ASCII acronyms like "nfl" are
 * matched on word boundaries, so "inflation" never false-positives on "nfl").
 */
export const BASELINE_BLOCKED_KEYWORDS: readonly string[] = [
  "nfl",
  "nba",
  "mlb",
  "nhl",
  "premier league",
  "champions league",
  "celebrity gossip",
  "horoscope",
  "movie review",
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
];

/** Operator override replaces the built-in baseline, including an explicit empty list. */
export function baselineKeywords(filter: AiTopicFilterConfig | null | undefined): readonly string[] {
  return filter?.baselineBlockedKeywords ?? BASELINE_BLOCKED_KEYWORDS;
}

/**
 * Normalizes text for bilingual (English + Persian) matching:
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a normalized keyword against a normalized haystack.
 * Short single-token ASCII keywords (<= 5 chars, e.g. "nfl", "imf", "fed",
 * "ecb", "gdp", "ai") require non-alphanumeric boundaries so "nfl" never hits
 * inside "inflation" and "fed" never hits inside "stuffed". Longer words,
 * multi-word phrases, and Persian stems use substring matching.
 */
export function keywordMatchesHaystack(rawKeyword: string, haystack: string): boolean {
  const keyword = normalizeForMatch(rawKeyword);
  if (!keyword) return false;
  if (/^[a-z0-9]{1,5}$/.test(keyword)) {
    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(keyword)}(?![a-z0-9])`);
    return pattern.test(haystack);
  }
  return haystack.includes(keyword);
}

function topicMatches(topic: AiTopicRule, haystack: string): boolean {
  if (!topic.enabled) return false;
  for (const raw of topic.keywords) {
    if (keywordMatchesHaystack(raw, haystack)) return true;
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

  const baselineHits = baselineKeywords(filter).filter((keyword) => keywordMatchesHaystack(keyword, haystack));
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

  const blockedHits = blocked.filter((keyword) => keywordMatchesHaystack(keyword, haystack));
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

/** Preset topic suggestions offered by the admin UI for The Economics of AI (`اقتصاد هوش مصنوعی`). */
export const TOPIC_PRESETS: Array<{ label: string; keywords: string[] }> = [
  {
    label: "بهره‌وری و اقتصاد کلان AI",
    keywords: [
      "economics of ai",
      "artificial intelligence",
      "generative ai",
      "ai productivity",
      "macroeconomics of ai",
      "ai adoption",
      "llm",
      "اقتصاد هوش مصنوعی",
    ],
  },
  {
    label: "بازار کار، دستمزد و اتوماسیون AI",
    keywords: [
      "ai and jobs",
      "ai labor",
      "job displacement",
      "task automation",
      "automation and wages",
      "agentic ai",
      "robot",
      "بازار کار و هوش مصنوعی",
    ],
  },
  {
    label: "تراشه، محاسبات، دیتاسنتر و انرژی",
    keywords: [
      "semiconductor",
      "gpu",
      "nvidia",
      "tsmc",
      "data center",
      "compute cost",
      "inference cost",
      "hyperscaler",
      "ai capex",
      "ai infrastructure",
    ],
  },
  {
    label: "سرمایه‌گذاری، ارزش‌گذاری و کسب‌وکار AI",
    keywords: [
      "ai investment",
      "ai valuation",
      "ai bubble",
      "ai startup",
      "enterprise ai",
      "ai pricing",
      "token economics",
      "foundation model",
    ],
  },
  {
    label: "رقابت، مقررات و ژئواکونومیک AI",
    keywords: [
      "ai antitrust",
      "ai regulation",
      "ai act",
      "chip export",
      "chips act",
      "sovereign ai",
      "data economics",
      "training data",
    ],
  },
];
