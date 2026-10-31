import { checkAdminAccess } from "@/lib/admin/access";
import { testFeedWithoutStoring } from "@/lib/news/source-ingest";
import { getSourceById } from "@/lib/news/sources-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

/**
 * POST /api/admin/news-sources/[id]/test
 * Body: optionally { "url": "..." } to test a draft URL before saving.
 *
 * Connection test only: fetch + parse + count/sample. Nothing is stored.
 */
export async function POST(request: Request, routeContext: RouteContext) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  let body: { url?: string } | null = null;
  try {
    body = (await request.json()) as { url?: string };
  } catch {
    body = null;
  }

  let url = body?.url?.trim() ?? "";

  if (!url) {
    const resolved = "then" in routeContext.params ? await routeContext.params : routeContext.params;
    const source = await getSourceById(resolved.id);
    if (!source) {
      return Response.json({ success: false, message: "منبع مورد نظر پیدا نشد." }, { status: 404 });
    }
    url = source.url;
  }

  const startedAt = Date.now();
  const result = await testFeedWithoutStoring(url);
  const elapsedMs = Date.now() - startedAt;

  if (!result.ok) {
    return Response.json({ success: true, test: { ok: false, elapsedMs, message: result.message, detail: result.detail ?? null } });
  }

  return Response.json({
    success: true,
    test: {
      ok: true,
      elapsedMs,
      feedTitle: result.feedTitle,
      itemCount: result.itemCount,
      skipped: result.skipped,
      sample: result.sample,
    },
  });
}
