/**
 * Server-side AI News Analysis logic — SERVER-SIDE ONLY.
 *
 * Coordinates database reads, AI service completion and persistence.
 * Analyzed news are updated with scores and summary in PostgreSQL.
 *
 * Milestone 5: the prompt/model/thresholds/output-schema now come from the
 * active AI Configuration (`getActiveAiConfig()`) instead of being hard-coded,
 * so an administrator can retune AI behavior from `/admin/ai-config` without a
 * code change. If no configuration has ever been saved, a default one — that
 * reproduces the original Milestone 4 prompt behavior — is created automatically.
 */

import { db } from "@/db";
import { aiAnalyses, news, type NewsRow } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { mergeTokenUsage, resolveEffectiveModel, runAiAnalysis, type AiTokenUsage } from "../ai/client";
import { gradeRelevanceWithUsage, isBorderlineRelevance } from "../ai/grader";
import { getActiveAiConfig } from "../ai/config-service";

export type AnalyzeResult =
  | { ok: true; newsItem: NewsRow }
  | { ok: false; code: string; message: string; detail?: string | null };

/**
 * Append one row to the immutable AI analysis history. History never overwrites
 * earlier analyses and records which AI configuration produced each result.
 * A history-write hiccup must never mask the analysis outcome, so failures are
 * logged, not thrown.
 */
async function recordAnalysisHistory(input: {
  newsId: string;
  configurationId: string;
  configurationVersion: number;
  model: string;
  status: "success" | "failed";
  errorMessage?: string | null;
  shadowEvaluation?: import("../ai/shadow-evaluation").ShadowEvaluation | null;
  usage?: AiTokenUsage | null;
  analysis?: {
    summary: string;
    category: string;
    importance: number;
    relevance: number;
    novelty: number;
    mainEvent: string | null;
    whyItMatters: string | null;
    hashtags: string | null;
    entities: string[] | null;
    shouldSend: boolean;
    reason: string;
  } | null;
}): Promise<void> {
  try {
    await db.insert(aiAnalyses).values({
      shadowEvaluation: input.shadowEvaluation ?? null,
      newsId: input.newsId,
      configurationId: input.configurationId,
      configurationVersion: input.configurationVersion,
      model: input.model,
      status: input.status,
      errorMessage: input.errorMessage ?? null,
      promptTokens: input.usage?.promptTokens ?? null,
      completionTokens: input.usage?.completionTokens ?? null,
      totalTokens: input.usage?.totalTokens ?? null,
      summary: input.analysis?.summary ?? null,
      category: input.analysis?.category ?? null,
      importance: input.analysis?.importance ?? null,
      relevance: input.analysis?.relevance ?? null,
      novelty: input.analysis?.novelty ?? null,
      whyItMatters: input.analysis?.whyItMatters ?? null,
      hashtags: input.analysis?.hashtags ?? null,
      entities: input.analysis?.entities ?? null,
      mainEvent: input.analysis?.mainEvent ?? null,
      shouldSend: input.analysis?.shouldSend ?? null,
      reason: input.analysis?.reason ?? null,
    });
  } catch (error) {
    console.error("[analyze] history write failed:", String(error).slice(0, 160));
  }
}

/**
 * Loads a news article by ID, analyzes it with AI using the active
 * configuration, and stores the structured results.
 */
