"use client";

import { useCallback, useEffect, useState } from "react";

type OutboxStatus = "sent" | "failed" | "dry-run";

type OutboxEntry = {
  id: string;
  text: string;
  status: OutboxStatus;
  channel: string;
  trigger?: "auto" | "manual" | "test";
  createdAt: string;
  messageId: string | null;
  error: string | null;
};

const statusMeta: Record<OutboxStatus, { label: string; className: string }> = {
  sent: { label: "ارسال شد ✓", className: "bg-ok-soft text-ok-ink ring-ok-line" },
  failed: { label: "ارسال ناموفق", className: "bg-danger-soft text-danger-ink ring-danger-line" },
  "dry-run": { label: "ثبت آزمایشی", className: "bg-warn-soft text-warn-ink ring-warn-line" },
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("fa-IR");
}

export function BaleOutbox({ refreshKey }: { refreshKey?: number }) {
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    return fetch("/api/bale/outbox", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ entries?: OutboxEntry[] }>)
      .then((data) => {
        setEntries(data.entries ?? []);
      })
      .catch(() => {
        // keep current entries on transient network blip
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Auto-refresh every 30 seconds (was 5s — a needless constant load on the
  // server and database), and only while the tab is actually visible: a hidden
  // tab must not keep polling the API on a small VM.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) {
        timer = setInterval(() => {
          if (document.visibilityState === "visible") void load();
        }, 30_000);
      }
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      stop();
    };
  }, [load]);

  const autoCount = entries.filter((e) => e.trigger === "auto" && e.status === "sent").length;

  return (
    <section
      aria-labelledby="outbox-heading"
      className="mt-6 rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6"
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 id="outbox-heading" className="text-lg font-bold text-ink">
              صندوق خروجی پیام‌ها (Local Outbox)
            </h2>
            {autoCount > 0 ? (
              <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-bold text-brand-ink">
                {autoCount} پیام خودکار 🤖
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-faint">
            پیام‌های ارسال‌شده (هم به‌صورت خودکار توسط هوش مصنوعی و هم دستی) به‌طور دائمی در پایگاه داده ذخیره و در اینجا نمایش داده می‌شوند.
          </p>
        </div>
        <button
          className="rounded-lg border border-line px-3 py-2 text-xs font-medium text-muted transition-colors hover:bg-surface-2"
          onClick={() => void load()}
          type="button"
        >
          به‌روزرسانی فوری
        </button>
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-faint">در حال بارگذاری صندوق خروجی...</p>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-surface-2/70 px-5 py-10 text-center">
          <p className="text-sm font-medium text-muted">هنوز پیامی در صندوق خروجی ثبت نشده است.</p>
          <p className="mt-1 text-xs text-faint">
            با کلیک روی «تحلیل با AI» در صفحه اخبار یا «اجرای ارسال خودکار»، خبرهای واجد شرایط به اینجا ارسال می‌شوند.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => {
            const meta = statusMeta[entry.status] ?? statusMeta.sent;
            const isAuto = entry.trigger === "auto";

            return (
              <li
                className={`rounded-xl border p-4 transition-colors ${
                  isAuto
                    ? "border-brand-line/80 bg-brand-soft/20"
                    : "border-line/80 bg-surface-2/60"
                }`}
                key={entry.id}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ring-1 ring-inset ${meta.className}`}
                  >
                    {meta.label}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ring-1 ring-inset ${
                      isAuto
                        ? "bg-brand-soft text-brand-ink ring-brand-line"
                        : "bg-accent-soft text-accent-ink ring-accent-line"
                    }`}
                  >
                    {entry.channel}
                  </span>
                  <span className="ms-auto text-xs text-faint">{formatTime(entry.createdAt)}</span>
                </div>
                <div className="mt-3 whitespace-pre-line text-sm leading-6 text-ink-soft font-sans">
                  {entry.text}
                </div>
                {entry.error ? (
                  <p
                    className="mt-2 break-words rounded-lg bg-surface px-3 py-2 font-mono text-xs text-danger-ink ring-1 ring-danger-line"
                    dir="ltr"
                  >
                    {entry.error}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
