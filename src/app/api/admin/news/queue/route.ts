import { db } from "@/db";
import { news } from "@/db/schema";
import { checkAdminAccess } from "@/lib/admin/access";
import { runAutoDeliveryPass } from "@/lib/agent";
import { maybeRunAutoSend, type AutoSendSummary } from "@/lib/agent/auto-hook";
import { describeRejectionReasons } from "@/lib/agent/rejection-reasons";
import { resolveAutoSendRule } from "@/lib/agent/resolve-rule";
import {
  createAiConfigVersion,
  getActiveAiConfig,
  validateAiConfigInput,
} from "@/lib/ai/config-service";
import type { AiConfigInput } from "@/lib/ai/config-types";
import {
  analyzeSequentially,
  applyTopicGate,
  recoverStaleProcessing,
  selectAnalysisBacklog,
  sweepOfftopicBacklog,
} from "@/lib/news/analysis-queue";
import { getNewsStatusSummary } from "@/lib/news/news-admin";
import {
  AI_ECONOMICS_PACK,
  appendAudienceNote,
  mergeBlockedKeywords,
  mergePackTopics,
} from "@/lib/news/news-packs";
import { evaluateTopicFilter } from "@/lib/news/topic-filter";
import { inArray, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type QueueActionBody = {
  action?: "analyze_batch" | "apply_ai_pack_filter" | "retry_failed" | "send_ready_to_bale";
  limit?: number;
  concurrency?: number;
};

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
        maxItemsPerPass: Math.max(1, Math.min(25, Math.round(body.limit ?? 15))),
      };

      const pass = await runAutoDeliveryPass({ rule: baleRule });
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
          firstError: failedEntry?.errors?.[0] ?? null,
          summary,
          message: `${pass.sent} مقالهٔ واجد شرایط با موفقیت به کانال بله ارسال شد ✓ (حد نصاب فعال: اهمیت ≥ ${baleRule.minImportance} و ارتباط ≥ ${baleRule.minRelevance}).`,
        });
      }

      const reasonText = failedEntry?.errors?.[0]
        ? `خطای اتصال/ارسال به بله: ${failedEntry.errors[0]}`
        : pass.considered === 0
          ? "هیچ مقالهٔ تحلیل‌شدهٔ ارسال‌نشده‌ای در دیتابیس وجود ندارد."
          : rejectedEntries.length > 0
            ? `از ${pass.considered} مقالهٔ بررسی‌شده، هیچ‌کدام به حد نصاب ارسال (اهمیت ≥ ${baleRule.minImportance} و ارتباط ≥ ${baleRule.minRelevance}${baleRule.requireAiRecommendation ? " + تأیید AI" : ""}) نرسید — نمونه علت: «${rejectedEntries[0].title.slice(0, 60)}…» ← ${describeRejectionReasons(rejectedEntries[0].reasons)}`
            : "تمام مقالات واجد شرایط قبلاً به بله ارسال شده‌اند.";

      return Response.json({
        success: true,
        action,
        autoSent: 0,
        failed: pass.failed,
        remainingReady: summary.byStatus.READY_FOR_AI ?? 0,
        firstError: failedEntry?.errors?.[0] ?? reasonText,
        summary,
        message: `ارسالی انجام نشد — ${reasonText}`,
      });
    }

    if (action === "analyze_batch") {
      const batchSize = Math.max(1, Math.min(24, Math.round(body.limit ?? 15)));
      const concurrency = Math.max(1, Math.min(6, Math.round(body.concurrency ?? 4)));
      await recoverStaleProcessing();

      const selectedIds = await selectAnalysisBacklog(batchSize);
      if (selectedIds.length === 0) {
        const catchupSend = await maybeRunAutoSend();
        const summary = await getNewsStatusSummary();
        return Response.json({
          success: true,
          action,
          analyzed: 0,
          failed: 0,
          skippedOfftopic: 0,
          autoSent: catchupSend.sent,
          remainingReady: summary.byStatus.READY_FOR_AI ?? 0,
          firstError: catchupSend.firstError ?? null,
          summary,
          message: `هیچ مقالهٔ تحلیل‌نشده‌ای در صف نمانده است${explainZeroSend(catchupSend)}.`,
        });
      }

      const gated = await applyTopicGate(selectedIds);
      const results =
        gated.pass.length > 0
          ? await analyzeSequentially(gated.pass, { concurrency, maxDurationMs: 46_000 })
          : [];
      const okIds = results.filter((item) => item.ok).map((item) => item.id);
      const failedItems = results.filter((item) => !item.ok);
      // Deliver both newly-analyzed articles AND any older unsent qualifying articles.
      const autoSend = await maybeRunAutoSend();
      const summary = await getNewsStatusSummary();
      const firstErr = failedItems[0];

      return Response.json({
        success: true,
        action,
        analyzed: okIds.length,
        failed: failedItems.length,
        skippedOfftopic: gated.skipped.length,
        autoSent: autoSend.sent,
        remainingReady: summary.byStatus.READY_FOR_AI ?? 0,
        firstError: firstErr
          ? `${firstErr.message ?? firstErr.code ?? "خطا"}${firstErr.detail ? ` (${firstErr.detail.slice(0, 160)})` : ""}`
          : autoSend.firstError ?? null,
        summary,
        message: `${okIds.length} مقاله تحلیل شد${gated.skipped.length > 0 ? `، ${gated.skipped.length} مورد غیرمرتبط رد شد` : ""}${explainZeroSend(autoSend)}.`,
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
            row.content === "" ||
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
