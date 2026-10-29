/**
 * Auto-send rule definition (Milestone 6).
 *
 * The rule is the "Agent decision layer": it turns a stored AI analysis into a
 * delivery decision. Every threshold is environment-driven so the policy can be
 * retuned without touching code. No secret values are read or exposed here.
 *
 * This module stays PURE (no DB imports) so the policy logic is unit-testable;
 * dashboard-override resolution lives in src/lib/agent/resolve-rule.ts.
 */

import type { NewsRow } from "@/db/schema";

// Mirrors CORROBORATION_BONUS in src/lib/news/corroboration.ts — kept inline on
// purpose: this module is imported by the Node test runner, which cannot
// resolve runtime `@/` imports (type-only imports are erased and fine).
const CORROBORATION_BONUS = 10;
import type { AiAutoSendPolicy } from "@/lib/ai/config-types";
import type { DeliveryTarget } from "@/lib/delivery/types";

export type AutoSendRule = {
  enabled: boolean;
  destination: DeliveryTarget;
  minImportance: number;
  minRelevance: number;
  minNovelty: number;
  /** Require the AI's own shouldSend recommendation to be true. */
  requireAiRecommendation: boolean;
  /** null => category is not restricted. */
  categories: string[] | null;
  /** Max articles processed in a single pass. */
  maxItemsPerPass: number;
};

export const AUTO_SEND_ENV = {
  enabled: "AUTO_SEND_ENABLED",
  destination: "AUTO_SEND_DESTINATION",
  minImportance: "AUTO_SEND_MIN_IMPORTANCE",
  minRelevance: "AUTO_SEND_MIN_RELEVANCE",
  minNovelty: "AUTO_SEND_MIN_NOVELTY",
  requireAi: "AUTO_SEND_REQUIRE_AI_RECOMMENDATION",
  categories: "AUTO_SEND_CATEGORIES",
  maxItems: "AUTO_SEND_MAX_ITEMS",
} as const;

/** Safe defaults: Local-only, sensible importance/relevance threshold (50), and sends analyzed news matching criteria. */
const DEFAULTS = {
  enabled: true,
  destination: "local" as DeliveryTarget,
  minImportance: 50,
  minRelevance: 50,
  minNovelty: 0,
  requireAiRecommendation: false,
  maxItemsPerPass: 20,
};

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["0", "false", "no", "off", "خاموش"].includes(raw)) return false;
  if (["1", "true", "yes", "on", "روشن"].includes(raw)) return true;
  return fallback;
}

function clampScore(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.min(100, raw));
}

const VALID_DESTINATIONS: DeliveryTarget[] = ["local", "bale", "both"];

function readDestination(): DeliveryTarget {
  const raw = process.env[AUTO_SEND_ENV.destination]?.trim().toLowerCase();
  return (VALID_DESTINATIONS as string[]).includes(raw ?? "") ? (raw as DeliveryTarget) : DEFAULTS.destination;
}

