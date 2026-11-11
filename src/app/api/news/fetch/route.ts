import { checkAdminAccess } from "@/lib/admin/access";
import { drainArticleQueue } from "@/lib/news/article-queue";
import { ingestNews } from "@/lib/news/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_AI_ITEMS_PER_RUN = 16;

/**
 * POST /api/news/fetch
 *
 * Pipeline:
 * 1. Ingest all active sources.
 * 2. Recover stale AI_PROCESSING items.
 * 3. Process only a small sequential batch of READY_FOR_AI items.
 * 4. Evaluate auto-send only for items analyzed in this run.
 *
 * Ingestion is intentionally not limited: all newly fetched articles are
 * stored and remain in READY_FOR_AI until a later scheduled run processes them.
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);

  if (!access.authorized) {
    return Response.json(
      {
        success: false,
        code: "unauthorized",
        message: access.reason,
      },
      { status: 401 },
    );
  }
  try {
    let ingestOnly = false;
    try {
      const body = (await request.json()) as { ingestOnly?: boolean } | null;
      ingestOnly = Boolean(body?.ingestOnly);
    } catch {
      // Empty body is fine (default full pass).
    }

    const result = await ingestNews();

    if (!result.ok) {
      return Response.json({
        success: false,
        code: result.code,
        message: result.message,
        detail: result.detail ?? null,
      });
    }

    if (ingestOnly) {
      return Response.json({
        success: true,
        ingestOnly: true,
        source: result.source,
        fetched: result.fetched,
        stored: result.stored,
        newArticleIds: result.newArticleIds,
        queuedForAnalysis: [],
        topicSkipped: [],
        analyzed: [],
        duplicates: result.duplicates,
        skipped: result.skipped,
        filtered: result.filtered,
        autoSend: null,
      });
    }

    // The shared queue drains older received articles before new arrivals.
    const queue = await drainArticleQueue({ limit: MAX_AI_ITEMS_PER_RUN, maxDurationMs: 26_000 });

    return Response.json({
      success: true,
      source: result.source,
      fetched: result.fetched,
      stored: result.stored,
      newArticleIds: result.newArticleIds,
      queuedForAnalysis: queue.analyzed.map((item) => item.id),
      topicSkipped: queue.skipped,
      analyzed: queue.analyzed,
      queueBusy: queue.busy,
      queueBlocked: queue.blocked,
      duplicates: result.duplicates,
      skipped: result.skipped,
      filtered: result.filtered,
      autoSend: queue.send,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    console.error(
      "[news-fetch] unexpected error:",
      detail.slice(0, 200),
    );

    return Response.json(
      {
        success: false,
        code: "unknown_error",
        message: "Unexpected error while fetching news.",
        detail: null,
      },
      { status: 500 },
    );
  }
}
