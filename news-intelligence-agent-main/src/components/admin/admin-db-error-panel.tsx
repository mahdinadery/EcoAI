import { diagnoseDbError } from "@/lib/admin/db-errors";
import { SchemaRepairCard } from "./schema-repair-card";

type Props = {
  error: unknown;
  /** User-facing description of what failed to load. */
  message: string;
  adminKey?: string;
};

/**
 * Server-side wrapper: turns a raw database error into the sanitized diagnosis
 * and renders the client repair card (with the one-click schema sync).
 */
export function AdminDbErrorPanel({ error, message, adminKey }: Props) {
  const diagnosis = diagnoseDbError(error);

  return (
    <SchemaRepairCard
      adminKey={adminKey}
      code={diagnosis.code}
      detail={diagnosis.detail}
      hint={diagnosis.hint}
      message={message}
      schemaMismatch={diagnosis.schemaMismatch}
      title={diagnosis.schemaMismatch ? "ساختار پایگاه داده با کد همگام نیست" : "بارگذاری از پایگاه داده ناموفق بود"}
    />
  );
}
