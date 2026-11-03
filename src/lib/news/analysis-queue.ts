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
import type { AiTopicFilterConfig } from "@/lib/ai/config-types";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { analyzeArticle } from "./analyze";
import { fetchArticleBody } from "./article-extractor";
import { normalizeContent } from "./normalize";
import { evaluateTopicFilter, evaluateWithFirstParagraphFallback, isTopicGateActive } from "./topic-filter";

export const STALE_PROCESSING_MINUTES = 2;
const DEFAULT_PASS_BUDGET_MS = 65_000;
const SWEEP_BATCH_LIMIT = 250;
const QUEUE_LEAD_CONCURRENCY = 4;
const QUEUE_LEAD_TIMEOUT_MS = 4_500;
const MAX_SWEEP_LEAD_PROBES = 8;
const MAX_RESCUE_LEAD_PROBES = 6;

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

async function probeWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await fn(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Persists the fetched webpage body (or `""` sentinel when unreachable/empty)
 * so each URL's opening paragraph is checked at most once and rescued articles
 * carry full text into `analyzeArticle` without a second HTTP fetch.
 */
async function persistProbedLead(
  id: string,
  currentDescription: string | null,
  firstParagraph: string | null,
  fetchedBody: string | null,
  nextStatus?: "READY_FOR_AI" | "SKIPPED_OFFTOPIC",
): Promise<void> {
  const nextContent = fetchedBody ?? "";
  const nextDescription =
    firstParagraph && (!currentDescription || currentDescription.trim().length < 60)
      ? firstParagraph.slice(0, 600)
      : currentDescription;

  try {
    await db
      .update(news)
      .set({
        content: nextContent,
        description: nextDescription,
        normalizedContent: fetchedBody ? normalizeContent(fetchedBody, nextDescription) : undefined,
        ...(nextStatus ? { status: nextStatus } : {}),
        updatedAt: new Date(),
      })
      .where(eq(news.id, id));
  } catch {
    // Non-blocking bookkeeping
  }
}

/**
 * Last gate before the expensive AI stage. If a report fails on title/teaser
 * alone (`not_in_selected_topics`), its opening paragraph is fetched and
 * inspected before marking `SKIPPED_OFFTOPIC`.
 */
export async function applyTopicGate(selectedIds: string[]): Promise<{ pass: string[]; skipped: string[] }> {
  if (selectedIds.length === 0) return { pass: [], skipped: [] };

  const settings = await readActiveOperationalSettings();
  const filter = settings?.topicFilter ?? null;
  if (!isTopicGateActive(filter)) {
    return { pass: selectedIds, skipped: [] };
  }

  const rows = await db
    .select({
      id: news.id,
      url: news.url,
      title: news.title,
      description: news.description,
      content: news.content,
    })
    .from(news)
    .where(inArray(news.id, selectedIds));

  const outcomes = await probeWithConcurrency(rows, QUEUE_LEAD_CONCURRENCY, async (row) => {
    const probed = await evaluateWithFirstParagraphFallback(row, filter, (url) =>
      fetchArticleBody(url, QUEUE_LEAD_TIMEOUT_MS),
    );
    if (probed.checkedFirstParagraph) {
      await persistProbedLead(
        row.id,
        row.description,
        probed.firstParagraph,
        probed.fetchedBody,
        probed.outcome.verdict === "pass" ? undefined : "SKIPPED_OFFTOPIC",
      );
    }
    return { id: row.id, checked: probed.checkedFirstParagraph, verdict: probed.outcome.verdict };
  });

  const pass: string[] = [];
  const skipped: string[] = [];
  const uncheckedSkipIds: string[] = [];
  for (const item of outcomes) {
    if (item.verdict === "pass") {
      pass.push(item.id);
    } else {
      skipped.push(item.id);
      if (!item.checked) uncheckedSkipIds.push(item.id);
    }
  }

  if (uncheckedSkipIds.length > 0) {
    await db
      .update(news)
      .set({ status: "SKIPPED_OFFTOPIC", updatedAt: new Date() })
      .where(inArray(news.id, uncheckedSkipIds));
  }

  return { pass, skipped };
}

/**
 * Re-inspects recent `SKIPPED_OFFTOPIC` articles whose webpage body was never
 * checked (`content IS NULL`), promoting any whose opening paragraph matches
 * the active topic filter back to `READY_FOR_AI`.
 */
async function rescueTitleRejectedSkippedRows(filter: AiTopicFilterConfig | null): Promise<number> {
  try {
    const candidates = await db
      .select({
        id: news.id,
        url: news.url,
        title: news.title,
        description: news.description,
        content: news.content,
      })
      .from(news)
      .where(
        sql`${news.status} = 'SKIPPED_OFFTOPIC' AND ${news.analyzedAt} IS NULL AND ${news.content} IS NULL AND ${news.createdAt} >= now() - interval '72 hours'`,
      )
      .orderBy(desc(sql`coalesce(${news.publishedAt}, ${news.createdAt})`))
      .limit(MAX_RESCUE_LEAD_PROBES);

    if (candidates.length === 0) return 0;

    let rescued = 0;
    await probeWithConcurrency(candidates, QUEUE_LEAD_CONCURRENCY, async (row) => {
      const probed = await evaluateWithFirstParagraphFallback(row, filter, (url) =>
        fetchArticleBody(url, QUEUE_LEAD_TIMEOUT_MS),
      );
      if (probed.outcome.verdict === "pass") {
        rescued += 1;
        await persistProbedLead(row.id, row.description, probed.firstParagraph, probed.fetchedBody, "READY_FOR_AI");
      } else if (probed.checkedFirstParagraph) {
        await persistProbedLead(row.id, row.description, probed.firstParagraph, probed.fetchedBody, "SKIPPED_OFFTOPIC");
      } else {
        // Hard blocked keyword or non-HTTP URL — mark sentinel so it is not re-scanned.
        await persistProbedLead(row.id, row.description, null, null, "SKIPPED_OFFTOPIC");
      }
    });

    return rescued;
  } catch {
    return 0;
  }
}

/**
 * Sweeps pending unanalyzed articles (`READY_FOR_AI` and unanalyzed `FAILED`)
 * through the active topic filter, checking the webpage's **first paragraph**
 * before rejecting title-ambiguous reports, and rescues recent title-only
 * `SKIPPED_OFFTOPIC` items whose first paragraph proves relevant.
 */
export async function sweepOfftopicBacklog(): Promise<{ swept: number; rescued?: number }> {
  try {
    const settings = await readActiveOperationalSettings();
    const filter = settings?.topicFilter ?? null;
    if (!isTopicGateActive(filter)) {
      return { swept: 0, rescued: 0 };
    }

    const rescued = await rescueTitleRejectedSkippedRows(filter);

    const pendingRows = await db
      .select({
        id: news.id,
        url: news.url,
        title: news.title,
        description: news.description,
        content: news.content,
      })
      .from(news)
      .where(
        sql`${news.analyzedAt} IS NULL AND ${news.status} IN ('READY_FOR_AI', 'FAILED')`,
      )
      .orderBy(desc(sql`coalesce(${news.publishedAt}, ${news.createdAt})`))
      .limit(SWEEP_BATCH_LIMIT);

    if (pendingRows.length === 0) return { swept: 0, rescued };

    const immediateSkipIds: string[] = [];
    const needsLeadProbe: typeof pendingRows = [];

    for (const row of pendingRows) {
      const initial = evaluateTopicFilter(row, filter);
      if (initial.verdict === "pass") continue;
      if (
        initial.reason === "not_in_selected_topics" &&
        row.content !== "" &&
        (row.content ?? "").trim().length < 300 &&
        needsLeadProbe.length < MAX_SWEEP_LEAD_PROBES
      ) {
        needsLeadProbe.push(row);
      } else if (initial.reason !== "not_in_selected_topics" || row.content === "" || (row.content ?? "").trim().length >= 300) {
        immediateSkipIds.push(row.id);
      }
      // Items beyond `MAX_SWEEP_LEAD_PROBES` remain `READY_FOR_AI` until a
      // subsequent sweep or `applyTopicGate` checks their first paragraph, so
      // no report is ever rejected on its title alone without a lead check!
    }

    let probedSkipped = 0;
    if (needsLeadProbe.length > 0) {
      await probeWithConcurrency(needsLeadProbe, QUEUE_LEAD_CONCURRENCY, async (row) => {
        const probed = await evaluateWithFirstParagraphFallback(row, filter, (url) =>
          fetchArticleBody(url, QUEUE_LEAD_TIMEOUT_MS),
        );
        if (probed.outcome.verdict === "pass") {
          if (probed.checkedFirstParagraph) {
            await persistProbedLead(row.id, row.description, probed.firstParagraph, probed.fetchedBody);
          }
        } else {
          probedSkipped += 1;
          await persistProbedLead(row.id, row.description, probed.firstParagraph, probed.fetchedBody, "SKIPPED_OFFTOPIC");
        }
      });
    }

    if (immediateSkipIds.length > 0) {
      await db
        .update(news)
        .set({ status: "SKIPPED_OFFTOPIC", updatedAt: new Date() })
        .where(inArray(news.id, immediateSkipIds));
    }

    return { swept: immediateSkipIds.length + probedSkipped, rescued };
  } catch (error) {
    console.error("[analysis-queue] off-topic sweep failed:", String(error).slice(0, 160));
    return { swept: 0, rescued: 0 };
  }
}

/**
 * Newest READY_FOR_AI items first (with dateless RSS items demoted slightly so
 * dated articles from timely AI-economics feeds are never starved), followed by
 * previously FAILED unanalyzed items.
 */
export async function selectAnalysisBacklog(
  limit: number,
  excludeIds: string[] = [],
  options: { skipSweep?: boolean } = {},
): Promise<string[]> {
  if (limit <= 0) return [];

  if (!options.skipSweep) {
    await sweepOfftopicBacklog();
  }

  const rows = await db
    .select({ id: news.id })
    .from(news)
    .where(
      and(
        sql`(${news.status} = 'READY_FOR_AI' OR (${news.status} = 'FAILED' AND ${news.analyzedAt} IS NULL))`,
        excludeIds.length > 0
          ? sql`${news.id} NOT IN (${sql.join(
              excludeIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql`TRUE`,
      ),
    )
    .orderBy(
      sql`CASE WHEN ${news.status} = 'READY_FOR_AI' THEN 0 ELSE 1 END ASC`,
      sql`coalesce(${news.publishedAt}, ${news.createdAt} - interval '3 days') DESC`,
    )
    .limit(limit);

  return rows.map((row) => row.id);
}

function isFatalProviderConfigFailure(
  code: string | null,
  message: string | null,
  detail: string | null,
): boolean {
  if (code === "missing_key" || code === "timeout" || code === "network_error") return true;
  if (code === "http_error") {
    const combined = `${message ?? ""} ${detail ?? ""}`;
    if (/\bHTTP\s+(401|402|403|404|429)\b/i.test(combined)) return true;
    if (/exceeded your current quota|limit:\s*0\b|invalid api key|unauthorized/i.test(combined)) return true;
  }
  return false;
}

/**
 * Sequential, failure-isolated analysis (the provider has a low TPM limit).
 * Stops early if:
 *  - a fatal provider key/auth/endpoint error occurs (no point hammering N more items), or
 *  - the pass time budget (`maxDurationMs`, default 55s) is reached so HTTP callers
 *    return cleanly before reverse-proxy timeouts (~100s on Render).
 */
export async function analyzeSequentially(
  ids: string[],
  options: { maxDurationMs?: number } = {},
): Promise<QueuedAnalysisResult[]> {
  const results: QueuedAnalysisResult[] = [];
  const startedAt = Date.now();
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_PASS_BUDGET_MS;

  for (const id of ids) {
    if (results.length > 0 && Date.now() - startedAt >= maxDurationMs) {
      break;
    }

    try {
      const analysis = await analyzeArticle(id);
      const entry: QueuedAnalysisResult = {
        id,
        ok: analysis.ok,
        code: analysis.ok ? null : analysis.code,
        message: analysis.ok ? null : analysis.message,
        detail: analysis.ok ? null : (analysis.detail ?? null),
      };
      results.push(entry);

      if (!entry.ok && isFatalProviderConfigFailure(entry.code, entry.message, entry.detail)) {
        break;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[analysis-queue] article analysis failed:", detail.slice(0, 200));
      results.push({ id, ok: false, code: "analysis_error", message: detail, detail: null });
    }
  }

  return results;
}
