import { checkAdminAccess } from "@/lib/admin/access";
import { ingestFromSource } from "@/lib/news/source-ingest";
import { getSourceById } from "@/lib/news/sources-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

/**
 * POST /api/admin/news-sources/[id]/fetch
 *
 * "Fetch Now": run the full ingestion pipeline for one source (fetch → parse →
 * normalize → canonicalize → dedupe → store) and report counts. AI analysis is
 * NOT run from here — ingestion and intelligence stay separate stages.
 */
export async function POST(request: Request, routeContext: RouteContext) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  const resolved = "then" in routeContext.params ? await routeContext.params : routeContext.params;

  try {
    const source = await getSourceById(resolved.id);
    if (!source) {
      return Response.json({ success: false, message: "منبع مورد نظر پیدا نشد." }, { status: 404 });
    }

    const report = await ingestFromSource(source);

    if (report.ok) {
      return Response.json({
        success: true,
        report: {
          itemsFound: report.itemsFound,
          itemsCreated: report.itemsCreated,
          itemsFiltered: report.itemsFiltered,
          duplicates: report.duplicates,
          skipped: report.skippedMalformed,
          feedSourceName: report.feedSourceName,
        },
      });
    }

    return Response.json({ success: true, failure: { code: report.code, message: report.message, detail: report.detail ?? null } });
  } catch (error) {
    console.error("[news-sources] manual fetch failed:", (error instanceof Error ? error.message : String(error)).slice(0, 200));
    return Response.json({ success: false, message: "دریافت دستی منبع ناموفق بود." }, { status: 500 });
  }
}
