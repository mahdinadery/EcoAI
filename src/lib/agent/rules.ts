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
import type { AiAutoSendPolicy, AiDecisionRules } from "@/lib/ai/config-types";
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
  maxAgeDays: "AUTO_SEND_MAX_AGE_DAYS",
  queueGraceMinutes: "AUTO_SEND_QUEUE_GRACE_MINUTES",
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
  /** Auto-delivery only publishes articles received this recently (0 = no limit). */
  maxAgeDays: 7,
  /** How long an older unanalyzed row may delay newer ones (minutes). */
  queueGraceMinutes: 20,
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

/**
 * How long an older, still-unanalyzed row may hold NEWER analyzed articles
 * back. A row only counts as "the queue is working on it" while it is being
 * analyzed or was touched this recently; a stalled or abandoned head must
 * never mute the channel (see `queueBlockerSubquery`).
 */
export function readAutoSendQueueGraceMinutes(
  raw: string | undefined = process.env[AUTO_SEND_ENV.queueGraceMinutes],
): number {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return DEFAULTS.queueGraceMinutes;
  if (["off", "none", "0", "بدون_انتظار"].includes(value)) return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULTS.queueGraceMinutes;
  return Math.min(parsed, 720);
}

/**
 * How many days back automatic publishing is allowed to reach.
 *
 * An unblocked pass walks the *oldest* unsent articles first, so an analysis
 * backlog that never fully drains would otherwise flood the channel with
 * month-old news the day the queue is unblocked. Manual, explicit sends
 * (`force`) and the dashboard's per-article send are never limited by this.
 *
 * `0`, `all`, `none` or `همه` disable the window (publish at any age).
 */
export function readAutoSendMaxAgeDays(raw: string | undefined = process.env[AUTO_SEND_ENV.maxAgeDays]): number {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return DEFAULTS.maxAgeDays;
  if (["0", "all", "none", "off", "همه", "بدون_محدودیت"].includes(value)) return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULTS.maxAgeDays;
  return Math.min(parsed, 3650);
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

/**
 * Upgrades the implicit `"local"` fallback to `"bale"` (or `"both"`) when
 * `AUTO_SEND_DESTINATION` was never explicitly set in env, while Bale bot
 * credentials or a Bale schedule target are already configured on the server.
 */
export function inferDefaultDestinationWhenUnset(
  baseRule: AutoSendRule,
  context: {
    envDestinationRaw?: string | null;
    baleConfigured: boolean;
    scheduleDestination?: DeliveryTarget | null;
  },
): AutoSendRule {
  const explicitEnv = (context.envDestinationRaw ?? "").trim().toLowerCase();
  if (explicitEnv && (VALID_DESTINATIONS as string[]).includes(explicitEnv)) {
    return baseRule;
  }
  if (baseRule.destination !== "local") {
    return baseRule;
  }
  if (context.baleConfigured) {
    return {
      ...baseRule,
      destination: context.scheduleDestination === "both" ? "both" : "bale",
    };
  }
  if (context.scheduleDestination === "bale" || context.scheduleDestination === "both") {
    return {
      ...baseRule,
      destination: context.scheduleDestination,
    };
  }
  return baseRule;
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

function clampThresholdFloor(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Applies the active AI configuration's `decisionRules` as hard minimum score
 * floors on any automatic / scheduled publishing rule.
 *
 * Ensures that raising minimum importance/relevance/novelty in `/admin/ai-config`
 * can never be bypassed by a looser schedule card or `AUTO_SEND_*` env value.
 */
export function enforceDecisionRuleFloors(
  rule: AutoSendRule,
  decisionRules?: Pick<AiDecisionRules, "minImportanceToSend" | "minRelevanceToSend" | "minNoveltyToSend"> | null,
): AutoSendRule {
  if (!decisionRules) return rule;
  return {
    ...rule,
    minImportance: Math.max(rule.minImportance, clampThresholdFloor(decisionRules.minImportanceToSend)),
    minRelevance: Math.max(rule.minRelevance, clampThresholdFloor(decisionRules.minRelevanceToSend)),
    minNovelty: Math.max(rule.minNovelty, clampThresholdFloor(decisionRules.minNoveltyToSend)),
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

  // Compare against the article's stored raw importance score directly so
  // corroboration bonuses can never push a lower-scored article across a strict
  // minimum importance threshold.
  const importance = article.importanceScore ?? 0;
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
  const maxAgeDays = readAutoSendMaxAgeDays();
  lines.push(
    maxAgeDays > 0
      ? `پنجرهٔ سنی ارسال خودکار: فقط خبرهای حداکثر ${maxAgeDays} روز اخیر`
      : "پنجرهٔ سنی ارسال خودکار: بدون محدودیت",
  );
  if (rule.requireAiRecommendation) lines.push("الزام تأیید هوش مصنوعی (shouldSend)");
  if (rule.categories) lines.push(`دسته‌های مجاز: ${rule.categories.join("، ")}`);

  return lines;
}
