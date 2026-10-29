import { checkAdminAccess } from "@/lib/admin/access";
import { ingestFeedXml } from "@/lib/news/source-ingest";
import { getSourceById } from "@/lib/news/sources-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/news-import
 * Body: { "xml": "<rss>…", "sourceId?": "uuid" }
 *
 * Manual feed-XML ingestion for sources this server cannot reach directly
 * (geo-blocked Iranian hosts): fetch the feed yourself (browser/curl), paste
 * the XML here, and it goes through the same parse/normalize/dedupe/store
 * pipeline as a live fetch. Never sends anything anywhere.
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  let body: { xml?: string; sourceId?: string };
  try {
    body = (await request.json()) as { xml?: string; sourceId?: string };
  } catch {
    return Response.json({ success: false, message: "بدنه درخواست JSON معتبر نیست." }, { status: 400 });
  }

  if (!body.xml || typeof body.xml !== "string") {
    return Response.json({ success: false, message: "فیلد xml الزامی است." }, { status: 400 });
  }

  let source = null;
  if (body.sourceId) {
    source = await getSourceById(body.sourceId);
    if (!source) {
      return Response.json({ success: false, message: "منبع انتخابی پیدا نشد." }, { status: 404 });
    }
  }

  const result = await ingestFeedXml(body.xml, source);

  if (result.ok) {
    return Response.json({ success: true, ...result.report });
  }

  return Response.json({ success: false, message: result.message });
}
