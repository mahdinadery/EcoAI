/**
 * DB/API error surfacing for admin routes — SERVER-SIDE ONLY.
 *
 * The admin consoles previously showed a generic Persian message for every
 * failure, which hid the real root cause (missing table after a schema drift,
 * wrong DATABASE_URL, unreachable Postgres, ...). This module classifies the
 * error into a SHORT, secret-free detail + an actionable hint so the dashboard
 * can tell the operator exactly what to fix.
 *
 * Drizzle wraps driver errors: the useful Postgres error (`relation "x" does
 * not exist`, code `42P01`) usually sits in `error.cause`, not in
 * `error.message` (which is only "Failed query: select ..."). That is why this
 * module walks the whole `cause` chain instead of reading the outer message.
 *
 * Never includes connection strings, credentials or SQL text with values — only
 * the driver's error message/code, truncated.
 */

export type DbErrorDiagnosis = {
  /** Short, sanitized technical detail (safe to show in the admin UI). */
  detail: string;
  /** Actionable Persian hint for the operator. */
  hint: string;
  /** 503 when the database itself is unreachable; 500 for query/schema errors. */
  status: 500 | 503;
  /** Postgres SQLSTATE (e.g. 42P01) or driver code (e.g. ECONNREFUSED), when known. */
  code?: string;
  /** True when the fix is an additive schema sync (missing table/column/function). */
  schemaMismatch: boolean;
};

/** SQLSTATE codes that mean "the database schema is older than the code". */
const SCHEMA_MISMATCH_CODES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "42883", // undefined_function
  "42P06", // duplicate_schema (harmless but schema-related)
  "42704", // undefined_object (missing type/constraint/index)
  "3F000", // invalid_schema_name
]);

const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "57P01",
  "57P02",
  "57P03",
]);

/** Walks `error.cause` (and nested causes) up to a few levels deep. */
function errorChain(error: unknown, maxDepth = 6): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current && depth < maxDepth) {
    chain.push(current);
    current = (current as { cause?: unknown } | null)?.cause;
    depth += 1;
  }
  return chain;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) {
    return String((value as { message?: unknown }).message ?? "");
  }
  return "";
}

/** Removes credentials from anything that might end up in the UI. */
function redact(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgresql://[REDACTED]");
}

function codeOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const code = (value as { code?: unknown }).code;
  if (typeof code === "string" && code.trim()) return code.trim();
  if (typeof code === "number") return String(code);
  return undefined;
}

/** All codes found in the cause chain, outermost first. */
export function errorCodes(error: unknown): string[] {
  return errorChain(error)
    .map((entry) => codeOf(entry))
    .filter((code): code is string => Boolean(code));
}

/** Root-cause-first message, e.g. `relation "ai_configurations" does not exist — Failed query: select ...`. */
function detailOf(error: unknown): string {
  const messages = errorChain(error)
    .map(messageOf)
    .map((message) => message.trim())
    .filter(Boolean)
    .map(redact)
    .map((message) => (message.length > 180 ? `${message.slice(0, 177)}…` : message));

  const unique = [...new Set(messages)].reverse(); // deepest (root cause) first
  const detail = unique.join(" — ");
  return (detail || "خطای ناشناخته پایگاه داده").slice(0, 500);
}

/**
 * True when the error means "the code expects tables/columns that this
 * database does not have yet" — i.e. `npm run db:ensure` (or the automatic
 * repair in src/lib/admin/schema-sync.ts) will fix it without data loss.
 */
export function isSchemaMismatchError(error: unknown): boolean {
  const codes = errorCodes(error);
  if (codes.some((code) => SCHEMA_MISMATCH_CODES.has(code))) return true;

  const chainText = errorChain(error)
    .map(messageOf)
    .join(" ")
    .toLowerCase();

  return (
    /relation .* does not exist/.test(chainText) ||
    /column .* does not exist/.test(chainText) ||
    /function .* does not exist/.test(chainText) ||
    /type .* does not exist/.test(chainText) ||
    chainText.includes("undefined table") ||
    chainText.includes("undefined column")
  );
}

export function diagnoseDbError(error: unknown): DbErrorDiagnosis {
  const detail = detailOf(error);
  const codes = errorCodes(error);
  const code = codes[0];
  const lower = detail.toLowerCase();
  const schemaMismatch = isSchemaMismatchError(error);

  if (!process.env.DATABASE_URL?.trim() || lower.includes("database_url is required")) {
    return {
      detail,
      hint: "متغیر محیطی DATABASE_URL تنظیم نشده است؛ آن را مطابق .env.example روی سرور تنظیم کنید.",
      status: 503,
      code,
      schemaMismatch: false,
    };
  }

  // DNS failures get their own hint: on Iran-hosted servers the foreign DB
  // hostname often cannot be resolved at all (getaddrinfo ENOTFOUND) while the
  // host itself is reachable by IP — the `hostaddr=` URL parameter bypasses DNS.
  if (
    codes.some((entry) => entry === "ENOTFOUND" || entry === "EAI_AGAIN") ||
    lower.includes("getaddrinfo") ||
    lower.includes("enotfound")
  ) {
    return {
      detail,
      hint:
        "نام میزبان پایگاه داده از این سرور قابل resolve نیست (خطای DNS — معمولاً روی سرورهای داخل ایران برای میزبان‌های خارجی). " +
        "راه‌حل: IP میزبان دیتابیس را (از بیرون از سرور، مثلاً با nslookup) پیدا کنید و پارامتر hostaddr را به DATABASE_URL اضافه کنید — " +
        "اتصال بدون DNS و با همان نام امن (TLS) برقرار می‌شود: " +
        "postgres://user:pass@HOST/db?sslmode=require&hostaddr=1.2.3.4 — " +
        "اگر IP در دسترس نبود، میزبان دیتابیس را به DNS در دسترس منتقل کنید.",
      status: 503,
      code,
      schemaMismatch: false,
    };
  }

  if (
    codes.some((entry) => entry.startsWith("ECONN") || CONNECTION_CODES.has(entry)) ||
    lower.includes("econnrefused") ||
    lower.includes("connection terminated") ||
    lower.includes("timeout exceeded") ||
    lower.includes("connect_timeout")
  ) {
    return {
      detail,
      hint: "اتصال به پایگاه داده برقرار نشد. DATABASE_URL و در دسترس بودن سرویس PostgreSQL را بررسی کنید.",
      status: 503,
      code,
      schemaMismatch: false,
    };
  }

  if (schemaMismatch) {
    return {
      detail,
      hint: "ساختار دیتابیس با کد هماهنگ نیست (جدول یا ستون مورد انتظار وجود ندارد). پنل مدیریت می‌تواند اسکیما را به‌صورت خودکار همگام‌سازی کند؛ یا دستور npm run db:ensure را روی دیتابیس اجرا کنید.",
      status: 500,
      code,
      schemaMismatch: true,
    };
  }

  return {
    detail,
    hint: "خطای غیرمنتظره پایگاه داده. جزئیات را بررسی کنید؛ در صورت نیاز npm run db:ensure را اجرا کنید.",
    status: 500,
    code,
    schemaMismatch: false,
  };
}
