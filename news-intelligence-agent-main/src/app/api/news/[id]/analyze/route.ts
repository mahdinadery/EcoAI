import { maybeRunAutoSend } from "@/lib/agent/auto-hook";
import { ensureDeliveryCandidate } from "@/lib/delivery/publishing";
import { analyzeArticle } from "@/lib/news/analyze";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ id: string }> | { id: string };
};

/**
 * POST /api/news/[id]/analyze
 *
 * Triggers AI analysis of a specific stored article by ID.
 * Returns the structured analysis and stores it in PostgreSQL.
 */
export async function POST(
  request: Request,
  routeContext: RouteParams
) {
  try {
    // Resolve params robustly whether it is a Promise or a direct object
    const resolvedParams = "then" in routeContext.params 
      ? await routeContext.params 
      : routeContext.params;
      
    const { id } = resolvedParams;

    if (!id || typeof id !== "string") {
      return Response.json(
        { success: false, code: "invalid_id", message: "شناسه خبر معتبر نیست." },
        { status: 400 }
      );
    }

    const result = await analyzeArticle(id);

    if (result.ok) {
      // Auto-delivery: the freshly analyzed article is evaluated against the rule.
      // Runs after the analysis is safely persisted and never fails this response.
      const autoSend = await maybeRunAutoSend([id]);

      // Milestone 8: when the AI recommends sending, open a publishing CANDIDATE
      // for human approval. This never sends anything — and any failure here is
      // swallowed so the analysis result is still returned intact.
      let candidate: { created: boolean; deliveryId?: string; status?: string } = { created: false };
      if (result.newsItem.shouldSend === true) {
        try {
          const opened = await ensureDeliveryCandidate(id, "bale", "analyze-hook");
          if (opened.ok) candidate = { created: true, deliveryId: opened.deliveryId, status: opened.status };
        } catch (error) {
          console.error("[news-analyze] candidate creation failed:", String(error).slice(0, 160));
        }
      }

      return Response.json({
        success: true,
        autoSend,
        candidate,
        status: result.newsItem.status,
        newsItem: {
          id: result.newsItem.id,
          title: result.newsItem.title,
          summary: result.newsItem.summary,
          category: result.newsItem.category,
          importanceScore: result.newsItem.importanceScore,
          relevanceScore: result.newsItem.relevanceScore,
          noveltyScore: result.newsItem.noveltyScore,
          shouldSend: result.newsItem.shouldSend,
          analysisReason: result.newsItem.analysisReason,
          analyzedAt: result.newsItem.analyzedAt ? result.newsItem.analyzedAt.toISOString() : null,
        },
      });
    }

    // Return handled error
    return Response.json({
      success: false,
      code: result.code,
      message: result.message,
      detail: result.detail ?? null,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[news-analyze] unexpected route error:", detail.slice(0, 200));

    return Response.json(
      {
        success: false,
        code: "unknown_error",
        message: "خطای ناشناخته در زمان اجرای تحلیل خبر.",
        detail: null,
      },
      { status: 500 }
    );
  }
}
