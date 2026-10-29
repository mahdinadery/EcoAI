import { diagnoseDbError } from "./db-errors";
import type { SchemaSyncResult } from "./schema-sync";

/**
 * Standard JSON body for a failed admin DB operation. Always includes the real
 * (sanitized) cause plus flags the UI needs to offer a one-click schema repair.
 */
export function dbErrorResponse(
  error: unknown,
  message: string,
  repair?: SchemaSyncResult,
  extra?: Record<string, unknown>,
): Response {
  const diagnosis = diagnoseDbError(error);

  return Response.json(
    {
      success: false,
      message,
      detail: diagnosis.detail,
      hint: diagnosis.hint,
      code: diagnosis.code ?? null,
      schemaMismatch: diagnosis.schemaMismatch,
      schemaSync: repair
        ? {
            attempted: true,
            ok: repair.ok,
            executed: repair.executed,
            total: repair.total,
            error: repair.error ?? null,
            warnings: repair.warnings,
          }
        : { attempted: false },
      ...extra,
    },
    { status: diagnosis.status },
  );
}
