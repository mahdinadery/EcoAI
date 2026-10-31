"use client";

import { useState } from "react";

type Props = {
  /** Headline shown to the operator. */
  title?: string;
  message: string;
  hint?: string | null;
  detail?: string | null;
  code?: string | null;
  /** Show the one-click repair button (only when the fix is a schema sync). */
  schemaMismatch?: boolean;
  adminKey?: string;
  /** Called after a successful repair; defaults to a full page reload. */
  onRepaired?: () => void;
};

type SyncResponse = {
  success?: boolean;
  message?: string;
  error?: string;
  hint?: string;
  executed?: number;
  total?: number;
  warnings?: string[];
};

function authHeaders(adminKey?: string): HeadersInit {
  return adminKey ? { "x-admin-key": adminKey } : {};
}

/**
 * Error panel for admin DB failures with a one-click, additive-only schema
 * repair (`POST /api/admin/db-ensure`). Used by the admin consoles and by the
 * server-rendered admin pages when their data load fails.
 */
export function SchemaRepairCard({
  title,
  message,
  hint,
  detail,
  code,
  schemaMismatch = false,
  adminKey,
  onRepaired,
}: Props) {
  const [state, setState] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [result, setResult] = useState<SyncResponse | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);

  async function handleRepair() {
    if (state === "running") return;
    setState("running");
    setTransportError(null);
    setResult(null);

    try {
      const response = await fetch("/api/admin/db-ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
        body: "{}",
      });
      const payload = (await response.json().catch(() => null)) as SyncResponse | null;

      if (!response.ok || !payload?.success) {
        setResult(payload);
        setState("failed");
        return;
      }

      setResult(payload);
      setState("done");
      if (onRepaired) onRepaired();
      else window.location.reload();
    } catch {
      setTransportError("ارتباط با سرور برقرار نشد.");
      setState("failed");
    }
  }

  const heading =
    title ?? (schemaMismatch ? "ساختار پایگاه داده با کد همگام نیست" : "بارگذاری از پایگاه داده ناموفق بود");

  return (
    <section
      aria-live="polite"
      className="rounded-2xl border border-danger-line bg-danger-soft/70 p-4 text-sm text-danger-ink shadow-sm sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface text-danger-ink ring-1 ring-danger-line">
          <svg aria-hidden="true" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path d="M12 3 2.7 19.2A1.8 1.8 0 0 0 4.3 22h15.4a1.8 1.8 0 0 0 1.6-2.8L12 3Z" strokeLinejoin="round" />
            <path d="M12 9v4.5M12 17h.01" strokeLinecap="round" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-bold">{heading}</h2>
          <p className="mt-1 leading-6">{message}</p>
          {hint ? <p className="mt-1 leading-6 text-danger-ink/90">{hint}</p> : null}
          {detail ? (
            <p className="mt-2 overflow-x-auto rounded-lg bg-surface/80 px-3 py-2 font-mono text-[11px] leading-5 text-danger-ink" dir="ltr">
              {detail}
            </p>
          ) : null}
          {code ? <p className="mt-1 text-[11px] text-danger-ink" dir="ltr">code: {code}</p> : null}

          {schemaMismatch ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                className="rounded-xl bg-danger px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-danger-strong disabled:cursor-not-allowed disabled:bg-danger-line"
                disabled={state === "running"}
                onClick={handleRepair}
                type="button"
              >
                {state === "running" ? "در حال همگام‌سازی…" : "همگام‌سازی خودکار اسکیما"}
              </button>
              <span className="text-[11px] leading-5 text-danger-ink/80">
                فقط جدول/ستون‌های جدید اضافه می‌شوند؛ هیچ داده‌ای حذف یا بازنویسی نمی‌شود.
              </span>
            </div>
          ) : null}

          {state === "done" ? (
            <p className="mt-3 rounded-lg border border-ok-line bg-ok-soft px-3 py-2 text-xs font-bold text-ok-ink">
              اسکیما همگام شد ({result?.executed ?? "?"}/{result?.total ?? "?"} دستور). داده‌ها در حال بارگذاری مجدد…
            </p>
          ) : null}

          {state === "failed" ? (
            <div className="mt-3 rounded-lg border border-danger-line bg-surface px-3 py-2 text-xs text-danger-ink">
              <p className="font-bold">{result?.message ?? transportError ?? "همگام‌سازی ناموفق بود."}</p>
              {result?.error ? (
                <p className="mt-1 break-words font-mono text-[11px]" dir="ltr">
                  {result.error}
                </p>
              ) : null}
              {result?.hint ? <p className="mt-1 leading-5">{result.hint}</p> : null}
            </div>
          ) : null}

          {state === "done" && result?.warnings && result.warnings.length > 0 ? (
            <ul className="mt-2 space-y-1 text-[11px] text-warn-ink">
              {result.warnings.slice(0, 5).map((warning, index) => (
                <li key={index}>• {warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}
