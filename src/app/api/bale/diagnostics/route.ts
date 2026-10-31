import { checkAdminAccess } from "@/lib/admin/access";
import { diagnoseBaleChannel } from "@/lib/bale/diagnostics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/bale/diagnostics
 *
 * Read-only checks for "why didn't the news reach my Bale channel?":
 * token → chat lookup → bot membership/admin rights → post permission.
 * Never sends a message and never returns the token or the full chat id.
 */
export async function GET(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  try {
    const diagnostics = await diagnoseBaleChannel();
    return Response.json({ success: true, ...diagnostics });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[bale-diagnostics] unexpected error:", detail.slice(0, 200));

    return Response.json(
      { success: false, message: "بررسی کانال بله ناموفق بود؛ دوباره تلاش کنید." },
      { status: 500 },
    );
  }
}
