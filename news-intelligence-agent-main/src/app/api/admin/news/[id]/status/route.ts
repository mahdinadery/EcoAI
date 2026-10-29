import { checkAdminAccess } from "@/lib/admin/access";
import { setNewsStatus } from "@/lib/news/news-admin";
import { NEWS_STATUSES } from "@/lib/news/status";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

/**
 * PATCH /api/admin/news/[id]/status
 * Body: { "status": "READY_TO_SEND" | ... }
 *
 * Manual admin status transition only (e.g. "mark as processed"). This endpoint
 * NEVER sends anything and never triggers AI.
 */
export async function PATCH(request: Request, routeContext: RouteContext) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  let body: { status?: string };
  try {
    body = (await request.json()) as { status?: string };
  } catch {
    return Response.json({ success: false, message: "بدنه درخواست JSON معتبر نیست." }, { status: 400 });
  }

  const status = body?.status;
  if (!status || !NEWS_STATUSES.includes(status as (typeof NEWS_STATUSES)[number])) {
    return Response.json({ success: false, message: "وضعیت درخواستی معتبر نیست." }, { status: 400 });
  }

  const resolved = "then" in routeContext.params ? await routeContext.params : routeContext.params;

  try {
    const updated = await setNewsStatus(resolved.id, status);
    if (!updated) {
      return Response.json({ success: false, message: "خبر مورد نظر پیدا نشد." }, { status: 404 });
    }
    return Response.json({ success: true, status });
  } catch (error) {
    console.error("[admin-news] status update failed:", (error instanceof Error ? error.message : String(error)).slice(0, 200));
    return Response.json({ success: false, message: "تغییر وضعیت خبر ناموفق بود." }, { status: 500 });
  }
}
