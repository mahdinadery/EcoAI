import { checkAdminAccess } from "@/lib/admin/access";
import { dbErrorResponse } from "@/lib/admin/db-error-response";
import { runWithSchemaRepair } from "@/lib/admin/schema-sync";
import { listAiConfigVersions } from "@/lib/ai/config-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/ai-config/history
 *
 * Newest-first list of every saved configuration version, for the "Version
 * History" table in /admin/ai-config. No secrets are stored in this table.
 */
export async function GET(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  const outcome = await runWithSchemaRepair(() => listAiConfigVersions(50));

  if (outcome.ok) {
    return Response.json({ success: true, versions: outcome.value, schemaSynced: outcome.schemaSynced });
  }

  console.error("[ai-config-history] failed to load versions:", String(outcome.error).slice(0, 200));
  return dbErrorResponse(outcome.error, "خطا در بارگذاری تاریخچه نسخه‌ها.", outcome.repair);
}
