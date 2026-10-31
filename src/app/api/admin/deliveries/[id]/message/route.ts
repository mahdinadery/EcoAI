import { ADMIN_ACTOR, accessDenied, readJson, resolveId, toResponse, type RouteContext } from "../../_shared";
import { editDeliveryMessage } from "@/lib/delivery/publishing";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/admin/deliveries/[id]/message
 * Body: { "message": "..." }
 *
 * Edits ONLY the delivery artifact (deliveries.message). The news row, its AI
 * summary and the ai_analyses history are never touched by this endpoint, and an
 * edit is refused once the row has been sent.
 */
export async function PATCH(request: Request, routeContext: RouteContext) {
  const denied = accessDenied(request);
  if (denied) return denied;

  const id = await resolveId(routeContext);
  const body = await readJson(request);

  if (typeof body.message !== "string") {
    return Response.json({ success: false, message: "فیلد message (متن) الزامی است." }, { status: 400 });
  }

  const result = await editDeliveryMessage(id, body.message, ADMIN_ACTOR);

  return toResponse(result, "متن پیام نهایی به‌روزرسانی شد.");
}