export async function analyzeArticle(id: string): Promise<AnalyzeResult> {
  let article: NewsRow | undefined;

  try {
    const rows = await db.select().from(news).where(eq(news.id, id)).limit(1);
    article = rows[0];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "db_error",
      message: "خطا در بارگذاری خبر از پایگاه داده.",
      detail,
    };
  }

  if (!article) {
    return {
      ok: false,
      code: "not_found",
      message: "خبر مورد نظر پیدا نشد.",
      detail: null,
    };
  }

  const config = await getActiveAiConfig();

  // Atomic claim before the AI call: exactly one analysis per article at a
  // time. Two concurrent requests (e.g. overlapping scheduled fetch runs) can
  // no longer both spend an AI round-trip on the same row — the loser is told
  // the article is being processed. Stale AI_PROCESSING rows are recovered by
  // the fetch route after STALE_PROCESSING_MINUTES.
  try {
    const [claimed] = await db
      .update(news)
      .set({ status: "AI_PROCESSING", updatedAt: new Date() })
      .where(and(eq(news.id, id), sql`${news.status} <> 'AI_PROCESSING'`))
      .returning({ id: news.id });

    if (!claimed) {
      return {
        ok: false,
        code: "already_processing",
        message: "تحلیل این خبر هم‌اکنون در حال انجام است؛ چند دقیقه دیگر دوباره تلاش کنید.",
        detail: null,
      };
    }
  } catch {
    // Best effort; on a transient bookkeeping error the analysis will still proceed.
  }

  // AI Service call — prompt/model/thresholds/output schema all come from `config`.
  const result = await runAiAnalysis(
    {
      title: article.title,
      description: article.description,
      source: article.source,
      publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
    },
    config,
  );

  if (!result.ok) {
    // AI failure handling: the news item is kept, its status flags the failure
    // (retryable via the admin action), and the error is preserved in history.
    await recordAnalysisHistory({
      newsId: id,
      configurationId: config.id,
      configurationVersion: config.version,
      model: resolveEffectiveModel(config.model),
      status: "failed",
      errorMessage: `${result.message}${result.detail ? ` — ${String(result.detail).slice(0, 300)}` : ""}`,
    });
    try {
      await db.update(news).set({ status: "FAILED", updatedAt: new Date() }).where(eq(news.id, id));
    } catch {
      // status bookkeeping must not change the response contract
    }
    return {
      ok: false,
      code: result.kind,
      message: result.message,
      detail: result.detail,
    };
  }

  const { summary, category, importance, relevance, novelty, mainEvent, whyItMatters, hashtags, entities, shouldSend, reason } = result.analysis;

  // Phase 3 (#9): borderline relevance gets ONE cheap second opinion. The
  // grader can only veto ("rejected") — it never raises a score.
  let relevanceGrade: string | null = null;
  let combinedUsage: AiTokenUsage | null = result.usage;
  if (isBorderlineRelevance(relevance, config.decisionRules)) {
    try {
      const gradeOutcome = await gradeRelevanceWithUsage({
        title: article.title,
        summary,
        audienceFocus: config.audienceFocus,
      });
      combinedUsage = mergeTokenUsage(result.usage, gradeOutcome.usage);
      if (gradeOutcome.verdict === "no") relevanceGrade = "rejected";
      else if (gradeOutcome.verdict === "yes") relevanceGrade = "confirmed";
    } catch {
      relevanceGrade = null;
    }
  }

  try {
    const [updated] = await db
      .update(news)
      .set({
        summary,
        category,
        importanceScore: importance,
        relevanceScore: relevance,
        noveltyScore: novelty,
        mainEvent,
        whyItMatters,
        hashtags,
        entityTags: entities,
        relevanceGrade,
        shouldSend,
        analysisReason: reason,
        analyzedAt: new Date(),
        aiConfigVersion: config.version,
        // Milestone 7/8 transition rule: the AI recommendation moves the article
        // to READY_TO_SEND (a publishing candidate becomes possible), while a
        // negative recommendation stops at AI_ANALYZED. No sending happens here.
        status: shouldSend ? "READY_TO_SEND" : "AI_ANALYZED",
        updatedAt: new Date(),
      })
      .where(eq(news.id, id))
      .returning();

    if (!updated) {
      return {
        ok: false,
        code: "update_failed",
        message: "ذخیره تحلیل در پایگاه داده ناموفق بود.",
        detail: null,
      };
    }

    await recordAnalysisHistory({
      newsId: id,
      configurationId: config.id,
      configurationVersion: config.version,
      model: result.model ?? resolveEffectiveModel(config.model),
      status: "success",
      usage: combinedUsage,
      shadowEvaluation: result.shadowEvaluation,
      analysis: { summary, category, importance, relevance, novelty, mainEvent: mainEvent ?? null, whyItMatters, hashtags, entities, shouldSend, reason },
    });

    return { ok: true, newsItem: updated };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "db_write_error",
      message: "خطا در نوشتن نتایج تحلیل روی دیتابیس.",
      detail,
    };
  }
}
