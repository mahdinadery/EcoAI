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
import { and, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import { applyActiveSendFloors, resolveAutoSendRule } from "./resolve-rule";
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

/**
 * Clears stale `relevanceGrade = 'rejected'` flags inherited from the legacy
 * breaking-news borderline grader on papers that the main AI analysis explicitly
 * marked `shouldSend = true` (`READY_TO_SEND`) or scored `>= 55` on both axes.
 */
async function healFalseGraderVetoes(): Promise<void> {
  try {
    await db
      .update(news)
      .set({
        relevanceGrade: null,
        status: sql`CASE WHEN ${news.shouldSend} = true AND ${news.status} = 'AI_ANALYZED' THEN 'READY_TO_SEND' ELSE ${news.status} END`,
        updatedAt: new Date(),
      })
      .where(
        sql`${news.relevanceGrade} = 'rejected' AND (${news.shouldSend} = true OR (coalesce(${news.importanceScore}, 0) >= 55 AND coalesce(${news.relevanceScore}, 0) >= 55))`,
      );
  } catch {
    // Non-blocking self-heal
  }
}

/** News ids that have a fresh (< 12h) OPEN manual-review candidate for any auto destination. */
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
          sql`${deliveries.status} IN ('pending_approval', 'approved') AND ${deliveries.createdAt} >= now() - interval '12 hours'`,
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
    return db.select().from(news).where(inArray(news.id, newsIds)).limit(Math.max(rule.maxItemsPerPass, 25));
  }

  const targets = expandTargets(rule.destination);
  const batchCap = Math.max(rule.maxItemsPerPass, 25);

  // Exclude duplicates, off-topic rows, and articles already delivered to ALL
  // target destinations (so articles previously sent only to `local` are still
  // picked up for `bale`!). `READY_TO_SEND` (`shouldSend = true`) and qualifying
  // papers are ordered ahead of non-matching rows so all relevant & important
  // papers are delivered without head-of-line blocking.
  return db
    .select()
    .from(news)
    .where(
      and(
        sql`${news.analyzedAt} IS NOT NULL AND coalesce(${news.summary}, '') <> ''`,
        sql`${news.status} NOT IN ('DUPLICATE', 'SKIPPED_OFFTOPIC')`,
        ...targets.map((dest) =>
          notExists(
            db
              .select({ one: sql`1` })
              .from(deliveries)
              .where(
                and(
                  eq(deliveries.newsId, news.id),
                  eq(deliveries.destination, dest),
                  eq(deliveries.status, "sent"),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(
      sql`CASE WHEN (${news.shouldSend} = true AND coalesce(${news.importanceScore}, 0) >= 50 AND coalesce(${news.relevanceScore}, 0) >= 50) OR (coalesce(${news.importanceScore}, 0) >= ${rule.minImportance} AND coalesce(${news.relevanceScore}, 0) >= ${rule.minRelevance}) THEN 0 ELSE 1 END ASC`,
      desc(sql`coalesce(${news.publishedAt}, ${news.createdAt})`),
    )
    .limit(batchCap);
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
  // auto-send policy, while still honoring active `decisionRules` floors.
  const rule = options.rule
    ? await applyActiveSendFloors(options.rule)
    : await resolveAutoSendRule();

  if (!rule.enabled && !options.force) {
    return { ...NOT_MATCHED, destination: rule.destination };
  }

  await healFalseGraderVetoes();

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

    // A paper explicitly flagged `shouldSend === true` (`READY_TO_SEND`) by the AI
    // with solid relevance & importance (`>= 50`) is also eligible even when a
    // custom slider was left higher, so `READY_TO_SEND` papers are never stranded.
    const aiApprovedPaper =
      !rule.categories &&
      article.relevanceGrade !== "rejected" &&
      article.shouldSend === true &&
      (article.importanceScore ?? 0) >= 50 &&
      (article.relevanceScore ?? 0) >= 50 &&
      (article.noveltyScore ?? 0) >= rule.minNovelty;

    const check = options.force || aiApprovedPaper
      ? { matches: true, reasons: [] as string[] }
      : evaluateArticle(article, rule);

    if (!check.matches) {
      result.items.push({
        id: article.id,
        title: article.title,
        outcome: "not_matched",
        reasons: check.reasons,
      });
      continue;
    }

    if (result.matched > 0 && rule.destination !== "local") {
      // Gentle 300ms pacing between consecutive Bale Bot API sends to avoid per-second flood limits.
      await new Promise((resolve) => setTimeout(resolve, 300));
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
