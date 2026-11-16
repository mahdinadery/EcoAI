import { db } from "@/db";
import { news } from "@/db/schema";
import { checkAdminAccess } from "@/lib/admin/access";
import { runAutoDeliveryPass } from "@/lib/agent";
import type { AutoSendSummary } from "@/lib/agent/auto-hook";
import { describeRejectionReasons } from "@/lib/agent/rejection-reasons";
import { resolveAutoSendRule } from "@/lib/agent/resolve-rule";
import {
  createAiConfigVersion,
  getActiveAiConfig,
  validateAiConfigInput,
} from "@/lib/ai/config-service";
import type { AiConfigInput } from "@/lib/ai/config-types";
import {
  BULK_ANALYSIS,
  clampBulkConcurrency,
  clampBulkTarget,
  estimateItemMs,
  planBulkChunk,
  type BulkStopReason,
} from "@/lib/news/bulk-analysis";
import { analyzeSequentially, applyTopicGate, sweepOfftopicBacklog } from "@/lib/news/analysis-queue";
import { drainArticleQueue } from "@/lib/news/article-queue";
import { getNewsStatusSummary } from "@/lib/news/news-admin";
import {
  AI_ECONOMICS_PACK,
  appendAudienceNote,
  mergeBlockedKeywords,
  mergePackTopics,
} from "@/lib/news/news-packs";
import { evaluateTopicFilter } from "@/lib/news/topic-filter";
import { asc, inArray, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type QueueActionBody = {
  action?: "analyze_batch" | "analyze_backlog" | "apply_ai_pack_filter" | "retry_failed" | "send_ready_to_bale";
  limit?: number;
  concurrency?: number;
};

/** Rows a bulk run may still analyze: never-delivered *and* not in flight. */
const BULK_QUEUE_SQL = sql`${news.analyzedAt} IS NULL AND ${news.status} IN ('READY_FOR_AI', 'FETCHED', 'FAILED')`;

async function restoreSidelinedUnanalyzed(): Promise<number> {
  const restored = await db
    .update(news)
    .set({ status: "READY_FOR_AI", updatedAt: new Date() })
    .where(sql`${news.analyzedAt} IS NULL AND ${news.status} = 'FETCHED'`)
    .returning({ id: news.id });
  return restored.length;
}

function explainZeroSend(autoSend: AutoSendSummary | null): string {
  if (!autoSend) return "";
  if (autoSend.sent > 0) {
    const targetLabel =
      autoSend.destination === "bale"
        ? "کانال بله"
        : autoSend.destination === "both"
          ? "بله و صندوق محلی"
          : "صندوق محلی (Local — نه بله!)";
    return ` و ${autoSend.sent} پیام به ${targetLabel} ارسال شد`;
  }
  if (autoSend.heldForBulletin) {
    return " (ارسال تکی متوقف است چون زمان‌بندی روی حالت «فقط بولتن» قرار دارد)";
  }
  if (!autoSend.enabled) {
    return " (ارسال خودکار در تنظیمات خاموش است)";
  }
  if (autoSend.firstError) {
    return ` (خطای ارسال به ${autoSend.destination}: ${autoSend.firstError})`;
  }
  if (autoSend.destination === "local") {
    return " (توجه: مقصد ارسال خودکار روی Local است؛ توکن/شناسه بله یا مقصد ارسال خودکار را روی «بله» تنظیم کنید)";
  }
  if (autoSend.firstRejectionReason) {
    return ` (هیچ موردی حد نصاب ارسال را نداشت: ${autoSend.firstRejectionReason})`;
  }
  return "";
}

export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  let body: QueueActionBody;
  try {
    body = (await request.json()) as QueueActionBody;
  } catch {
    body = {};
  }

  const action = body.action ?? "analyze_batch";

  try {
    if (action === "send_ready_to_bale") {
      const baseRule = await resolveAutoSendRule();
      const baleRule = {
        ...baseRule,
        enabled: true,
        destination: baseRule.destination === "both" ? ("both" as const) : ("bale" as const),
        minImportance: Math.min(baseRule.minImportance, 55),
        minRelevance: Math.min(baseRule.minRelevance, 55),
        minNovelty: 0,
        requireAiRecommendation: false,
        maxItemsPerPass: Math.max(1, Math.min(25, Math.round(body.limit ?? 20))),
      };

      const pass = await runAutoDeliveryPass({ rule: baleRule });
      if (pass.busy) {
        return Response.json({ success: false, action, message: "صف در حال پردازش است؛ پس از پایان آن دوباره تلاش کنید." }, { status: 409 });
      }
      const summary = await getNewsStatusSummary();
      const failedEntry = pass.items.find((item) => item.outcome === "failed" && item.errors?.length);
      const rejectedEntries = pass.items.filter(
        (item) => (item.outcome === "not_matched" || item.outcome === "skipped_review") && item.reasons?.length,
      );

      if (pass.sent > 0) {
        return Response.json({
          success: true,
          action,
          autoSent: pass.sent,
          failed: pass.failed,
          remainingReady: summary.byStatus.READY_FOR_AI ?? 0,
          remainingReadyToSend: summary.byStatus.READY_TO_SEND ?? 0,
          firstError: failedEntry?.errors?.[0] ?? null,
          summary,
          message: `${pass.sent} مقالهٔ مرتبط و بااهمیت با موفقیت به کانال بله ارسال شد ✓.`,
        });
      }

      const reasonText = failedEntry?.errors?.[0]
        ? `خطای اتصال/ارسال به بله: ${failedEntry.errors[0]}`
        : pass.considered === 0
          ? "تمام مقالات تحلیل‌شدهٔ واجد شرایط قبلاً به بله ارسال شده‌اند."
          : rejectedEntries.length > 0
            ? `از ${pass.considered} مقالهٔ بررسی‌شده، هیچ‌کدام مرتبط و بااهمیت تشخیص داده نشد (اهمیت ≥ ${baleRule.minImportance} و ارتباط ≥ ${baleRule.minRelevance}) — نمونه: «${rejectedEntries[0].title.slice(0, 60)}…» ← ${describeRejectionReasons(rejectedEntries[0].reasons)}`
            : "تمام مقالات مرتبط و بااهمیت قبلاً به بله ارسال شده‌اند.";

      return Response.json({
        success: true,
        action,
        autoSent: 0,
        failed: pass.failed,
        remainingReady: summary.byStatus.READY_FOR_AI ?? 0,
        remainingReadyToSend: summary.byStatus.READY_TO_SEND ?? 0,
        firstError: failedEntry?.errors?.[0] ?? null,
        summary,
        message: pass.failed > 0 ? `ارسال ناموفق — ${reasonText}` : reasonText,
      });
    }

    if (action === "analyze_batch") {
      const batchSize = Math.max(1, Math.min(24, Math.round(body.limit ?? 15)));
      const queue = await drainArticleQueue({ limit: batchSize, maxDurationMs: 46_000 });
      const summary = await getNewsStatusSummary();
      const autoSend: AutoSendSummary = {
        attempted: !queue.busy,
        ...queue.send,
        firstError: queue.blocked,
      };
      const analyzed = queue.analyzed.filter((item) => item.ok).length;
      const failed = queue.analyzed.filter((item) => !item.ok).length;
      return Response.json({
        success: true,
        action,
        analyzed,
        failed,
        skippedOfftopic: queue.skipped.length,
        autoSent: autoSend.sent,
        remainingReady: summary.byStatus.READY_FOR_AI ?? 0,
        firstError: queue.blocked,
        busy: queue.busy,
        summary,
        message: queue.blocked
          ? `صف به ترتیب ورود متوقف یا در انتظار است: ${queue.blocked}`
          : `${analyzed} مقاله به ترتیب ورود تحلیل شد${queue.skipped.length ? `، ${queue.skipped.length} مورد غیرمرتبط کنار گذاشته شد` : ""}${explainZeroSend(autoSend)}.`,
      });
    }

    if (action === "analyze_backlog") {
      // Analysis only, several articles at a time, no queue lock and no
      // delivery: an operator with spare API quota can drain a backlog without
      // waiting for the serial queue (~10 articles/minute) to work through it.
      // Sending stays entirely policy-driven — the next auto pass (or the manual
      // «ارسال آماده‌ها») picks the results up in arrival order.
      const target = clampBulkTarget(body.limit);
      const concurrency = clampBulkConcurrency(body.concurrency);
      const startedAt = Date.now();
      let attempted = 0;
      let analyzed = 0;
      let failed = 0;
      let inFlight = 0;
      let skippedOfftopic = 0;
      let queueRemaining = 0;
      let itemMs: number = BULK_ANALYSIS.estimatedItemMs;
      let stopReason: BulkStopReason = "ok";
      let firstError: string | null = null;

      for (let wave = 0; wave < 60; wave += 1) {
        const [countRow] = await db
          .select({ count: sql`count(*)::int` })
          .from(news)
          .where(BULK_QUEUE_SQL);
        queueRemaining = Number(countRow?.count ?? 0);

        const plan = planBulkChunk({
          targetRemaining: target - attempted,
          queueRemaining,
          elapsedMs: Date.now() - startedAt,
          concurrency,
          itemMs,
        });
        if (!plan.run) {
          stopReason = plan.reason;
          break;
        }

        const rows = await db
          .select({ id: news.id })
          .from(news)
          .where(BULK_QUEUE_SQL)
          .orderBy(asc(news.createdAt), asc(news.id))
          .limit(plan.chunk);
        if (rows.length === 0) {
          stopReason = "queue_empty";
          break;
        }

        attempted += rows.length;
        const waveStartedAt = Date.now();
        const gated = await applyTopicGate(rows.map((row) => row.id));
        skippedOfftopic += gated.skipped.length;
        if (gated.pass.length === 0) continue;

        const results = await analyzeSequentially(gated.pass, {
          concurrency: plan.concurrency,
          // Never start work the request cannot finish inside its own budget.
          maxDurationMs: Math.max(5_000, BULK_ANALYSIS.budgetMs - (Date.now() - startedAt)),
        });

        const failures = results.filter((entry) => !entry.ok);
        // A row another worker is holding is not this run's failure.
        const busyEntries = failures.filter((entry) => entry.code === "already_processing");
        const realFailures = failures.filter((entry) => entry.code !== "already_processing");

        analyzed += results.length - failures.length;
        inFlight += busyEntries.length;
        failed += realFailures.length;
        itemMs = estimateItemMs({
          previousItemMs: itemMs,
          waveElapsedMs: Date.now() - waveStartedAt,
          waveCompleted: results.length,
        });
        if (realFailures.length && !firstError) {
          firstError = `${realFailures[0].message ?? realFailures[0].code ?? "تحلیل ناموفق بود"}${
            realFailures[0].detail ? ` (${realFailures[0].detail.slice(0, 140)})` : ""
          }`;
        }

        if (results.length < gated.pass.length) {
          // The pool cut the wave short: either the time budget ran out or the
          // provider failed fatally (auth/quota), which trips its circuit breaker.
          stopReason = "budget_exhausted";
          break;
        }
      }

      const summary = await getNewsStatusSummary();
      const remaining = summary.byStatus.READY_FOR_AI ?? 0;
      // Truthful number for the sentence below: the bulk queue is broader than
      // READY_FOR_AI (it also covers sidelined FETCHED and FAILED rows), so
      // counting only READY_FOR_AI could claim "empty" while work remained.
      const [tailRow] = await db.select({ count: sql`count(*)::int` }).from(news).where(BULK_QUEUE_SQL);
      const remainingQueue = Number(tailRow?.count ?? 0);
      const tail =
        stopReason === "queue_empty" || remainingQueue === 0
          ? "صف تحلیل خالی شد ✓"
          : stopReason === "budget_exhausted"
            ? `زمان این درخواست تمام شد — با یک کلیک دیگر از همان نقطه ادامه می‌دهد (باقی‌مانده: ${remainingQueue.toLocaleString("fa-IR")}).`
            : `باقی‌ماندهٔ صف: ${remainingQueue.toLocaleString("fa-IR")}.`;

      return Response.json({
        success: true,
        action,
        analyzed,
        failed,
        inFlight,
        skippedOfftopic,
        attempted,
        target,
        concurrency,
        stopReason,
        elapsedMs: Date.now() - startedAt,
        firstError,
        remainingReady: remaining,
        remainingQueue,
        summary,
        message:
          analyzed === 0 && attempted === 0
            ? "مقالهٔ تحلیل‌نشده‌ای در صف نبود."
            : `تحلیل انبوه: ${analyzed.toLocaleString("fa-IR")} مقاله (${attempted.toLocaleString("fa-IR")} تلاش، ` +
              `${skippedOfftopic.toLocaleString("fa-IR")} غیرمرتبط، ${failed.toLocaleString("fa-IR")} خطا` +
              `${inFlight ? `، ${inFlight} در دست عملیات دیگر` : ""}) — ` +
              (firstError ? `نخستین خطا: ${firstError}. ` : "") +
              `${tail} این حالت فقط تحلیل می‌کند؛ ارسال بر عهدهٔ سیاست ارسال خودکار یا دکمهٔ «ارسال» است.`,
      });
    }

    if (action === "retry_failed") {
      const requeued = await db
        .update(news)
        .set({ status: "READY_FOR_AI", updatedAt: new Date() })
        .where(
          sql`${news.analyzedAt} IS NULL AND ${news.status} IN ('FAILED', 'FETCHED')`,
        )
        .returning({ id: news.id });
      const summary = await getNewsStatusSummary();
      return Response.json({
        success: true,
        action,
        requeued: requeued.length,
        remainingReady: summary.byStatus.READY_FOR_AI ?? 0,
        summary,
        message:
          requeued.length > 0
            ? `${requeued.length} مقاله بدون محدودیت زمانی دوباره به صف «آماده تحلیل AI» بازگردانده شد.`
            : "مقالهٔ خطادار یا خارج‌شده‌ای برای بازگردانی یافت نشد.",
      });
    }

    if (action === "apply_ai_pack_filter") {
      const restoredCount = await restoreSidelinedUnanalyzed();

      const active = await getActiveAiConfig();
      const merged = mergePackTopics(active.topicFilter?.topics ?? [], AI_ECONOMICS_PACK);
      const mergedBlocked = mergeBlockedKeywords(
        active.topicFilter?.blockedKeywords ?? [],
        AI_ECONOMICS_PACK,
      );
      const audience = appendAudienceNote(active.systemPrompt, AI_ECONOMICS_PACK);
      const nextTopicFilter = {
        baselineBlockedKeywords: active.topicFilter?.baselineBlockedKeywords,
        enabled: true,
        mode: "include" as const,
        topics: merged.topics,
        blockedKeywords: mergedBlocked.blockedKeywords,
      };

      const needsSave =
        !active.topicFilter?.enabled ||
        active.topicFilter.mode !== "include" ||
        merged.added.length > 0 ||
        mergedBlocked.added.length > 0 ||
        !audience.alreadyPresent;

      if (needsSave) {
        const input: AiConfigInput = {
          name: active.name,
          provider: active.provider,
          model: active.model,
          systemPrompt: audience.prompt,
          audienceFocus: active.audienceFocus,
          temperature: active.temperature,
          maxTokens: active.maxTokens,
          features: active.features,
          decisionRules: active.decisionRules,
          outputSchema: active.outputSchema,
          publishingTemplate: active.publishingTemplate,
          topicFilter: nextTopicFilter,
          autoSendPolicy: active.autoSendPolicy,
        };
        const validation = validateAiConfigInput(input);
        if (validation.valid) {
          await createAiConfigVersion(input, { activate: true });
        }
      }

      const richPending = await db
        .select({
          id: news.id,
          title: news.title,
          description: news.description,
          content: news.content,
        })
        .from(news)
        .where(sql`${news.analyzedAt} IS NULL AND ${news.status} IN ('READY_FOR_AI', 'FAILED')`)
        .limit(1000);

      const bulkSkipIds: string[] = [];
      for (const row of richPending) {
        const check = evaluateTopicFilter(row, nextTopicFilter);
        if (
          check.verdict === "skip" &&
          (check.reason !== "not_in_selected_topics" ||
            (row.content ?? "").trim().length >= 300)
        ) {
          bulkSkipIds.push(row.id);
        }
      }
      if (bulkSkipIds.length > 0) {
        await db
          .update(news)
          .set({ status: "SKIPPED_OFFTOPIC", updatedAt: new Date() })
          .where(inArray(news.id, bulkSkipIds));
      }

      const leadSwept = await sweepOfftopicBacklog();
      const totalSwept = bulkSkipIds.length + leadSwept.swept;
      const summary = await getNewsStatusSummary();

      return Response.json({
        success: true,
        action,
        packApplied: needsSave,
        restoredCount,
        sweptOfftopic: totalSwept,
        remainingReady: summary.byStatus.READY_FOR_AI ?? 0,
        summary,
        message: `فیلتر موضوعی اقتصاد هوش مصنوعی بدون حذف هیچ مقالهٔ قدیمی اعمال شد: ${totalSwept} مورد غیرمرتبط کنار گذاشته شد${restoredCount > 0 ? `، ${restoredCount} مقاله به صف بازگردانده شد` : ""} و تمام ${summary.byStatus.READY_FOR_AI ?? 0} مقالهٔ مرتبط در صف تحلیل حفظ شدند.`,
      });
    }

    return Response.json({ success: false, message: "عملیات درخواستی نامعتبر است." }, { status: 400 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json(
      { success: false, message: "خطا در پردازش صف مقالات.", detail: detail.slice(0, 240) },
      { status: 500 },
    );
  }
}
