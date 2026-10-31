import { checkAdminAccess } from "@/lib/admin/access";
import { activateAiConfigVersion } from "@/lib/ai/config-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/ai-config/activate
 * Body: { "id": "<configuration row id>" }
 *
 * Activates a previously saved configuration version as-is (no content edits).
 * Exactly one configuration remains active after this call.
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  let body: { id?: string };
  try {
    body = (await request.json()) as { id?: string };
  } catch {
    return Response.json({ success: false, message: "بدنه درخواست JSON معتبر نیست." }, { status: 400 });
  }

  if (!body.id || typeof body.id !== "string") {
    return Response.json({ success: false, message: "شناسه نسخه پیکربندی معتبر نیست." }, { status: 400 });
  }

  try {
    const activated = await activateAiConfigVersion(body.id);
    if (!activated) {
      return Response.json({ success: false, message: "نسخه پیکربندی مورد نظر پیدا نشد." }, { status: 404 });
    }
    return Response.json({ success: true, config: activated });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[ai-config-activate] failed:", detail.slice(0, 200));
    return Response.json({ success: false, message: "فعال‌سازی نسخه پیکربندی ناموفق بود." }, { status: 500 });
  }
}
