import { ADMIN_ACTOR, accessDenied, resolveId, toResponse, type RouteContext } from "../../_shared";
import { cancelDelivery } from "@/lib/delivery/publishing";

export const dynamic = "force-dynamic";

/** POST /api/admin/deliveries/[id]/cancel — close an open candidate (kept as history). */
export async function POST(request: Request, routeContext: RouteContext) {
  const denied = accessDenied(request);
  if (denied) return denied;

  const id = await resolveId(routeContext);
  const result = await cancelDelivery(id, ADMIN_ACTOR);

  return toResponse(result, "نامزد لغو شد.");
}
