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
import { and, asc, desc, eq, inArray, notExists, or, sql } from "drizzle-orm";
import { withArticleQueueLock } from "@/lib/news/queue-lock";
import { applyActiveSendFloors, resolveAutoSendRule } from "./resolve-rule";
import { describeRejectionReasons, rejectionReasonLabel } from "./rejection-reasons";
import { evaluateArticle, readAutoSendMaxAgeDays, readAutoSendQueueGraceMinutes, type AutoSendRule } from "./rules";

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
  /** Another automatic queue pass owns the database lock. */
  busy?: boolean;
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

/** Arrival-order blockers: rows the analysis queue still has to work through. */
const PENDING_QUEUE_STATUSES = ["FETCHED", "READY_FOR_AI", "AI_PROCESSING", "FAILED"] as const;

/**
 * Older rows that still deserve to be published first.
 *
 * The rule is "do not overtake an older article the queue is *actively*
 * working": the row is in flight right now, or a worker touched it within the
 * grace window. It deliberately does NOT mean "never publish while any older
 * article is unanalyzed" — with an analysis backlog that always has an older
 * unanalyzed row, so an unbounded guard silences the channel forever (that is
 * exactly why relevant, important papers were analyzed but never sent).
 */
function queueBlockerSubquery(olderThan: { createdAt: unknown; id: unknown }, graceMinutes: number) {
  const pendingStatusList = sql.join(
    PENDING_QUEUE_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  return sql`SELECT 1 FROM news AS older
     WHERE older.analyzed_at IS NULL
       AND older.status IN (${pendingStatusList})
       AND (older.created_at, older.id) < (${olderThan.createdAt}, ${olderThan.id})
       AND (older.status = 'AI_PROCESSING' OR older.updated_at >= now() - make_interval(mins => ${graceMinutes}::int))`;
}

/**
 * How many *actively queued* older rows still stand in front of this article.
 * Used only by the explanation path, never to decide eligibility twice.
 */
async function countQueueBlockers(article: { createdAt: Date; id: string }, graceMinutes: number): Promise<number> {
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(news)
      .where(
        and(
          sql`${news.analyzedAt} IS NULL`,
          inArray(news.status, [...PENDING_QUEUE_STATUSES]),
          sql`(${news.createdAt}, ${news.id}) < (${article.createdAt}::timestamptz, ${article.id}::uuid)`,
          sql`(${news.status} = 'AI_PROCESSING' OR ${news.updatedAt} >= now() - make_interval(mins => ${graceMinutes}::int))`,
        ),
      );
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

async function loadCandidates(rule: AutoSendRule, newsIds?: string[], force = false): Promise<NewsRow[]> {
  if (newsIds && newsIds.length === 0) return [];

  const targets = expandTargets(rule.destination);
  const batchCap = Math.max(rule.maxItemsPerPass, 25);
  const graceMinutes = readAutoSendQueueGraceMinutes();

  // Bounded arrival-order guard (see `queueBlockerSubquery`). `force` is the
  // operator's explicit catch-up and never waits for the analysis queue.
  const queueGuard = force
    ? undefined
    : sql`NOT EXISTS (${queueBlockerSubquery({ createdAt: news.createdAt, id: news.id }, graceMinutes)})`;

  // Auto-publishing must not resurrect an old backlog in one go; the freshness
  // window keeps the channel current while everything stays in the library for
  // manual sending. `force` (explicit operator catch-up) ignores it.
  const maxAgeDays = readAutoSendMaxAgeDays();
  const withinAgeWindow =
    force || maxAgeDays <= 0
      ? undefined
      : sql`${news.createdAt} >= now() - make_interval(days => ${maxAgeDays}::int)`;

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
        newsIds ? inArray(news.id, newsIds) : sql`true`,
        sql`${news.analyzedAt} IS NOT NULL AND coalesce(${news.summary}, '') <> ''`,
        sql`${news.status} NOT IN ('DUPLICATE', 'SKIPPED_OFFTOPIC')`,
        withinAgeWindow,
        queueGuard,
        // Avoid head-of-line starvation by rows that cannot match the rule.
        force ? sql`true` : and(
          sql`${news.relevanceGrade} IS DISTINCT FROM 'rejected'`,
          or(
            and(
              sql`coalesce(${news.importanceScore}, 0) >= ${rule.minImportance}`,
              sql`coalesce(${news.relevanceScore}, 0) >= ${rule.minRelevance}`,
              sql`coalesce(${news.noveltyScore}, 0) >= ${rule.minNovelty}`,
              rule.requireAiRecommendation ? eq(news.shouldSend, true) : sql`true`,
              rule.categories ? sql`btrim(coalesce(${news.category}, '')) IN (${sql.join(rule.categories.map((category) => sql`${category}`), sql`, `)})` : sql`true`,
            ),
            !rule.categories ? and(
              eq(news.shouldSend, true),
              sql`coalesce(${news.importanceScore}, 0) >= 50`,
              sql`coalesce(${news.relevanceScore}, 0) >= 50`,
              sql`coalesce(${news.noveltyScore}, 0) >= ${rule.minNovelty}`,
            ) : undefined,
          ),
        ),
        sql`NOT EXISTS (SELECT 1 FROM deliveries AS review WHERE review.news_id = ${news.id} AND review.destination IN (${sql.join(targets.map((target) => sql`${target}`), sql`, `)}) AND review.status IN ('pending_approval', 'approved') AND review.created_at >= now() - interval '12 hours')`,
        or(...targets.map((dest) =>
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
        )),
      ),
    )
    .orderBy(asc(news.createdAt), asc(news.id))
    .limit(batchCap);
}

