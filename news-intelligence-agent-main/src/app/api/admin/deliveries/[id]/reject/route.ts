import { ADMIN_ACTOR, accessDenied, readJson, resolveId, toResponse, type RouteContext } from "../../_shared";
import { rejectDelivery } from "@/lib/delivery/publishing";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/deliveries/[id]/reject
 * Body: { "reason"?: string }
 *
 * Rejects a candidate -> cancelled. The row is kept as history, never deleted.
 */
export async function POST(request: Request, routeContext: RouteContext) {
  const denied = accessDenied(request);
  if (denied) return denied;

  const id = await resolveId(routeContext);
  const body = await readJson(request);

  const result = await rejectDelivery(id, typeof body.reason === "string" ? body.reason : undefined, ADMIN_ACTOR);

  return toResponse(result, "نامزد رد شد و به تاریخچه منتقل گردید.");
}
