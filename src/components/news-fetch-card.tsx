"use client";

import { useCallback, useEffect, useState } from "react";

type NewsStats = {
  success: boolean;
  totalStored: number;
  lastFetchCount: number;
  lastFetchedAt: string | null;
  sources: number;
  feedConfigured: boolean;
  message?: string;
};

type FetchResponse = {
  success: boolean;
  source?: string;
  fetched?: number;
  stored?: number;
  duplicates?: number;
  skipped?: number;
  code?: string;
  message?: string;
  detail?: string | null;
  autoSend?: {
    attempted: boolean;
    enabled: boolean;
    sent: number;
    skippedDuplicates: number;
    failed: number;
  };
};

const failureHint: Record<string, string> = {
  missing_url: "متغیر محیطی NEWS_SOURCE_RSS_URL تنظیم نشده است.",
  invalid_url: "NEWS_SOURCE_RSS_URL یک آدرس http(s) معتبر نیست.",
  timeout: "سرعت پاسخ منبع خبری کمتر از حد مجاز بود (۱۵ ثانیه).",
  network_error: "سرور نتوانست به منبع خبری دسترسی پیدا کند.",
  http_error: "منبع خبری خطای HTTP برگرداند.",
  invalid_feed: "پاسخ دریافتی ساختار RSS/Atom ندارد.",
  no_items: "هیچ خبر قابل‌استفاده‌ای در فید وجود نداشت.",
  db_error: "ذخیره‌سازی اخبار در پایگاه داده ناموفق بود.",
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export function NewsFetchCard({
  onIngestComplete,
  adminKey = "",
}: {
  onIngestComplete?: () => void;
  /** Forwarded as x-admin-key so the dashboard works when ADMIN_ACCESS_KEY is set. */
  adminKey?: string;
}) {
  const [stats, setStats] = useState<NewsStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; text: string; detail?: string | null } | null>(
    null,
  );

  const loadStats = useCallback(() => {
    return fetch("/api/news/stats", { cache: "no-store" })
      .then((response) => response.json() as Promise<NewsStats>)
      .then((data) => {
        setStats(data);
      })
      .catch(() => {
        setStats(null);
      })
      .finally(() => {
        setLoadingStats(false);
      });
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  async function handleFetch() {
    if (isFetching) return;

    setIsFetching(true);
    setResult(null);

    try {
      const response = await fetch("/api/news/fetch", {
        method: "POST",
        headers: adminKey ? { "x-admin-key": adminKey } : undefined,
      });
      const data = (await response.json()) as FetchResponse;

      if (data.success) {
        const auto = data.autoSend;
        const autoText =
          auto && auto.attempted && auto.enabled
            ? ` | ارسال خودکار: ${auto.sent} ارسال شد، ${auto.skippedDuplicates} تکراری، ${auto.failed} ناموفق`
            : "";

        setResult({
          kind: "success",
          text: "اخبار با موفقیت دریافت شد.",
          detail: `${data.stored ?? 0} خبر جدید از ${data.fetched ?? 0} خبر دریافت‌شده ذخیره شد (${
            data.duplicates ?? 0
          } تکراری).${autoText}`,
        });
      } else {
        setResult({
          kind: "error",
          text: "دریافت اخبار ناموفق بود.",
          detail: failureHint[data?.code ?? ""] ?? data.message ?? "پاسخ نامعتبر از سرور.",
        });
      }

      await loadStats();
      onIngestComplete?.();
    } catch {
      setResult({ kind: "error", text: "دریافت اخبار ناموفق بود.", detail: "ارتباط با سرور برقرار نشد." });
    } finally {
      setIsFetching(false);
    }
  }

  const total = stats?.totalStored ?? 0;
  const lastFetch = stats?.lastFetchCount ?? 0;

  return (
    <section
      aria-labelledby="news-fetch-heading"
      className="mt-6 rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6"
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-4">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink">
            <svg
              aria-hidden="true"
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3v10m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
              />
            </svg>
          </div>
          <div>
            <h2 id="news-fetch-heading" className="text-base font-bold text-ink">
              اخبار دریافت‌شده
            </h2>
            <p className="mt-1 text-sm text-muted">دریافت دستی اخبار از منبع RSS پیکربندی‌شده</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 lg:gap-4">
          <div className="rounded-xl border border-line px-4 py-2 text-center">
            <p className="text-xs text-muted">کل اخبار ذخیره‌شده</p>
            <p className="mt-1 text-lg font-bold text-ink">{loadingStats ? "…" : total}</p>
          </div>
          <div className="rounded-xl border border-line px-4 py-2 text-center">
            <p className="text-xs text-muted">اخبار آخرین دریافت</p>
            <p className="mt-1 text-lg font-bold text-ink">{loadingStats ? "…" : lastFetch}</p>
          </div>
          <button
            className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-faint"
            disabled={isFetching}
            onClick={handleFetch}
            type="button"
          >
            {isFetching ? "در حال دریافت..." : "دریافت اخبار"}
          </button>
        </div>
      </div>

      <div aria-live="polite" className="mt-5 border-t border-line-soft pt-4">
        {result ? (
          <p
            className={`text-sm font-medium ${
              result.kind === "success" ? "text-ok-ink" : "text-danger-ink"
            }`}
          >
            {result.text}
            {result.detail ? <span className="mt-1 block text-xs text-muted">{result.detail}</span> : null}
          </p>
        ) : (
          <p className="text-xs text-faint">
            دریافت خودکار فعال نیست؛ برای همگام‌سازی منبع روی «دریافت اخبار» بزنید.
          </p>
        )}

        {stats && stats.lastFetchedAt ? (
          <p className="mt-2 text-xs text-faint">آخرین دریافت: {formatDateTime(stats.lastFetchedAt)}</p>
        ) : null}

        {stats && stats.success && stats.totalStored > 0 ? (
          <a
            className="mt-3 inline-block text-sm font-medium text-accent-ink hover:underline"
            href="/news"
          >
            مشاهده فهرست اخبار
          </a>
        ) : null}
      </div>
    </section>
  );
}
