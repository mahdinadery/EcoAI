"use client";

import { useState } from "react";
import { StatusBadge } from "./status-badge";

type BaleTestStatus = "idle" | "sending" | "connected" | "dry" | "error";

type BaleTestResponse = {
  ok: boolean;
  dryRun?: boolean;
  mode?: string;
  messageId?: string | null;
  kind?: string;
  message?: string;
  detail?: string | null;
};

type BaleCheckStatus = "ok" | "warning" | "error" | "skipped";

type BaleDiagnosticsResponse = {
  success?: boolean;
  ready: boolean;
  checkedAt?: string;
  chatIdMasked?: string | null;
  deliveryMode?: string;
  checks: Array<{
    id: string;
    title: string;
    status: BaleCheckStatus;
    detail?: string;
    hint?: string;
  }>;
  message?: string;
};

const CHECK_LABELS: Record<BaleCheckStatus, string> = {
  ok: "سالم",
  warning: "هشدار",
  error: "مشکل",
  skipped: "بررسی نشد",
};

const CHECK_TONES: Record<BaleCheckStatus, string> = {
  ok: "bg-ok-soft text-ok-ink ring-ok-line",
  warning: "bg-warn-soft text-warn-ink ring-warn-line",
  error: "bg-danger-soft text-danger-ink ring-danger-line",
  skipped: "bg-surface-3 text-muted ring-line",
};

const statusLabel: Record<BaleTestStatus, string> = {
  idle: "بررسی نشده",
  sending: "در حال بررسی...",
  connected: "متصل",
  dry: "ثبت شد (آزمایشی)",
  error: "خطا در اتصال",
};

const statusTone = {
  idle: "muted",
  sending: "warning",
  connected: "success",
  dry: "warning",
  error: "danger",
} as const;

const buttonLabel: Record<BaleTestStatus, string> = {
  idle: "تست اتصال",
  sending: "در حال ارسال...",
  connected: "تست اتصال",
  dry: "تست اتصال",
  error: "تست مجدد",
};

const configHint: Record<string, string> = {
  missing_token: "متغیر محیطی BALE_BOT_TOKEN تنظیم نشده است.",
  missing_chat_id: "متغیر محیطی BALE_CHAT_ID تنظیم نشده است.",
  network_error: "سرور به tapi.bale.ai دسترسی ندارد. پیام در صندوق خروجی ثبت شد.",
  timeout: "پاسخ بله به‌موقع نرسید. پیام در صندوق خروجی ثبت شد.",
};

type BaleTestCardProps = {
  onTestComplete?: () => void;
  adminKey?: string;
};

