import { ADMIN_ACTOR, accessDenied, resolveId, toResponse, type RouteContext } from "../../_shared";
import { retryDelivery } from "@/lib/delivery/publishing";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/deliveries/[id]/retry
 *
 * Re-sends a FAILED attempt with the SAME stored content, bumping retry_count.
 * Refuses anything already sent (sentAt / provider message id present), so a
 * retry can never double-publish.
 */
export async function POST(request: Request, routeContext: RouteContext) {
  const denied = accessDenied(request);
  if (denied) return denied;

  const id = await resolveId(routeContext);
  const result = await retryDelivery(id, ADMIN_ACTOR);

  return toResponse(result, "تلاش مجدد انجام شد.");
}
