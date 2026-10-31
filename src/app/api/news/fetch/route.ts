import { checkAdminAccess } from "@/lib/admin/access";
import { maybeRunAutoSend } from "@/lib/agent/auto-hook";
import {
  analyzeSequentially,
  applyTopicGate,
  recoverStaleProcessing,
  selectAnalysisBacklog,
} from "@/lib/news/analysis-queue";
import { ingestNews } from "@/lib/news/ingest";

export const dynamic = "force-dynamic";

const MAX_AI_ITEMS_PER_RUN = 4;

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
    const result = await ingestNews();

    if (!result.ok) {
      return Response.json({
        success: false,
        code: result.code,
        message: result.message,
        detail: result.detail ?? null,
      });
    }

    // Recover articles that were left in AI_PROCESSING by an interrupted
    // request or server restart.
    await recoverStaleProcessing();

    // Prefer articles fetched in this run, then continue with older backlog.
    const selectedIds: string[] = [];

    for (const id of result.newArticleIds) {
      if (selectedIds.length >= MAX_AI_ITEMS_PER_RUN) break;
      selectedIds.push(id);
    }

    if (selectedIds.length < MAX_AI_ITEMS_PER_RUN) {
      const remaining = MAX_AI_ITEMS_PER_RUN - selectedIds.length;
      const backlog = await selectAnalysisBacklog(remaining, selectedIds);
      selectedIds.push(...backlog);
    }

    // Topic relevance gate BEFORE AI — off-topic items never reach the model.
    const gated = await applyTopicGate(selectedIds);
    const aiQueue = gated.pass;

    // IMPORTANT: keep AI calls sequential. This is intentional because the
    // provider has a low TPM limit.
    const analysisResults = await analyzeSequentially(aiQueue);

    // Auto-send only articles that were actually analyzed during this run.
    const analyzedIds = analysisResults
      .filter((item) => item.ok)
      .map((item) => item.id);

    const autoSend =
      analyzedIds.length > 0
        ? await maybeRunAutoSend(analyzedIds)
        : {
            ok: true,
            sent: 0,
            skipped: 0,
            reason: "No articles were successfully analyzed in this run.",
          };

    return Response.json({
      success: true,
      source: result.source,
      fetched: result.fetched,
      stored: result.stored,
      newArticleIds: result.newArticleIds,
      queuedForAnalysis: aiQueue,
      topicSkipped: gated.skipped,
      analyzed: analysisResults,
      duplicates: result.duplicates,
      skipped: result.skipped,
      filtered: result.filtered,
      autoSend,
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
