/**
 * Analysis queue — SERVER-SIDE ONLY.
 *
 * Shared by the manual `POST /api/news/fetch` pipeline and the scheduled
 * "fetch → analyze → send" pass, so both apply exactly the same rules:
 *
 *   1. stale AI_PROCESSING rows are recovered,
 *   2. the oldest READY_FOR_AI backlog is selected (bounded),
 *   3. the topic filter drops off-topic rows before any AI call,
 *   4. articles are analyzed strictly sequentially (provider TPM limits).
 */

import { db } from "@/db";
import { news } from "@/db/schema";
import { readActiveOperationalSettings } from "@/lib/ai/config-service";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { analyzeArticle } from "./analyze";
import { evaluateTopicFilter, isTopicGateActive } from "./topic-filter";

export const STALE_PROCESSING_MINUTES = 15;

export type QueuedAnalysisResult = {
  id: string;
  ok: boolean;
  code: string | null;
  message: string | null;
  detail: string | null;
};

/**
 * Articles left in AI_PROCESSING by an interrupted request or a restart are
 * released back to the queue after STALE_PROCESSING_MINUTES.
 */
export async function recoverStaleProcessing(now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MINUTES * 60 * 1000);

  try {
    const released = await db
      .update(news)
      .set({ status: "READY_FOR_AI", updatedAt: new Date() })
      .where(and(eq(news.status, "AI_PROCESSING"), lt(news.updatedAt, staleBefore)))
      .returning({ id: news.id });
    return released.length;
  } catch (error) {
    console.error("[analysis-queue] stale recovery failed:", String(error).slice(0, 160));
    return 0;
  }
}

/**
 * Last gate before the expensive AI stage. Non-matching rows are marked
 * SKIPPED_OFFTOPIC (still stored, re-queueable) and never reach the model.
 * Fails open when the filter is inactive.
 */
export async function applyTopicGate(selectedIds: string[]): Promise<{ pass: string[]; skipped: string[] }> {
  if (selectedIds.length === 0) return { pass: [], skipped: [] };

  const settings = await readActiveOperationalSettings();
  const filter = settings?.topicFilter ?? null;
  // "Active" includes a deny-list-only configuration AND the always-on
  // baseline deny-list, so this gate can never be skipped entirely.
  if (!isTopicGateActive(filter)) {
    return { pass: selectedIds, skipped: [] };
  }

  const rows = await db
    .select({
      id: news.id,
      title: news.title,
      description: news.description,
      content: news.content,
    })
    .from(news)
    .where(inArray(news.id, selectedIds));

  const pass: string[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    const result = evaluateTopicFilter(row, filter);
    if (result.verdict === "pass") pass.push(row.id);
    else skipped.push(row.id);
  }

  if (skipped.length > 0) {
    await db
      .update(news)
      .set({ status: "SKIPPED_OFFTOPIC", updatedAt: new Date() })
      .where(inArray(news.id, skipped));
  }

  return { pass, skipped };
}

/** Oldest READY_FOR_AI items first, so the backlog drains in publish order. */
export async function selectAnalysisBacklog(limit: number, excludeIds: string[] = []): Promise<string[]> {
  if (limit <= 0) return [];

  const rows = await db
    .select({ id: news.id })
    .from(news)
    .where(
      and(
        eq(news.status, "READY_FOR_AI"),
        excludeIds.length > 0
          ? sql`${news.id} NOT IN (${sql.join(
              excludeIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql`TRUE`,
      ),
    )
    .orderBy(sql`coalesce(${news.publishedAt}, ${news.createdAt}) ASC`)
    .limit(limit);

  return rows.map((row) => row.id);
}

/** Sequential, failure-isolated analysis (the provider has a low TPM limit). */
export async function analyzeSequentially(ids: string[]): Promise<QueuedAnalysisResult[]> {
  const results: QueuedAnalysisResult[] = [];

  for (const id of ids) {
    try {
      const analysis = await analyzeArticle(id);
      results.push({
        id,
        ok: analysis.ok,
        code: analysis.ok ? null : analysis.code,
        message: analysis.ok ? null : analysis.message,
        detail: analysis.ok ? null : (analysis.detail ?? null),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[analysis-queue] article analysis failed:", detail.slice(0, 200));
      results.push({ id, ok: false, code: "analysis_error", message: detail, detail: null });
    }
  }

  return results;
}