function readCategories(): string[] | null {
  const raw = process.env[AUTO_SEND_ENV.categories]?.trim();
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

export function loadAutoSendRule(): AutoSendRule {
  const maxRaw = Number.parseInt(process.env[AUTO_SEND_ENV.maxItems]?.trim() ?? "", 10);

  return {
    enabled: readBool(AUTO_SEND_ENV.enabled, DEFAULTS.enabled),
    destination: readDestination(),
    minImportance: clampScore(AUTO_SEND_ENV.minImportance, DEFAULTS.minImportance),
    minRelevance: clampScore(AUTO_SEND_ENV.minRelevance, DEFAULTS.minRelevance),
    minNovelty: clampScore(AUTO_SEND_ENV.minNovelty, DEFAULTS.minNovelty),
    requireAiRecommendation: readBool(AUTO_SEND_ENV.requireAi, DEFAULTS.requireAiRecommendation),
    categories: readCategories(),
    maxItemsPerPass: Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(maxRaw, 100) : DEFAULTS.maxItemsPerPass,
  };
}

/** Maps a dashboard `autoSendPolicy` onto the runtime rule shape (pure). */
export function policyToRule(policy: AiAutoSendPolicy): AutoSendRule {
  return {
    enabled: policy.enabled,
    destination: policy.destination,
    minImportance: Math.max(0, Math.min(100, policy.minImportance)),
    minRelevance: Math.max(0, Math.min(100, policy.minRelevance)),
    minNovelty: Math.max(0, Math.min(100, policy.minNovelty)),
    requireAiRecommendation: policy.requireAiRecommendation,
    categories: policy.categories && policy.categories.length > 0 ? policy.categories : null,
    maxItemsPerPass: Math.max(1, Math.min(100, policy.maxItemsPerPass)),
  };
}

export type RuleCheck = {
  matches: boolean;
  /** Machine-readable reasons, e.g. "importance_below_threshold". */
  reasons: string[];
};

/**
 * Evaluates one analyzed article against the rule.
 *
 * STRICT AND SEMANTICS — an article is sent only when every configured minimum
 * is met (importance, relevance, and novelty when it is above zero) and the
 * optional category/`shouldSend` restrictions pass.
 *
 * There is deliberately NO `shouldSend === true` shortcut: the previous
 * implementation sent any AI-recommended article with importance >= 40 even
 * when its relevance score was near zero, which is exactly how off-topic news
 * reached the channel. A high importance score must never compensate for low
 * relevance.
 */
export function evaluateArticle(article: NewsRow, rule: AutoSendRule): RuleCheck {
  const reasons: string[] = [];

  if (!article.analyzedAt || !article.summary?.trim()) {
    return { matches: false, reasons: ["not_analyzed"] };
  }

  // Phase 3 (#9): a "no" from the two-stage relevance grader is a hard veto —
  // borderline relevance must never slip through on a high importance score.
  if (article.relevanceGrade === "rejected") {
    reasons.push("grader_rejected");
    return { matches: false, reasons };
  }

  // Phase 3 (#10): multi-source confirmation gives a small importance bonus
  // (relevance is NEVER touched — the AND rule stays strict).
  const importance =
    (article.importanceScore ?? 0) + ((article.corroborationCount ?? 0) >= 2 ? CORROBORATION_BONUS : 0);
  const relevance = article.relevanceScore ?? 0;
  const novelty = article.noveltyScore ?? 0;

  if (importance < rule.minImportance) reasons.push("importance_below_threshold");
  if (relevance < rule.minRelevance) reasons.push("relevance_below_threshold");
  if (novelty < rule.minNovelty) reasons.push("novelty_below_threshold");

  // An explicit AI veto is only enforced when the operator opted in; otherwise
  // the numeric thresholds above are the single source of truth.
  if (rule.requireAiRecommendation && article.shouldSend !== true) {
    reasons.push("ai_no_recommendation");
  }

  if (rule.categories && !rule.categories.includes((article.category ?? "").trim())) {
    reasons.push("category_excluded");
  }

  return { matches: reasons.length === 0, reasons };
}

/** Persian, human-readable summary of the active policy for the Dashboard. */
export function describeRule(rule: AutoSendRule): string[] {
  const destinationLabel =
    rule.destination === "both" ? "Local و بله" : rule.destination === "bale" ? "بله" : "Local";

  const lines = [
    rule.enabled ? "ارسال خودکار: روشن 🤖" : "ارسال خودکار: خاموش",
    `مقصد خودکار: ${destinationLabel}`,
    `حداقل اهمیت: ${rule.minImportance}٪`,
    `حداقل مرتبط بودن: ${rule.minRelevance}٪`,
    "منطق ارسال: همهٔ حد نصاب‌ها باید هم‌زمان برقرار باشند (AND)",
  ];

  if (rule.minNovelty > 0) lines.push(`حداقل تازگی: ${rule.minNovelty}٪`);
  if (rule.requireAiRecommendation) lines.push("الزام تأیید هوش مصنوعی (shouldSend)");
  if (rule.categories) lines.push(`دسته‌های مجاز: ${rule.categories.join("، ")}`);

  return lines;
}
