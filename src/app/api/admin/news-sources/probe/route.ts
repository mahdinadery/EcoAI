import { checkAdminAccess } from "@/lib/admin/access";
import { dbErrorResponse } from "@/lib/admin/db-error-response";
import { runWithSchemaRepair } from "@/lib/admin/schema-sync";
import { probeFeedHealth } from "@/lib/news/feed-health";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/news-sources/probe
 *
 * On-demand feed health check (Phase 1). Body: `{}` for every active source, or
 * `{ "sourceId": "…" }` to probe a single one. Fetches each feed WITHOUT
 * storing news and refreshes the source's health snapshot columns, so a dead,
 * empty or stale feed is visible immediately instead of at the next ingest.
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  let body: { sourceId?: string } = {};
  try {
    body = (await request.json()) as { sourceId?: string };
  } catch {
    body = {};
  }

  // Older databases may not have the Phase 1 health columns yet — repair once.
  const outcome = await runWithSchemaRepair(() => probeFeedHealth(body.sourceId?.trim() || null));
  if (!outcome.ok) {
    return dbErrorResponse(outcome.error, "بررسی سلامت فیدها ناموفق بود.", outcome.repair);
  }

  const results = outcome.value;
  if (body.sourceId?.trim() && results.length === 0) {
    return Response.json({ success: false, message: "منبع موردنظر پیدا نشد." }, { status: 404 });
  }
  return Response.json({
    success: true,
    results,
    summary: {
      total: results.length,
      ok: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
    },
  });
}
