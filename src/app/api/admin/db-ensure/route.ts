import { pool } from "@/db";
import { checkAdminAccess } from "@/lib/admin/access";
import { diagnoseDbError } from "@/lib/admin/db-errors";
import { syncSchema } from "@/lib/admin/schema-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Tables the application code expects (see src/db/schema.ts). */
const EXPECTED_TABLES = [
  "news_sources",
  "news",
  "ai_analyses",
  "ingestion_runs",
  "deliveries",
  "delivery_events",
  "ai_configurations",
] as const;

/**
 * GET /api/admin/db-ensure — read-only schema status.
 * Lists which expected tables are missing, without changing anything.
 */
export async function GET(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<{ name: string; present: string | null }>(
      "select name, to_regclass('public.' || name)::text as present from unnest($1::text[]) as name",
      [EXPECTED_TABLES],
    );

    const tables = rows.map((row) => ({ name: row.name, present: Boolean(row.present) }));
    const missing = tables.filter((table) => !table.present).map((table) => table.name);

    return Response.json({ success: true, inSync: missing.length === 0, missing, tables });
  } catch (error) {
    const diagnosis = diagnoseDbError(error);
    console.error("[db-ensure] status check failed:", diagnosis.detail);
    return Response.json(
      {
        success: false,
        message: "بررسی وضعیت اسکیما ناموفق بود.",
        detail: diagnosis.detail,
        hint: diagnosis.hint,
        code: diagnosis.code ?? null,
      },
      { status: diagnosis.status },
    );
  }
}

/**
 * POST /api/admin/db-ensure — run the additive schema sync (same idempotent
 * steps as `npm run db:ensure`; never drops or rewrites data).
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  const result = await syncSchema();

  const response = {
    success: result.ok,
    executed: result.executed,
    total: result.total,
    warnings: result.warnings,
    durationMs: result.durationMs,
    ...(result.ok
      ? { message: "اسکیما با موفقیت همگام‌سازی شد." }
      : {
          message: "همگام‌سازی اسکیما ناموفق بود.",
          error: result.error,
          hint: "اگر خطای دسترسی (permission denied) است، کاربر دیتابیس باید مجوز CREATE/ALTER داشته باشد؛ در غیر این صورت npm run db:ensure را با همان DATABASE_URL اجرا کنید.",
        }),
  };

  if (result.ok) {
    console.log(`[db-ensure] schema synced: ${result.executed}/${result.total} statements in ${result.durationMs}ms`);
    if (result.warnings.length > 0) console.warn("[db-ensure] warnings:", result.warnings.join(" | ").slice(0, 500));
  } else {
    console.error("[db-ensure] failed:", result.error);
  }

  return Response.json(response, { status: result.ok ? 200 : 500 });
}