/**
 * Why was THIS analyzed article not sent automatically?
 *
 * `runAutoDeliveryPass` only reports aggregate counters, so the UI had to fall
 * back to the catch-all "this news is not covered by the auto-send rules"
 * message — even when the article actually passed every threshold and something
 * else (an open manual-review candidate, an already delivered destination, a
 * stale backlog, the queue guard) held it back. This function answers with the
 * real, single reason. It is deliberately read-only and never throws.
 */
export type AutoSendSkip = {
  code: string;
  /** Persian, operator-facing explanation. */
  label: string;
  /** Optional next step for the operator. */
  hint?: string;
};

export async function explainAutoSendSkip(newsId: string): Promise<AutoSendSkip | null> {
  try {
    const rule = await resolveAutoSendRule();
    const [article] = await db.select().from(news).where(eq(news.id, newsId)).limit(1);
    if (!article) return null;

    if (!article.analyzedAt || !article.summary?.trim()) {
      return { code: "not_analyzed", label: rejectionReasonLabel("not_analyzed") };
    }

    const targets = expandTargets(rule.destination);
    if (rule.destination === "local") {
      return {
        code: "destination_local",
        label: "مقصد ارسال خودکار روی «صندوق محلی» است، نه بله.",
        hint: "در کارت زمان‌بندی یا AUTO_SEND_DESTINATION مقصد را روی «بله» بگذارید.",
      };
    }

    const sentRows = await db
      .select({ destination: deliveries.destination })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.newsId, newsId),
          eq(deliveries.status, "sent"),
          inArray(deliveries.destination, targets),
        ),
      );
    if (new Set(sentRows.map((row) => row.destination)).size >= targets.length) {
      return {
        code: "already_sent",
        label: "این خبر پیش‌تر به مقصد انتخابی ارسال شده است (ارسال تکراری انجام نمی‌شود).",
      };
    }

    const [openCandidate] = await db
      .select({ status: deliveries.status, createdAt: deliveries.createdAt })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.newsId, newsId),
          inArray(deliveries.destination, targets),
          sql`${deliveries.status} IN ('pending_approval', 'approved')`,
          // Mirrors `loadCandidates`: only a RECENT open candidate defers the
          // automatic pass; an older stale one must not mute the channel.
          sql`${deliveries.createdAt} >= now() - interval '12 hours'`,
        ),
      )
      .orderBy(desc(deliveries.createdAt))
      .limit(1);
    if (openCandidate) {
      return {
        code: "pending_manual_review",
        label:
          openCandidate.status === "approved"
            ? "این خبر یک نامزد «تأییدشده» دارد که هنوز ارسال نشده؛ ارسال خودکار وارد رقابت با آن نمی‌شود."
            : "این خبر در صف «انتظار تأیید دستی» است؛ ارسال خودکار عمداً منتظر تصمیم شما می‌ماند.",
        hint: "از «مدیریت ارسال‌ها» این نامزد را تأیید و ارسال کنید (یا رد کنید تا دوباره مشمول ارسال خودکار شود).",
      };
    }

    const check = evaluateArticle(article, rule);
    if (!check.matches) {
      return {
        code: check.reasons[0] ?? "rule_rejected",
        label: `حد نصاب‌های ارسال برقرار نیست: ${describeRejectionReasons(check.reasons)} (حداقل اهمیت ${rule.minImportance}، ارتباط ${rule.minRelevance}، تازگی ${rule.minNovelty}).`,
      };
    }

    const maxAgeDays = readAutoSendMaxAgeDays();
    if (maxAgeDays > 0) {
      const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
      if (article.createdAt < cutoff) {
        return {
          code: "older_than_auto_window",
          label: `این خبر قدیمی‌تر از پنجرهٔ ${maxAgeDays} روزهٔ ارسال خودکار است تا انباشت قدیمی به کانال نرود.`,
          hint: "برای ارسال همین خبر، دستی «ارسال» را بزنید یا AUTO_SEND_MAX_AGE_DAYS را تغییر دهید.",
        };
      }
    }

    const waiting = await countQueueBlockers(article, readAutoSendQueueGraceMinutes());
    if (waiting > 0) {
      return {
        code: "queue_waiting",
        label: `${waiting} خبر قدیمی‌تر همین حالا در حال تحلیل هستند و صف به ترتیب ورود جلو می‌رود؛ این خبر در نوبت بعدی ارسال می‌شود.`,
        hint: "با «تحلیل دسته‌ای صف» یا اجرای زمان‌بندی‌شده، سرِ صف باز می‌شود.",
      };
    }

    return {
      code: "not_picked_this_pass",
      label: "خبر واجد شرایط است اما در این نوبت انتخاب نشد (ظرفیت هر اجرا پر شده بود)؛ نوبت بعدی آن را می‌فرستد.",
      hint: `حداکثر ${rule.maxItemsPerPass} خبر در هر اجرا ارسال می‌شود.`,
    };
  } catch (error) {
    console.error("[agent] auto-send explanation failed:", String(error).slice(0, 160));
    return null;
  }
}

