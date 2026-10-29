import { db, isNextProductionBuild } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Liveness probe for Render (`healthCheckPath`). The only job is to answer as
 * soon as the process can serve requests.
 *
 * The DB ping retries briefly on purpose: Neon-style databases auto-suspend,
 * and waking one can exceed the pool's 5s connection timeout — which used to
 * fail the FIRST probe and mark an otherwise healthy deploy as "Failed to
 * deploy" (health check failure). A couple of quick retries absorb cold starts
 * while still reporting 500 when the database is genuinely unreachable.
 */
async function pingDatabase(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await db.execute(sql`select 1`);
      return true;
    } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  return false;
}

export async function GET() {
  if (isNextProductionBuild) {
    return Response.json({ ok: true });
  }

  const ok = await pingDatabase();
  return Response.json({ ok }, ok ? undefined : { status: 500 });
}
