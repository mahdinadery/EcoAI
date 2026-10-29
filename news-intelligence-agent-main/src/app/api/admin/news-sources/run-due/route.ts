import { checkAdminAccess } from "@/lib/admin/access";
import { runDueSources } from "@/lib/news/source-ingest";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/news-sources/run-due
 *
 * Minimal, reliable scheduling mechanism (the project had none — no second
 * scheduler was introduced): one pass over ACTIVE rss sources whose own
 * fetchIntervalMinutes has elapsed since their last attempt. Each source is
 * handled independently; one failure never stops the sweep.
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  try {
    const result = await runDueSources();
    return Response.json({ success: true, ...result });
  } catch (error) {
    console.error("[news-sources] run-due failed:", (error instanceof Error ? error.message : String(error)).slice(0, 200));
    return Response.json({ success: false, message: "اجرای دریافت زمان‌بندی‌شده ناموفق بود." }, { status: 500 });
  }
}
