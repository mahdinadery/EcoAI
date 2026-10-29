import { ADMIN_ACTOR, accessDenied, readJson, resolveId, toResponse, type RouteContext } from "../../_shared";
import { approveDelivery } from "@/lib/delivery/publishing";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/deliveries/[id]/approve
 * Body: { "force"?: boolean, "reason"?: string }
 *
 * Approves an open candidate so it becomes sendable. Approving against a
 * negative AI recommendation requires force + a reason, and is recorded as an
 * override on the delivery row — the AI analysis itself is never modified.
 */
export async function POST(request: Request, routeContext: RouteContext) {
  const denied = accessDenied(request);
  if (denied) return denied;

  const id = await resolveId(routeContext);
  const body = await readJson(request);

  const result = await approveDelivery(id, {
    actor: ADMIN_ACTOR,
    force: body.force === true,
    reason: typeof body.reason === "string" ? body.reason : null,
  });

  return toResponse(result, "نامزد تأیید شد؛ اکنون قابل ارسال است.");
}
