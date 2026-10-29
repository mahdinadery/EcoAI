/**
 * Admin news queries (Milestone 6) — SERVER-SIDE ONLY.
 *
 * Paginated, filterable list + detail with full AI analysis history. Reads the
 * news table directly; nothing here triggers AI, delivery or scheduling.
 */

import { db } from "@/db";
import { aiAnalyses, deliveries, news, newsSources } from "@/db/schema";
import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { NEWS_STATUSES, type NewsStatus } from "./status";

export type AdminNewsFilters = {
  q?: string;
  sourceId?: string;
  category?: string;
  status?: string;
  ai?: "pending" | "done";
  shouldSend?: "yes" | "no";
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

export const ADMIN_PAGE_SIZE = 20;

function buildWhere(filters: AdminNewsFilters) {
  const conditions = [];

  // The admin list can opt into seeing DUPLICATE / SKIPPED_OFFTOPIC rows; the
  // default view keeps them out of the operational list noise.
  const statuses = filters.status && NEWS_STATUSES.includes(filters.status as NewsStatus) ? [filters.status] : null;
  conditions.push(
    statuses
      ? sql`${news.status} IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})}`
      : sql`${news.status} NOT IN ('DUPLICATE', 'SKIPPED_OFFTOPIC')`,
  );

  if (filters.q?.trim()) {
    const pattern = `%${filters.q.trim().slice(0, 120)}%`;
    conditions.push(or(ilike(news.title, pattern), ilike(news.url, pattern), ilike(news.source, pattern)));
  }
  if (filters.sourceId) conditions.push(eq(news.sourceId, filters.sourceId));
  if (filters.category) conditions.push(eq(news.category, filters.category));
  if (filters.ai === "done") conditions.push(sql`${news.analyzedAt} IS NOT NULL`);
  if (filters.ai === "pending") conditions.push(sql`${news.analyzedAt} IS NULL`);
  if (filters.shouldSend === "yes") conditions.push(eq(news.shouldSend, true));
  if (filters.shouldSend === "no") conditions.push(or(eq(news.shouldSend, false), sql`${news.shouldSend} IS NULL`));

  const fromDate = filters.from ? new Date(filters.from) : null;
  const toDate = filters.to ? new Date(`${filters.to}T23:59:59`) : null;
  if (fromDate && !Number.isNaN(fromDate.getTime())) conditions.push(gte(sql`coalesce(${news.publishedAt}, ${news.createdAt})`, fromDate));
  if (toDate && !Number.isNaN(toDate.getTime())) conditions.push(lte(sql`coalesce(${news.publishedAt}, ${news.createdAt})`, toDate));

  return conditions.length > 0 ? and(...conditions) : undefined;
}

export type AdminNewsListItem = {
  id: string;
  title: string;
  url: string;
  source: string;
  category: string | null;
  status: string;
  publishedAt: string | null;
  fetchedAt: string;
  createdAt: string;
  analyzedAt: string | null;
  importanceScore: number | null;
  shouldSend: boolean | null;
};

export type AdminNewsSummary = Record<string, number> & { total: number };

export async function listAdminNews(filters: AdminNewsFilters): Promise<{
  items: AdminNewsListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  const where = buildWhere(filters);
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(Math.max(filters.pageSize ?? ADMIN_PAGE_SIZE, 5), 100);

  const [rows, [countRow]] = await Promise.all([
    db
      .select({
        id: news.id,
        title: news.title,
        url: news.url,
        source: news.source,
        category: news.category,
        status: news.status,
        publishedAt: news.publishedAt,
        fetchedAt: news.fetchedAt,
        createdAt: news.createdAt,
        analyzedAt: news.analyzedAt,
        importanceScore: news.importanceScore,
        shouldSend: news.shouldSend,
      })
      .from(news)
      .where(where)
      .orderBy(desc(sql`coalesce(${news.publishedAt}, ${news.createdAt})`), desc(news.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(news).where(where),
  ]);

  const total = countRow?.total ?? 0;

  return {
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      source: row.source,
      category: row.category,
      status: row.status,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      fetchedAt: row.fetchedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      analyzedAt: row.analyzedAt ? row.analyzedAt.toISOString() : null,
      importanceScore: row.importanceScore,
      shouldSend: row.shouldSend,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getNewsStatusSummary(): Promise<{ total: number; byStatus: Record<string, number> }> {
  const rows = await db
    .select({ status: news.status, count: sql<number>`count(*)::int` })
    .from(news)
    .groupBy(news.status);

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    byStatus[row.status] = row.count;
    if (row.status !== "DUPLICATE") total += row.count;
  }
  return { total, byStatus };
}

export async function listFilterOptions(): Promise<{ categories: string[]; sources: Array<{ id: string; name: string }> }> {
  const [categoryRows, sourceRows] = await Promise.all([
    db
      .select({ category: news.category })
      .from(news)
      .where(sql`${news.category} IS NOT NULL`)
      .groupBy(news.category)
      .orderBy(sql`count(*) DESC`),
    db.select({ id: newsSources.id, name: newsSources.name }).from(newsSources).orderBy(desc(newsSources.priority)),
  ]);

  return {
    categories: categoryRows.map((row) => row.category).filter((value): value is string => Boolean(value)),
    sources: sourceRows,
  };
}

export type AdminNewsDetail = {
  item: NewsDetailRow;
  sourceName: string | null;
  deliveryAttempts: Array<{
    id: string;
    destination: string;
    status: string;
    triggeredBy: string;
    errorMessage: string | null;
    providerMessageId: string | null;
    approvedAt: string | null;
    sentAt: string | null;
    overrideRequested: boolean;
    retryCount: number;
    createdAt: string;
  }>;
  analyses: Array<{
    id: string;
    status: string;
    configurationVersion: number | null;
    model: string | null;
    summary: string | null;
    category: string | null;
    importance: number | null;
    relevance: number | null;
    novelty: number | null;
    mainEvent: string | null;
    shouldSend: boolean | null;
    reason: string | null;
    errorMessage: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    hashtags: string | null;
    totalTokens: number | null;
    shadowEvaluation: import("../ai/shadow-evaluation").ShadowEvaluation | null;
    createdAt: string;
  }>;
  duplicateOf: { id: string; title: string } | null;
};

type NewsDetailRow = typeof news.$inferSelect;

export async function getAdminNewsDetail(id: string): Promise<AdminNewsDetail | null> {
  const [item] = await db.select().from(news).where(eq(news.id, id)).limit(1);
  if (!item) return null;

  const [source] = item.sourceId
    ? await db.select({ name: newsSources.name }).from(newsSources).where(eq(newsSources.id, item.sourceId)).limit(1)
    : [null];

  const analyses = await db
    .select()
    .from(aiAnalyses)
    .where(eq(aiAnalyses.newsId, id))
    .orderBy(desc(aiAnalyses.createdAt));

  const deliveryRows = await db
    .select()
    .from(deliveries)
    .where(eq(deliveries.newsId, id))
    .orderBy(desc(deliveries.createdAt))
    .limit(10);

  let duplicateOf: AdminNewsDetail["duplicateOf"] = null;
  if (item.duplicateOfId) {
    const [original] = await db
      .select({ id: news.id, title: news.title })
      .from(news)
      .where(eq(news.id, item.duplicateOfId))
      .limit(1);
    if (original) duplicateOf = original;
  }

  return {
    item,
    sourceName: source?.name ?? null,
    duplicateOf,
    deliveryAttempts: deliveryRows.map((row) => ({
      id: row.id,
      destination: row.destination,
      status: row.status,
      triggeredBy: row.triggeredBy,
      errorMessage: row.errorMessage,
      providerMessageId: row.providerMessageId,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      overrideRequested: row.overrideRequested,
      retryCount: row.retryCount,
      createdAt: row.createdAt.toISOString(),
    })),
    analyses: analyses.map((row) => ({
      id: row.id,
      status: row.status,
      configurationVersion: row.configurationVersion,
      model: row.model,
      summary: row.summary,
      category: row.category,
      importance: row.importance,
      relevance: row.relevance,
      novelty: row.novelty,
      mainEvent: row.mainEvent,
      shouldSend: row.shouldSend,
      reason: row.reason,
      errorMessage: row.errorMessage,
      promptTokens: row.promptTokens ?? null,
      completionTokens: row.completionTokens ?? null,
      hashtags: row.hashtags ?? null,
      totalTokens: row.totalTokens ?? null,
      shadowEvaluation: row.shadowEvaluation ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** Manual admin status transition (e.g. "mark as processed"). No automation. */
export async function setNewsStatus(id: string, status: string): Promise<boolean> {
  if (!NEWS_STATUSES.includes(status as NewsStatus)) return false;
  const updated = await db
    .update(news)
    .set({ status, updatedAt: new Date() })
    .where(eq(news.id, id))
    .returning({ id: news.id });
  return updated.length > 0;
}
