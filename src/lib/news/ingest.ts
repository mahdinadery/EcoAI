/**
 * News ingestion service — SERVER-SIDE ONLY.
 *
 * Milestone 6 note: the fetch/parse/normalize/canonicalize/dedupe/store stages
 * now live in the shared pipeline (src/lib/news/source-ingest.ts). This module
 * keeps the legacy dashboard-facing functions with the exact same shapes as
 * before so /api/news/fetch and the existing UI keep working unchanged.
 *
 * Duplicate detection anchors (all preserved from earlier milestones):
 *   - exact `news.url` unique index (primary anchor, unchanged)
 *   - `canonicalUrl` and `externalId` (added by the pipeline, conservative)
 */

import { db } from "@/db";
import { aiAnalyses, news } from "@/db/schema";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { ingestAllActiveSources } from "./source-ingest";

export type IngestResult =
  | {
      ok: true;
      source: string;
      fetched: number;
      stored: number;
      /** Rows stored as SKIPPED_OFFTOPIC by the topic filter (never analyzed). */
      filtered: number;
      newArticleIds: string[];
      duplicates: number;
      skipped: number;
    }
  | { ok: false; code: string; message: string; detail?: string | null };

/**
 * Dashboard "Fetch News" entry point. Now source-aware: fetches every ACTIVE
 * registered source (admin UI), falling back to the legacy env URL when no
 * source is registered yet. The response keeps the original single-source
 * shape (fetched/stored/duplicates are totals) so the existing card works.
 */
export async function ingestNews(): Promise<IngestResult> {
  const result = await ingestAllActiveSources();
  if (result.ok) {
    return {
      ok: true,
      source: result.source,
      fetched: result.fetched,
      stored: result.stored,
      filtered: result.filtered,
      newArticleIds: result.newArticleIds,
      duplicates: result.duplicates,
      skipped: result.skipped,
    };
  }
  return result;
}

export type NewsStats = {
  totalStored: number;
  lastFetchCount: number;
  lastFetchedAt: string | null;
  sources: number;
};

export async function getNewsStats(): Promise<NewsStats> {
  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      sources: sql<number>`count(distinct ${news.source})::int`,
    })
    .from(news)
    .where(sql`${news.status} NOT IN ('DUPLICATE', 'SKIPPED_OFFTOPIC')`);

  // Timestamps are compared entirely inside SQL: Postgres stores microseconds
  // while a JS Date round-trip truncates to milliseconds, so filtering with
  // `eq(column, jsDate)` would silently match nothing.
  const [latestBatch] = await db
    .select({
      count: sql<number>`count(*)::int`,
      fetchedAt: sql<Date | null>`max(${news.fetchedAt})`,
    })
    .from(news)
    .where(sql`${news.fetchedAt} = (SELECT max(${news.fetchedAt}) FROM ${news})`);

  const lastFetchCount = latestBatch?.count ?? 0;
  const lastFetchedAt = latestBatch?.fetchedAt ? new Date(latestBatch.fetchedAt).toISOString() : null;

  return {
    totalStored: totals?.total ?? 0,
    lastFetchCount,
    lastFetchedAt,
    sources: totals?.sources ?? 0,
  };
}

export type AiTokenUsageSummary = {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  todayTokens: number;
  analyzedCount: number;
};

/**
 * Aggregate AI token consumption across all recorded analyses in `ai_analyses`.
 */
export async function getAiTokenUsageStats(): Promise<AiTokenUsageSummary> {
  const [row] = await db
    .select({
      totalTokens: sql<number>`coalesce(sum(${aiAnalyses.totalTokens}), 0)::int`,
      promptTokens: sql<number>`coalesce(sum(${aiAnalyses.promptTokens}), 0)::int`,
      completionTokens: sql<number>`coalesce(sum(${aiAnalyses.completionTokens}), 0)::int`,
      todayTokens: sql<number>`coalesce(sum(${aiAnalyses.totalTokens}) FILTER (WHERE ${aiAnalyses.createdAt} >= date_trunc('day', now())), 0)::int`,
      analyzedCount: sql<number>`count(${aiAnalyses.totalTokens})::int`,
    })
    .from(aiAnalyses);

  return {
    totalTokens: row?.totalTokens ?? 0,
    promptTokens: row?.promptTokens ?? 0,
    completionTokens: row?.completionTokens ?? 0,
    todayTokens: row?.todayTokens ?? 0,
    analyzedCount: row?.analyzedCount ?? 0,
  };
}

