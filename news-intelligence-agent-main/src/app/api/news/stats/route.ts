import { getAiTokenUsageStats, getNewsStats } from "@/lib/news/ingest";
import { getNewsFeedUrl } from "@/lib/news/rss";

export const dynamic = "force-dynamic";

/**
 * GET /api/news/stats
 *
 * Read-only counters for the dashboard. Returns counts only — no raw rows,
 * no stack traces and no environment values beyond a configured/not-configured
 * flag for the feed URL.
 */
export async function GET() {
  try {
    const stats = await getNewsStats();
    let tokenUsage = {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      todayTokens: 0,
      analyzedCount: 0,
    };
    try {
      tokenUsage = await getAiTokenUsageStats();
    } catch {
      // Best-effort if the token columns are not yet synced.
    }

    return Response.json({
      success: true,
      totalStored: stats.totalStored,
      lastFetchCount: stats.lastFetchCount,
      lastFetchedAt: stats.lastFetchedAt,
      sources: stats.sources,
      tokenUsage,
      feedConfigured: getNewsFeedUrl().ok,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[news-stats] unexpected error:", detail.slice(0, 200));

    return Response.json(
      {
        success: false,
        totalStored: 0,
        lastFetchCount: 0,
        lastFetchedAt: null,
        sources: 0,
        feedConfigured: getNewsFeedUrl().ok,
        message: "Could not read news statistics.",
      },
      { status: 500 },
    );
  }
}
