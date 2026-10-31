import { ADMIN_ACTOR, accessDenied, readJson, resolveId, toResponse, type RouteContext } from "../../_shared";
import { sendDelivery } from "@/lib/delivery/publishing";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/deliveries/[id]/send
 * Body: { "force"?: boolean }
 *
 * The ONLY path that publishes, and it is always human-triggered:
 * approved -> sending (atomic claim) -> provider -> sent | failed.
 *
 * Two guards make double-publishing impossible by accident: the row is claimed
 * atomically (parallel clicks race for one claim), and any prior successful
 * delivery of the same news to the same destination is refused unless the admin
 * explicitly re-publishes with force=true (recorded in the audit trail).
 */
export async function POST(request: Request, routeContext: RouteContext) {
  const denied = accessDenied(request);
  if (denied) return denied;

  const id = await resolveId(routeContext);
  const body = await readJson(request);

  const result = await sendDelivery(id, ADMIN_ACTOR, { force: body.force === true });

  return toResponse(result, "پیام ارسال شد.");
}
