/**
 * Auto-delivery engine (Milestone 6) — SERVER-SIDE ONLY.
 *
 *   Analyzed News -> Rule -> Delivery Service -> Local | Bale
 *
 * This is the decision layer that sits between analysis and delivery. It is a
 * pure, idempotent pass: it only reads news that already carries an AI analysis,
 * applies the configured rule, and delegates every send to the existing delivery
 * service so duplicate protection and persistence stay shared (no duplicated
 * delivery logic). No scheduler lives here — a pass runs when an event happens
 * (after fetch / after analysis) or when the user triggers it explicitly.
 */

import { db } from "@/db";
import { deliveries, news, type NewsRow } from "@/db/schema";
import { sendNewsDelivery } from "@/lib/delivery";
import { expandTargets } from "@/lib/delivery/types";
import { and, desc, inArray, sql } from "drizzle-orm";
import { resolveAutoSendRule } from "./resolve-rule";
import { evaluateArticle, type AutoSendRule } from "./rules";

export type AutoSendItem = {
  id: string;
  title: string;
  outcome: "sent" | "partially_sent" | "failed" | "already_sent" | "skipped_review" | "not_matched";
  reasons?: string[];
  errors?: string[];
};

export type AutoPassResult = {
  enabled: boolean;
  destination: string;
  considered: number;
  matched: number;
  sent: number;
  skippedDuplicates: number;
  /** Articles deferred because an open manual publishing candidate exists. */
  skippedReview: number;
  failed: number;
  items: AutoSendItem[];
};

const NOT_MATCHED: AutoPassResult = {
  enabled: false,
  destination: "",
  considered: 0,
  matched: 0,
  sent: 0,
  skippedDuplicates: 0,
  skippedReview: 0,
  failed: 0,
  items: [],
};

/** News ids that already have an OPEN candidate for any auto destination. */
async function findPendingReviewIds(newsIds: string[], rule: AutoSendRule): Promise<Set<string>> {
  const pending = new Set<string>();
  if (newsIds.length === 0) return pending;

  try {
    const targets = expandTargets(rule.destination);
    const rows = await db
      .select({ newsId: deliveries.newsId })
      .from(deliveries)
      .where(
        and(
          inArray(deliveries.newsId, newsIds),
          inArray(deliveries.destination, targets),
          sql`${deliveries.status} IN ('pending_approval', 'approved')`,
        ),
      );
    for (const row of rows) pending.add(row.newsId);
  } catch (error) {
    // Fail open on the lookup itself (sending still has its own duplicate guard).
    console.error("[agent] pending-review lookup failed:", String(error).slice(0, 160));
  }
  return pending;
}

async function loadCandidates(rule: AutoSendRule, newsIds?: string[]): Promise<NewsRow[]> {
  if (newsIds && newsIds.length > 0) {
    return db.select().from(news).where(inArray(news.id, newsIds)).limit(rule.maxItemsPerPass);
  }

  // Only already-analyzed articles are eligible; nothing here triggers analysis.
  return db
    .select()
    .from(news)
    .where(sql`${news.analyzedAt} IS NOT NULL AND ${news.summary} IS NOT NULL AND ${news.summary} <> ''`)
    .orderBy(desc(sql`coalesce(${news.publishedAt}, ${news.createdAt})`))
    .limit(rule.maxItemsPerPass);
}

/**
 * Runs one auto-delivery pass. Never throws: a broken provider or DB read is
 * reported in the result instead of bubbling up to the caller.
 */
export async function runAutoDeliveryPass(
  options: { newsIds?: string[]; force?: boolean; rule?: AutoSendRule } = {},
): Promise<AutoPassResult> {
  // The scheduled publisher passes its own rule so its configured time slots,
  // destination and thresholds stay independent from the "after analysis"
  // auto-send policy.
  const rule = options.rule ?? (await resolveAutoSendRule());

  if (!rule.enabled && !options.force) {
    return { ...NOT_MATCHED, destination: rule.destination };
  }

  let candidates: NewsRow[];
  try {
    candidates = await loadCandidates(rule, options.newsIds);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[agent] could not load candidates:", detail.slice(0, 160));
    return { ...NOT_MATCHED, enabled: rule.enabled, destination: rule.destination };
  }

  // Auto-send must never bypass the controlled publishing workflow: when an
  // OPEN candidate (pending_approval/approved) already exists for one of the
  // auto destinations, the article is under manual review and this pass defers
  // to it (observed in production as `sent|auto` rows racing `pending_approval|
  // manual` candidates for the same news).
  const pendingReviewIds = await findPendingReviewIds(
    candidates.map((article) => article.id),
    rule,
  );

  const result: AutoPassResult = {
    enabled: rule.enabled,
    destination: rule.destination,
    considered: candidates.length,
    matched: 0,
    sent: 0,
    skippedDuplicates: 0,
    skippedReview: 0,
    failed: 0,
    items: [],
  };

  for (const article of candidates) {
    if (pendingReviewIds.has(article.id)) {
      result.skippedReview += 1;
      result.items.push({
        id: article.id,
        title: article.title,
        outcome: "skipped_review",
        reasons: ["pending_manual_review"],
      });
      continue;
    }

    const check = options.force ? { matches: true, reasons: [] as string[] } : evaluateArticle(article, rule);

    if (!check.matches) {
      result.items.push({
        id: article.id,
        title: article.title,
        outcome: "not_matched",
        reasons: check.reasons,
      });
      continue;
    }

    result.matched += 1;

    // Delegates to the shared delivery service: per-destination duplicate
    // protection, provider truthfulness and ledger writing all live there.
    const sendResult = await sendNewsDelivery(article.id, rule.destination, { trigger: "auto" });

    if (!sendResult.ok) {
      result.failed += 1;
      result.items.push({
        id: article.id,
        title: article.title,
        outcome: "failed",
        errors: [sendResult.message],
      });
      continue;
    }

    const statuses = sendResult.results.map((entry) => entry.status);
    const sentCount = statuses.filter((status) => status === "sent").length;
    const alreadyCount = statuses.filter((status) => status === "already_sent").length;
    const failedCount = statuses.filter((status) => status === "failed").length;
    const errors = sendResult.results
      .filter((entry) => entry.status === "failed")
      .map((entry) => `${entry.destination}: ${entry.errorMessage ?? "failed"}`);

    if (sentCount > 0) result.sent += 1;
    if (alreadyCount > 0 && sentCount === 0) result.skippedDuplicates += 1;
    if (failedCount > 0) result.failed += 1;

    result.items.push({
      id: article.id,
      title: article.title,
      outcome: sentCount > 0 ? (failedCount > 0 ? "partially_sent" : "sent") : failedCount > 0 ? "failed" : "already_sent",
      errors: errors.length > 0 ? errors : undefined,
    });
  }

  return result;
}

export { loadAutoSendRule, describeRule, evaluateArticle } from "./rules";
export { resolveAutoSendRule, policyToRule } from "./resolve-rule";
export type { AutoSendRule };
