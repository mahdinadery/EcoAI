import { ADMIN_ACTOR, accessDenied } from "./_shared";
import { dbErrorResponse } from "@/lib/admin/db-error-response";
import { runWithSchemaRepair } from "@/lib/admin/schema-sync";
import { ensureDeliveryCandidate, listAdminDeliveries } from "@/lib/delivery/publishing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/deliveries
 * Paginated candidate/attempt list + status statistics for the admin table.
 */
export async function GET(request: Request) {
  const denied = accessDenied(request);
  if (denied) return denied;

  const url = new URL(request.url);

  const outcome = await runWithSchemaRepair(() =>
    listAdminDeliveries({
      status: url.searchParams.get("status") ?? undefined,
      destination: url.searchParams.get("destination") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      page: Number(url.searchParams.get("page") ?? 1) || 1,
      pageSize: Number(url.searchParams.get("pageSize") ?? 20) || 20,
    }),
  );

  if (outcome.ok) {
    return Response.json({ success: true, ...outcome.value, schemaSynced: outcome.schemaSynced });
  }

  console.error("[deliveries] list failed:", String(outcome.error).slice(0, 200));
  return dbErrorResponse(outcome.error, "خطا در بارگذاری فهرست ارسال‌ها.", outcome.repair);
}

/**
 * POST /api/admin/deliveries
 * Body: { newsId, destination? } — open a delivery candidate (never sends).
 */
export async function POST(request: Request) {
  const denied = accessDenied(request);
  if (denied) return denied;

  let body: { newsId?: string; destination?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ success: false, message: "بدنه درخواست JSON معتبر نیست." }, { status: 400 });
  }

  if (!body.newsId) {
    return Response.json({ success: false, message: "شناسه خبر الزامی است." }, { status: 400 });
  }

  const result = await ensureDeliveryCandidate(body.newsId, body.destination ?? "bale", ADMIN_ACTOR);

  if (result.ok) {
    return Response.json({ success: true, deliveryId: result.deliveryId, status: result.status, message: result.message ?? "نامزد ارسال ساخته شد." });
  }

  return Response.json({ success: false, code: result.code, message: result.message }, { status: 400 });
}