export function BaleTestCard({ onTestComplete, adminKey = "" }: BaleTestCardProps) {
  const [status, setStatus] = useState<BaleTestStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<BaleDiagnosticsResponse | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  async function handleTest() {
    if (status === "sending") return;

    setStatus("sending");
    setMessage(null);
    setDetail(null);

    try {
      const response = await fetch("/api/bale/test", { method: "POST" });

      let data: BaleTestResponse | null = null;
      try {
        data = (await response.json()) as BaleTestResponse;
      } catch {
        data = null;
      }

      if (data?.ok && data.dryRun) {
        setStatus("dry");
        setMessage("پیام در صندوق خروجی آزمایشی ثبت شد (به بله ارسال نشد).");
        onTestComplete?.();
        return;
      }

      if (data?.ok) {
        setStatus("connected");
        setMessage("پیام با موفقیت به بله ارسال شد.");
        onTestComplete?.();
        return;
      }

      const kind = data?.kind ?? "unknown_error";
      setStatus("error");
      setMessage("ارسال پیام ناموفق بود.");
      setDetail(configHint[kind] ?? data?.message ?? `پاسخ نامعتبر از سرور (HTTP ${response.status}).`);
      onTestComplete?.();
    } catch {
      setStatus("error");
      setMessage("ارسال پیام ناموفق بود.");
      setDetail("ارتباط با سرور برقرار نشد.");
      onTestComplete?.();
    }
  }

  async function handleDiagnostics() {
    if (diagnosing) return;

    setDiagnosing(true);
    setDiagnosticsError(null);

    try {
      const response = await fetch("/api/bale/diagnostics", {
        cache: "no-store",
        headers: adminKey ? { "x-admin-key": adminKey } : undefined,
      });

      let data: BaleDiagnosticsResponse | null = null;
      try {
        data = (await response.json()) as BaleDiagnosticsResponse;
      } catch {
        data = null;
      }

      if (!response.ok || !data?.success || !Array.isArray(data.checks) || data.checks.length === 0) {
        setDiagnostics(null);
        setDiagnosticsError(
          response.status === 401
            ? "برای بررسی کانال باید کلید مدیریتی وارد شده باشد (یک‌بار با ?key=... وارد شوید)."
            : data?.message ?? `بررسی کانال ناموفق بود (HTTP ${response.status}).`,
        );
        return;
      }

      setDiagnostics(data);
    } catch {
      setDiagnostics(null);
      setDiagnosticsError("ارتباط با سرور برقرار نشد.");
    } finally {
      setDiagnosing(false);
    }
  }

  return (
    <section
      aria-labelledby="bale-heading"
      className="mt-6 rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6"
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-surface-3 text-muted">
            <svg
              aria-hidden="true"
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
            >
              <path
                d="M5 4.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 4v-4H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M7 9h10M7 13h6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <h2 id="bale-heading" className="text-base font-bold text-ink">
              اتصال به بله
            </h2>
            <p className="mt-1 text-sm text-muted">ارسال پیام آزمایشی و بررسی دسترسی ربات به کانال</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted">وضعیت بله:</span>
          <StatusBadge tone={statusTone[status]}>{statusLabel[status]}</StatusBadge>
          <button
            className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink-soft transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-faint"
            disabled={diagnosing}
            onClick={handleDiagnostics}
            type="button"
          >
            {diagnosing ? "در حال بررسی…" : "بررسی کانال"}
          </button>
          <button
            className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${
              status === "sending"
                ? "cursor-not-allowed bg-surface-3 text-faint"
                : "bg-accent text-white hover:bg-accent-strong"
            }`}
            disabled={status === "sending"}
            onClick={handleTest}
            type="button"
          >
            {buttonLabel[status]}
          </button>
        </div>
      </div>

      <div aria-live="polite" className="mt-5 border-t border-line-soft pt-4">
        {message ? (
          <p
            className={`text-sm font-medium ${
              status === "connected"
                ? "text-ok-ink"
                : status === "error"
                  ? "text-danger-ink"
                  : "text-warn-ink"
            }`}
          >
            {message}
          </p>
        ) : (
          <p className="text-xs text-faint">
            با کلیک روی «تست اتصال»، یک پیام آزمایشی ثبت می‌شود و نتیجهٔ آن در صندوق خروجی نمایش داده
            می‌شود.
          </p>
        )}

        {detail ? (
          <p
            className="mt-2 break-words rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-muted"
            dir="ltr"
          >
            {detail}
          </p>
        ) : null}
      </div>

      {diagnosticsError ? (
        <p className="mt-4 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-xs leading-6 text-danger-ink">
          {diagnosticsError}
        </p>
      ) : null}

      {diagnostics ? (
        <div className="mt-4 rounded-xl border border-line bg-surface-2/70 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-ink-soft">نتیجهٔ بررسی کانال</p>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ring-inset ${
                diagnostics.ready
                  ? "bg-ok-soft text-ok-ink ring-ok-line"
                  : "bg-danger-soft text-danger-ink ring-danger-line"
              }`}
            >
              {diagnostics.ready ? "آمادهٔ ارسال" : "نیاز به اصلاح"}
            </span>
          </div>

          <ul className="mt-3 space-y-2">
            {diagnostics.checks.map((check) => (
              <li className="rounded-lg border border-line bg-surface px-3 py-2" key={check.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-ink-soft">{check.title}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ring-inset ${CHECK_TONES[check.status]}`}
                  >
                    {CHECK_LABELS[check.status]}
                  </span>
                </div>
                {check.detail ? (
                  <p className="mt-1 break-words text-[11px] leading-5 text-muted">{check.detail}</p>
                ) : null}
                {check.hint ? (
                  <p className="mt-1 text-[11px] leading-5 text-warn-ink">راهکار: {check.hint}</p>
                ) : null}
              </li>
            ))}
          </ul>

          <p className="mt-3 text-[11px] leading-5 text-faint">
            این بررسی پیامی ارسال نمی‌کند؛ برای تأیید نهایی «تست اتصال» را بزنید.
            {diagnostics.chatIdMasked ? ` مقصد: ${diagnostics.chatIdMasked}` : ""}
          </p>
        </div>
      ) : null}
    </section>
  );
}