export type NewsListItem = {
  id: string;
  title: string;
  translatedTitle: string | null;
  url: string;
  source: string;
  description: string | null;
  publishedAt: string | null;
  createdAt?: string | null;
  status?: string | null;

  // AI analysis fields (Milestone 4+)
  summary: string | null;
  category: string | null;
  importanceScore: number | null;
  relevanceScore: number | null;
  noveltyScore: number | null;
  shouldSend: boolean | null;
  analysisReason: string | null;
  analyzedAt: string | null;
};

export type LibraryNewsFilters = {
  q?: string;
  filter?: "all" | "analyzed" | "pending" | "ready_to_send" | "offtopic";
  sort?: "fetched" | "published";
  page?: number;
  pageSize?: number;
};

export const LIBRARY_PAGE_SIZE = 60;

/**
 * Paginated, filterable News Library query (`/news` — کتابخانه اخبار).
 *
 * Defaults to ordering by `createdAt DESC` (`جدیدترین دریافتی‌ها`) rather than
 * `publishedAt` so newly ingested working papers — including dateless NBER feeds
 * (`publishedAt = NULL`) and research reports published days earlier — ALWAYS
 * appear immediately at the top of the library when fetched.
 */
export async function listLibraryNews(filters: LibraryNewsFilters = {}): Promise<{
  items: NewsListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  const conditions = [];
  const mode = filters.filter ?? "all";

  if (mode === "offtopic") {
    conditions.push(eq(news.status, "SKIPPED_OFFTOPIC"));
  } else {
    conditions.push(sql`${news.status} NOT IN ('DUPLICATE', 'SKIPPED_OFFTOPIC')`);
    if (mode === "analyzed") conditions.push(sql`${news.analyzedAt} IS NOT NULL`);
    if (mode === "pending") conditions.push(sql`${news.analyzedAt} IS NULL`);
    if (mode === "ready_to_send") conditions.push(eq(news.shouldSend, true));
  }

  if (filters.q?.trim()) {
    const pattern = `%${filters.q.trim().slice(0, 120)}%`;
    conditions.push(
      or(
        ilike(news.title, pattern),
        ilike(news.translatedTitle, pattern),
        ilike(news.source, pattern),
        ilike(news.url, pattern),
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(Math.max(filters.pageSize ?? LIBRARY_PAGE_SIZE, 10), 200);
  const orderExpr =
    filters.sort === "published"
      ? desc(sql`coalesce(${news.publishedAt}, ${news.createdAt})`)
      : desc(news.createdAt);

  const [rows, [countRow]] = await Promise.all([
    db
      .select({
        id: news.id,
        title: news.title,
        translatedTitle: news.translatedTitle,
        url: news.url,
        source: news.source,
        description: news.description,
        publishedAt: news.publishedAt,
        createdAt: news.createdAt,
        status: news.status,
        summary: news.summary,
        category: news.category,
        importanceScore: news.importanceScore,
        relevanceScore: news.relevanceScore,
        noveltyScore: news.noveltyScore,
        shouldSend: news.shouldSend,
        analysisReason: news.analysisReason,
        analyzedAt: news.analyzedAt,
      })
      .from(news)
      .where(where)
      .orderBy(orderExpr, desc(news.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(news).where(where),
  ]);

  const total = countRow?.total ?? 0;

  return {
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      translatedTitle: row.translatedTitle,
      url: row.url,
      source: row.source,
      description: row.description,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      status: row.status,
      summary: row.summary,
      category: row.category,
      importanceScore: row.importanceScore,
      relevanceScore: row.relevanceScore,
      noveltyScore: row.noveltyScore,
      shouldSend: row.shouldSend,
      analysisReason: row.analysisReason,
      analyzedAt: row.analyzedAt ? row.analyzedAt.toISOString() : null,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Public news list helper (orders newest-ingested first so fresh papers appear immediately). */
export async function listLatestNews(limit = 60): Promise<NewsListItem[]> {
  const result = await listLibraryNews({ page: 1, pageSize: Math.min(Math.max(limit, 1), 200), sort: "fetched" });
  return result.items;
}
