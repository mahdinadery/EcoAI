import { accessDenied, resolveId, type RouteContext } from "../_shared";

import { getDeliveryDetail } from "@/lib/delivery/publishing";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/deliveries/[id]
 * Delivery row + its news article + the linked AI analysis + audit trail.
 * Never returns Bale credentials or provider internals beyond the safe summary.
 */
export async function GET(request: Request, routeContext: RouteContext) {
  const denied = accessDenied(request);
  if (denied) return denied;

  const id = await resolveId(routeContext);
  const detail = await getDeliveryDetail(id);

  if (!detail) {
    return Response.json({ success: false, message: "رکورد ارسال پیدا نشد." }, { status: 404 });
  }

  const iso = (value: Date | null) => (value ? value.toISOString() : null);

  return Response.json({
    success: true,
    delivery: {
      id: detail.delivery.id,
      newsId: detail.delivery.newsId,
      destination: detail.delivery.destination,
      status: detail.delivery.status,
      triggeredBy: detail.delivery.triggeredBy,
      message: detail.delivery.message,
      errorMessage: detail.delivery.errorMessage,
      providerMessageId: detail.delivery.providerMessageId,
      approvedAt: iso(detail.delivery.approvedAt),
      approvedBy: detail.delivery.approvedBy,
      overrideRequested: detail.delivery.overrideRequested,
      overrideReason: detail.delivery.overrideReason,
      retryCount: detail.delivery.retryCount,
      createdAt: iso(detail.delivery.createdAt),
      sentAt: iso(detail.delivery.sentAt),
      aiAnalysisId: detail.delivery.aiAnalysisId,
    },
    article: {
      id: detail.article.id,
      title: detail.article.title,
      url: detail.article.url,
      source: detail.article.source,
      status: detail.article.status,
      publishedAt: iso(detail.article.publishedAt),
      fetchedAt: iso(detail.article.fetchedAt),
    },
    analysis: detail.analysis
      ? {
          id: detail.analysis.id,
          configurationVersion: detail.analysis.configurationVersion,
          model: detail.analysis.model,
          status: detail.analysis.status,
          summary: detail.analysis.summary,
          category: detail.analysis.category,
          importance: detail.analysis.importance,
          relevance: detail.analysis.relevance,
          novelty: detail.analysis.novelty,
          mainEvent: detail.analysis.mainEvent,
          shouldSend: detail.analysis.shouldSend,
          reason: detail.analysis.reason,
          createdAt: iso(detail.analysis.createdAt),
        }
      : null,
    events: detail.events.map((event) => ({
      id: event.id,
      event: event.event,
      detail: event.detail,
      actor: event.actor,
      createdAt: iso(event.createdAt),
    })),
  });
}
