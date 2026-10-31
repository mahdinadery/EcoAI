import { checkAdminAccess } from "@/lib/admin/access";
import { deleteSource, SourceInputError, updateSource } from "@/lib/news/sources-service";
import type { SourceInput } from "@/lib/news/sources-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

async function resolveId(routeContext: RouteContext): Promise<string> {
  const resolved = "then" in routeContext.params ? await routeContext.params : routeContext.params;
  return resolved.id;
}

/** PATCH /api/admin/news-sources/[id] — edit / enable / disable a source. */
export async function PATCH(request: Request, routeContext: RouteContext) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  const id = await resolveId(routeContext);
  let body: Partial<SourceInput>;
  try {
    body = (await request.json()) as Partial<SourceInput>;
  } catch {
    return Response.json({ success: false, message: "بدنه درخواست JSON معتبر نیست." }, { status: 400 });
  }

  try {
    const updated = await updateSource(id, body);
    if (!updated) return Response.json({ success: false, message: "منبع مورد نظر پیدا نشد." }, { status: 404 });
    return Response.json({ success: true, source: updated });
  } catch (error) {
    if (error instanceof SourceInputError) {
      return Response.json({ success: false, message: "اعتبارسنجی منبع ناموفق بود.", errors: error.errors }, { status: 400 });
    }
    console.error("[news-sources] update failed:", (error instanceof Error ? error.message : String(error)).slice(0, 200));
    return Response.json({ success: false, message: "ویرایش منبع ناموفق بود." }, { status: 500 });
  }
}

/** DELETE /api/admin/news-sources/[id] — remove the source (news/runs keep their history). */
export async function DELETE(request: Request, routeContext: RouteContext) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  const id = await resolveId(routeContext);
  try {
    const deleted = await deleteSource(id);
    if (!deleted) return Response.json({ success: false, message: "منبع مورد نظر پیدا نشد." }, { status: 404 });
    return Response.json({ success: true });
  } catch (error) {
    console.error("[news-sources] delete failed:", (error instanceof Error ? error.message : String(error)).slice(0, 200));
    return Response.json({ success: false, message: "حذف منبع ناموفق بود." }, { status: 500 });
  }
}