/**
 * Runs one auto-delivery pass. Never throws: a broken provider or DB read is
 * reported in the result instead of bubbling up to the caller.
 */
export async function runAutoDeliveryPass(
  options: { newsIds?: string[]; force?: boolean; rule?: AutoSendRule; queueLockHeld?: boolean } = {},
): Promise<AutoPassResult> {
  if (!options.queueLockHeld) {
    const locked = await withArticleQueueLock(() => runAutoDeliveryPass({ ...options, queueLockHeld: true }));
    return locked.acquired ? locked.value : { ...NOT_MATCHED, busy: true };
  }
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
    candidates = await loadCandidates(rule, options.newsIds, options.force);
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

  // Real burst control: `maxItemsPerPass` used to only size the candidate batch
  // (with a floor of 25), so a single pass could push far more messages than the
  // operator configured — which matters exactly when a blocked backlog is
  // released at once.
  const maxSendsPerPass = Math.max(1, Math.min(100, Math.round(rule.maxItemsPerPass) || 20));

  for (const article of candidates) {
    if (result.matched >= maxSendsPerPass) break;

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
      break;
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
    // Preserve publication order if an earlier destination failed.
    if (failedCount > 0) break;
  }

  return result;
}

export { loadAutoSendRule, describeRule, evaluateArticle } from "./rules";
export { resolveAutoSendRule, policyToRule } from "./resolve-rule";
export type { AutoSendRule };
