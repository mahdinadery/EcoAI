"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Props = {
  newsId: string;
  status: string;
  adminKey: string;
};

/**
 * Manual admin actions for one news item (Milestone 6).
 * Only: run/retry AI analysis and manual status transitions.
 * Explicitly NO send-to-Bale action here — delivery stays where it is today
 * and nothing in this milestone sends automatically.
 */
export function NewsAdminActions({ newsId, status, adminKey }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"analyze" | "ready" | "reprocess" | "candidate" | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (adminKey) headers["x-admin-key"] = adminKey;

  async function runAnalysis() {
    setBusy("analyze");
    setMessage(null);
    try {
      const res = await fetch(`/api/news/${newsId}/analyze`, { method: "POST", headers });
      const data = (await res.json()) as { success: boolean; message?: string };
      setMessage(
        data.success
          ? { kind: "ok", text: "تحلیل با موفقیت انجام و در تاریخچه ثبت شد." }
          : { kind: "err", text: data.message ?? "تحلیل news ناموفق بود (خطا در تاریخچه ثبت شد)." },
      );
    } catch {
      setMessage({ kind: "err", text: "ارتباط با سرور برقرار نشد." });
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  async function setStatus(next: "READY_TO_SEND" | "READY_FOR_AI", key: "ready" | "reprocess") {
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/news/${newsId}/status`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: next }),
      });
      const data = (await res.json()) as { success: boolean; message?: string };
      setMessage(data.success ? { kind: "ok", text: "وضعیت خبر به‌روزرسانی شد." } : { kind: "err", text: data.message ?? "تغییر وضعیت ناموفق بود." });
    } catch {
      setMessage({ kind: "err", text: "ارتباط با سرور برقرار نشد." });
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  const isAnalyzed = status === "AI_ANALYZED" || status === "READY_TO_SEND" || status === "SENT";

  // Milestone 8: open a publishing candidate. Creates a DB row only — no send.
  async function createCandidate(destination: "bale" | "local") {
    if (busy) return;
    setBusy("candidate");
    setMessage(null);
    try {
      const res = await fetch("/api/admin/deliveries", {
        method: "POST",
        headers,
        body: JSON.stringify({ newsId, destination }),
      });
      const data = (await res.json()) as { success: boolean; message?: string };
      setMessage({
        kind: data.success ? "ok" : "err",
        text: data.success
          ? `${data.message ?? "نامزد ساخته شد."} — برای تأیید و ارسال به صفحه «انتشار و ارسال‌ها» بروید.`
          : (data.message ?? "ساخت نامزد ناموفق بود."),
      });
    } catch {
      setMessage({ kind: "err", text: "ارتباط با سرور برقرار نشد." });
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  return (
    <div className="rounded-2xl border border-line/80 bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
          disabled={busy !== null}
          onClick={runAnalysis}
          type="button"
        >
          {busy === "analyze" ? "در حال تحلیل..." : isAnalyzed ? "تحلیل مجدد با AI" : "اجرای تحلیل AI"}
        </button>

        {status === "FAILED" ? (
          <span className="rounded-lg bg-danger-soft px-3 py-1.5 text-xs font-bold text-danger-ink ring-1 ring-danger-line">
            تحلیل قبلی ناموفق بود — با همان دکمه بالا دوباره تلاش کنید
          </span>
        ) : null}

        {status !== "READY_TO_SEND" ? (
          <button
            className="rounded-xl border border-ok-line bg-ok-soft px-4 py-2.5 text-sm font-bold text-ok-ink hover:bg-ok-soft disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => setStatus("READY_TO_SEND", "ready")}
            type="button"
          >
            {busy === "ready" ? "..." : "علامت‌گذاری به‌عنوان پردازش‌شده"}
          </button>
        ) : (
          <button
            className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-medium text-muted hover:bg-surface-2 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => setStatus("READY_FOR_AI", "reprocess")}
            type="button"
          >
            {busy === "reprocess" ? "..." : "بازگردانی به صف تحلیل (Reprocess)"}
          </button>
        )}
      </div>

      {isAnalyzed ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
          <span className="text-xs font-bold text-muted">نامزد ارسال:</span>
          <button
            className="rounded-xl border border-accent-line bg-accent-soft px-4 py-2 text-sm font-bold text-accent-ink hover:bg-accent-soft disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => createCandidate("bale")}
            type="button"
          >
            {busy === "candidate" ? "..." : "ساخت نامزد برای بله"}
          </button>
          <button
            className="rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-muted hover:bg-surface-2 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => createCandidate("local")}
            type="button"
          >
            ساخت نامزد برای Local (آزمایش)
          </button>
        </div>
      ) : null}

      {message ? (
        <p className={`mt-3 rounded-lg border px-3 py-2 text-xs ${message.kind === "ok" ? "border-ok-line bg-ok-soft text-ok-ink" : "border-danger-line bg-danger-soft text-danger-ink"}`}>
          {message.text}
        </p>
      ) : null}

      <p className="mt-3 text-[11px] text-faint">
        این صفحه هرگز چیزی ارسال نمی‌کند. «ساخت نامزد» فقط یک رکورد در انتظار تأیید می‌سازد؛ ارسال واقعی بعد از تأیید
        انسانی و از صفحه «انتشار و ارسال‌ها» انجام می‌شود.
      </p>
    </div>
  );
}
