/**
 * Automatic, additive-only schema repair — SERVER-SIDE ONLY.
 *
 * Why this exists: on hosts where neither `prestart` nor `postinstall` runs
 * reliably (Vercel only runs `next build`, and `scripts/db-ensure.mjs` is
 * invoked with `|| true` there), a fresh database silently misses tables such
 * as `ai_configurations`. The first admin request then failed with
 * "Failed query: select ... from ai_configurations" and the operator had to
 * run `npm run db:ensure` manually with the right DATABASE_URL.
 *
 * This module reuses the SAME idempotent step list as the CLI
 * (scripts/db-ensure.mjs → STEPS; never drops or rewrites data) and:
 *   1. runs it on demand from the admin UI (`POST /api/admin/db-ensure`), and
 *   2. runs it automatically once when a query fails with a schema-mismatch
 *      error, then retries the query exactly once.
 *
 * The successful result is cached per server instance so steady-state requests
 * never pay for DDL statements again.
 */

import { pool } from "@/db";
import { STEPS } from "../../../scripts/db-ensure.mjs";
import { isSchemaMismatchError } from "./db-errors";

export type SchemaSyncResult = {
  ok: boolean;
  /** Number of statements that ran successfully. */
  executed: number;
  total: number;
  /** WARNING notices from Postgres (skipped indexes/FKs, never data changes). */
  warnings: string[];
  /** Sanitized error message when ok === false. */
  error?: string;
  durationMs: number;
};

let cachedSuccess: SchemaSyncResult | null = null;
let inFlight: Promise<SchemaSyncResult> | null = null;

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgresql://[REDACTED]").slice(0, 400);
}

/** Runs every additive schema step against the application's pool. */
export async function syncSchema(): Promise<SchemaSyncResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  let executed = 0;

  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    return {
      ok: false,
      executed,
      total: STEPS.length,
      warnings,
      error: messageOf(error),
      durationMs: Date.now() - startedAt,
    };
  }

  const onNotice = (notice: { severity?: string; message?: string }) => {
    if (String(notice?.severity ?? "WARNING").toUpperCase() === "WARNING") {
      warnings.push(String(notice.message ?? "").slice(0, 300));
    }
  };

  client.on("notice", onNotice);

  try {
    for (const step of STEPS) {
      try {
        await client.query(step.sql);
        executed += 1;
      } catch (error) {
        return {
          ok: false,
          executed,
          total: STEPS.length,
          warnings,
          error: `step "${step.name}": ${messageOf(error)}`,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    return {
      ok: true,
      executed,
      total: STEPS.length,
      warnings,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    client.off?.("notice", onNotice);
    client.release();
  }
}

/**
 * Deduplicated automatic repair: concurrent requests share one run, and a
 * successful run is reused for the lifetime of this server instance.
 */
export function ensureSchemaOnce(): Promise<SchemaSyncResult> {
  if (cachedSuccess) return Promise.resolve(cachedSuccess);
  if (inFlight) return inFlight;

  inFlight = syncSchema()
    .then((result) => {
      if (result.ok) cachedSuccess = result;
      return result;
    })
    .catch(
      (error): SchemaSyncResult => ({
        ok: false,
        executed: 0,
        total: STEPS.length,
        warnings: [],
        error: messageOf(error),
        durationMs: 0,
      }),
    )
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export type RepairOutcome<T> =
  | { ok: true; value: T; schemaSynced: boolean }
  | { ok: false; error: unknown; repair?: SchemaSyncResult };

/**
 * Runs `operation`; if it fails because the schema is behind, repairs the
 * schema once and retries. Any other error is returned untouched.
 */
export async function runWithSchemaRepair<T>(operation: () => Promise<T>): Promise<RepairOutcome<T>> {
  try {
    return { ok: true, value: await operation(), schemaSynced: false };
  } catch (error) {
    if (!isSchemaMismatchError(error)) {
      return { ok: false, error };
    }

    const repair = await ensureSchemaOnce();
    if (!repair.ok) {
      return { ok: false, error, repair };
    }

    try {
      return { ok: true, value: await operation(), schemaSynced: true };
    } catch (retryError) {
      return { ok: false, error: retryError, repair };
    }
  }
}

/** Test/support hook: forget the cached successful run. */
export function resetSchemaSyncCache(): void {
  cachedSuccess = null;
  inFlight = null;
}
