/**
 * Feed health probing (Phase 1) — SERVER-SIDE ONLY.
 *
 * On-demand variant of what the ingestion pipeline already records: fetch a
 * source's feed WITHOUT storing news, then refresh its health snapshot columns
 * (lastItemCount / lastNewestPublishedAt / lastSuccessAt / lastError) so the
 * admin UI can show "is my feed alive?" without waiting for the next ingest.
 *
 * Failure texts come from feed-client.ts (classified, with Persian hints for
 * Iran-hosted feeds) — the same actionable diagnostics the ingest path shows.
 */

import { db } from "@/db";
import { newsSources, type NewsSourceRow } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { fetchFeed } from "./rss";
import { computeSourceHealth, computeSourceHealthDetail } from "./sources-service";
import type { SourceHealth } from "./status";

export type FeedProbeResult = {
  sourceId: string;
  name: string;
  url: string;
  ok: boolean;
  /** Items parsed from the feed on this probe (0 when the probe failed). */
  itemCount: number;
  /** Newest publishedAt seen on this probe (ISO), null when unknown. */
  newestPublishedAt: string | null;
  /** Classified failure message (+ hint) when ok is false, else null. */
  error: string | null;
  health: SourceHealth;
  healthDetail: string | null;
};

function newestPublishedAtOf(items: Array<{ publishedAt: Date | null }>): Date | null {
  let newest: Date | null = null;
  for (const item of items) {
    if (item.publishedAt && (!newest || item.publishedAt.getTime() > newest.getTime())) {
      newest = item.publishedAt;
    }
  }
  return newest;
}

async function probeOne(source: NewsSourceRow): Promise<FeedProbeResult> {
  const now = new Date();
  const fetched = await fetchFeed(source.url);

  if (fetched.ok) {
    const newest = newestPublishedAtOf(fetched.items);
    try {
      await db
        .update(newsSources)
        .set({
          lastSuccessAt: now,
          lastAttemptAt: now,
          lastError: null,
          lastItemCount: fetched.items.length,
          lastNewestPublishedAt: newest,
          updatedAt: now,
        })
        .where(eq(newsSources.id, source.id));
    } catch {
      // Health bookkeeping must never fail the probe itself.
    }
    const refreshed: NewsSourceRow = {
      ...source,
      lastSuccessAt: now,
      lastAttemptAt: now,
      lastError: null,
      lastItemCount: fetched.items.length,
      lastNewestPublishedAt: newest,
    };
    return {
      sourceId: source.id,
      name: source.name,
      url: source.url,
      ok: true,
      itemCount: fetched.items.length,
      newestPublishedAt: newest ? newest.toISOString() : null,
      error: null,
      health: computeSourceHealth(refreshed),
      healthDetail: computeSourceHealthDetail(refreshed),
    };
  }

  const errorText = [fetched.message, fetched.detail].filter(Boolean).join(" — ");
  try {
    await db
      .update(newsSources)
      .set({
        lastAttemptAt: now,
        lastError: errorText.slice(0, 500),
        errorCount: (source.errorCount ?? 0) + 1,
        updatedAt: now,
      })
      .where(eq(newsSources.id, source.id));
  } catch {
    // best effort
  }
  const refreshed: NewsSourceRow = {
    ...source,
    lastAttemptAt: now,
    lastError: errorText.slice(0, 500),
    errorCount: (source.errorCount ?? 0) + 1,
  };
  return {
    sourceId: source.id,
    name: source.name,
    url: source.url,
    ok: false,
    itemCount: 0,
    newestPublishedAt: null,
    error: errorText.slice(0, 500) || "خطای نامشخص",
    health: computeSourceHealth(refreshed),
    healthDetail: computeSourceHealthDetail(refreshed),
  };
}

/**
 * Probes one source (by id) or every active RSS source, refreshing health
 * snapshots. Never throws; individual failures are reported per source.
 */
export async function probeFeedHealth(sourceId?: string | null): Promise<FeedProbeResult[]> {
  const rows = sourceId
    ? await db.select().from(newsSources).where(eq(newsSources.id, sourceId)).limit(1)
    : await db.select().from(newsSources).where(eq(newsSources.active, true)).orderBy(desc(newsSources.priority));

  const results: FeedProbeResult[] = [];
  for (const row of rows) {
    results.push(await probeOne(row));
  }
  return results;
}
