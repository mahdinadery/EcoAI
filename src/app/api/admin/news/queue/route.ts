import { db } from "@/db";
import { news } from "@/db/schema";
import { checkAdminAccess } from "@/lib/admin/access";
import { maybeRunAutoSend } from "@/lib/agent/auto-hook";
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
  action?: "analyze_batch" | "apply_ai_pack_filter" | "archive_stale" | "retry_failed";
  limit?: number;
  days?: number;
};

async function archiveOlderUnanalyzed(days: number): Promise<number> {
  const safeDays = Math.max(1, Math.min(90, Math.round(days)));
  const archived = await db
    .update(news)
    .set({ status: "FETCHED", updatedAt: new Date() })
    .where(
      sql`${news.analyzedAt} IS NULL AND ${news.status} IN ('READY_FOR_AI', 'FAILED') AND coalesce(${news.publishedAt}, ${news.createdAt}) < now() - (${safeDays}::int * interval '1 day')`,
    )
    .returning({ id: news.id });
  return archived.length;
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
    if (action === "analyze_batch") {
      const batchSize = Math.max(1, Math.min(10, Math.round(body.limit ?? 5)));
      await recoverStaleProcessing();

      const selectedIds = await selectAnalysisBacklog(batchSize);
      if (selectedIds.length === 0) {
        const summary = await getNewsStatusSummary();
        return Response.json({
          success: true,
          action,
          analyzed: 0,
          failed: 0,
          skippedOfftopic: 0,
          autoSent: 0,
          remainingReady: summary.byStatus.READY_FOR_AI ?? 0,
          summary,
          message: "هیچ خبر در انتظار تحلیلی در صف باقی نمانده است.",
        });
      }

      const gated = await applyTopicGate(selectedIds);
      const results =
        gated.pass.length > 0
          ? await analyzeSequentially(gated.pass, { maxDurationMs: 52_000 })
          : [];
      const okIds = results.filter((item) => item.ok).map((item) => item.id);
      const failedItems = results.filter((item) => !item.ok);
      const autoSend = okIds.length > 0 ? await maybeRunAutoSend(okIds) : null;
      const summary = await getNewsStatusSummary();
      const firstErr = failedItems[0];

      return Response.json({
        success: true,
        action,
        analyzed: okIds.length,
        failed: failedItems.length,
        skippedOfftopic: gated.skipped.length,
        autoSent: autoSend?.sent ?? 0,
        remainingReady: summary.byStatus.READY_FOR_AI ?? 0,
        firstError: firstErr
          ? `${firstErr.message ?? firstErr.code ?? "خطا"}${firstErr.detail ? ` (${firstErr.detail.slice(0, 160)})` : ""}`
          : null,
        summary,
        message: `${okIds.length} خبر تحلیل شد${gated.skipped.length > 0 ? `، ${gated.skipped.length} مورد خارج از موضوع رد شد` : ""}${autoSend?.sent ? ` و ${autoSend.sent} مورد خودکار ارسال شد` : ""}.`,
      });
    }

    if (action === "archive_stale") {
      const days = Math.max(1, Math.min(90, Math.round(body.days ?? 7)));
      const archived = await archiveOlderUnanalyzed(days);
      const summary = await getNewsStatusSummary();
      return Response.json({
        success: true,
        action,
        archived,
        remainingReady: summary.byStatus.READY_FOR_AI ?? 0,
        summary,
        message:
          archived > 0
            ? `${archived} خبر قدیمی‌تر از ${days} روز از صف «آماده تحلیل AI» به آرشیو منتقل شد.`
            : `خبر تحلیل‌نشده‌ای قدیمی‌تر از ${days} روز در صف نبود.`,
      });
    }

    if (action === "retry_failed") {
      const days = Math.max(1, Math.min(30, Math.round(body.days ?? 7)));
      const requeued = await db
        .update(news)
        .set({ status: "READY_FOR_AI", updatedAt: new Date() })
        .where(
          sql`${news.status} = 'FAILED' AND ${news.analyzedAt} IS NULL AND coalesce(${news.publishedAt}, ${news.createdAt}) >= now() - (${days}::int * interval '1 day')`,
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
            ? `${requeued.length} خبر خطادارِ ${days} روز اخیر به صف «آماده تحلیل AI» بازگردانده شد.`
            : "خبر خطادار تازه‌ای برای بازگردانی یافت نشد.",
      });
    }

    if (action === "apply_ai_pack_filter") {
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

      // 1) Move >7d historical archive items out of `READY_FOR_AI` first so we don't waste time on old dumps.
      const archivedStale = await archiveOlderUnanalyzed(7);

      // 2) Fast in-memory sweep across ALL remaining rich-body or blocked items, plus lead-paragraph sweep on recent ones.
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
            (row.content ?? "").trim().length >= 300 ||
            (row.description ?? "").trim().length >= 180)
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
        archivedStale,
        sweptOfftopic: totalSwept,
        remainingReady: summary.byStatus.READY_FOR_AI ?? 0,
        summary,
        message: `پالایش صف انجام شد: ${archivedStale} خبر قدیمی‌تر از ۷ روز بایگانی شد، ${totalSwept} خبر غیرمرتبط با اقتصاد هوش مصنوعی خارج شد، و اکنون ${summary.byStatus.READY_FOR_AI ?? 0} خبر تازه و مرتبط در صف تحلیل باقی مانده است.`,
      });
    }

    return Response.json({ success: false, message: "عملیات درخواستی نامعتبر است." }, { status: 400 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json(
      { success: false, message: "خطا در پردازش صف اخبار.", detail: detail.slice(0, 240) },
      { status: 500 },
    );
  }
}
