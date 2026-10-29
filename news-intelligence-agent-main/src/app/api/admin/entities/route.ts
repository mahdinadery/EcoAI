/**
 * Dossier dashboard (roadmap Phase 3, task #7) — SERVER-SIDE ONLY.
 *
 * GET /api/admin/entities
 *   → dashboard payload: entity + publisher rankings and KPIs (bounded recent
 *     scan of analyzed rows). Each stat carries count / time / importance so
 *     the UI can rank by any of the three dimensions.
 * GET /api/admin/entities?name=<entity>
 *   → one entity dossier: full MetricStat + the news mentioning it.
 * GET /api/admin/entities?publisher=<source>
 *   → one publisher dossier: full MetricStat + that publisher's items.
 *
 * Aggregation happens in JS over the most recent analyzed rows — the corpus
 * per deployment is small (a focused domain), and this avoids vendor-specific
 * jsonb SQL while staying bounded (<= 1000 rows scanned). All math lives in
 * the pure module src/lib/admin/dossier-stats.ts (unit-tested).
 */

import { checkAdminAccess } from "@/lib/admin/access";
import { dbErrorResponse } from "@/lib/admin/db-error-response";
import { diagnoseDbError } from "@/lib/admin/db-errors";
import {
  buildDossierStats,
  buildEntityStats,
  buildPublisherStats,
  emptyMetricStat,
  type DossierRow,
  type MetricStat,
} from "@/lib/admin/dossier-stats";
import { db } from "@/db";
import { news } from "@/db/schema";
import { desc, isNotNull } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCAN_LIMIT = 1000;

type DetailNews = {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  category: string | null;
  importanceScore: number | null;
  relevanceScore: number | null;
  corroborationCount: number;
  relevanceGrade: string | null;
  publishedAt: string | null;
};

function byTimeDesc(
  a: { publishedAt: Date | null; createdAt: Date },
  b: { publishedAt: Date | null; createdAt: Date },
): number {
  const at = (a.publishedAt ?? a.createdAt).getTime();
  const bt = (b.publishedAt ?? b.createdAt).getTime();
  return bt - at;
}

export async function GET(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const name = params.get("name")?.trim() || "";
  const publisher = params.get("publisher")?.trim() || "";

  try {
    const rows = await db
      .select({
        id: news.id,
        title: news.title,
        summary: news.summary,
        url: news.url,
        source: news.source,
        category: news.category,
        importanceScore: news.importanceScore,
        relevanceScore: news.relevanceScore,
        publishedAt: news.publishedAt,
        createdAt: news.createdAt,
        analyzedAt: news.analyzedAt,
        entityTags: news.entityTags,
        corroborationCount: news.corroborationCount,
        relevanceGrade: news.relevanceGrade,
      })
      .from(news)
      .where(isNotNull(news.analyzedAt))
      .orderBy(desc(news.createdAt))
      .limit(SCAN_LIMIT);

    const dossierRows: DossierRow[] = rows.map((row) => ({
      source: row.source,
      entityTags: row.entityTags,
      importanceScore: row.importanceScore,
      corroborationCount: row.corroborationCount,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
    }));

    if (!name && !publisher) {
      const stats = buildDossierStats(dossierRows, new Date());
      return Response.json({
        success: true,
        entities: stats.entities,
        publishers: stats.publishers,
        kpis: stats.kpis,
        scanned: rows.length,
      });
    }

    // Detail dossier (entity OR publisher). `name` wins when both are sent.
    const matched: typeof rows = name
      ? rows.filter((row) => (row.entityTags ?? []).some((entity) => entity.trim() === name))
      : rows.filter((row) => row.source.trim() === publisher);

    const detail: MetricStat = name
      ? buildEntityStats(
          matched.map((row) => ({
            source: row.source,
            entityTags: [name],
            importanceScore: row.importanceScore,
            corroborationCount: row.corroborationCount,
            publishedAt: row.publishedAt,
            createdAt: row.createdAt,
          })),
        )[0] ?? emptyMetricStat(name)
      : buildPublisherStats(
          matched.map((row) => ({
            source: row.source,
            entityTags: row.entityTags,
            importanceScore: row.importanceScore,
            corroborationCount: row.corroborationCount,
            publishedAt: row.publishedAt,
            createdAt: row.createdAt,
          })),
        )[0] ?? emptyMetricStat(publisher);

    const newsItems: DetailNews[] = [...matched]
      .sort(byTimeDesc)
      .slice(0, 50)
      .map((row) => ({
        id: row.id,
        title: row.title,
        summary: row.summary,
        url: row.url,
        source: row.source,
        category: row.category,
        importanceScore: row.importanceScore,
        relevanceScore: row.relevanceScore,
        corroborationCount: row.corroborationCount,
        relevanceGrade: row.relevanceGrade,
        publishedAt: (row.publishedAt ?? row.createdAt)?.toISOString() ?? null,
      }));

    return Response.json({
      success: true,
      stats: detail,
      kind: name ? "entity" : "publisher",
      news: newsItems,
    });
  } catch (error) {
    return dbErrorResponse(error, "خواندن پروندهٔ ناشران و نهادها ناموفق بود.");
  }
}

export { diagnoseDbError };
