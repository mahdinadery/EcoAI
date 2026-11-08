"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type QueueToolbarProps = {
  adminKey?: string;
  readyCount: number;
  failedCount: number;
  topicFilterActive: boolean;
};

type QueueActionResponse = {
  success: boolean;
  analyzed?: number;
  failed?: number;
  skippedOfftopic?: number;
  autoSent?: number;
  archived?: number;
  archivedStale?: number;
  sweptOfftopic?: number;
  requeued?: number;
  remainingReady?: number;
  firstError?: string | null;
  message?: string;
  detail?: string;
};

export function NewsQueueToolbar({
  adminKey = "",
  readyCount,
  failedCount,
  topicFilterActive,
}: QueueToolbarProps) {
  const router = useRouter();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [autoDraining, setAutoDraining] = useState(false);
  const stopRef = useRef(false);
  const [liveReady, setLiveReady] = useState(readyCount);
  const [banner, setBanner] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  function headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(adminKey ? { "x-admin-key": adminKey } : {}),
    };
  }

  async function callQueueApi(payload: Record<string, unknown>): Promise<QueueActionResponse> {
    const res = await fetch("/api/admin/news/queue", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
    });
    return (await res.json()) as QueueActionResponse;
  }

  async function handleSingleAction(action: string, payload: Record<string, unknown>, label: string) {
    if (busyAction || autoDraining) return;
    setBusyAction(action);
    setBanner(null);

    try {
      const data = await callQueueApi({ action, ...payload });
      if (!data.success) {
        setBanner({
          tone: "err",
          text: `${data.message ?? `اجرای «${label}» ناموفق بود.`}${data.detail ? ` (${data.detail})` : ""}`,
        });
        return;
      }
      if (typeof data.remainingReady === "number") {
        setLiveReady(data.remainingReady);
      }
      setBanner({
        tone: data.firstError ? "warn" : "ok",
        text: data.firstError ? `${data.message ?? ""} — خطا: ${data.firstError}` : (data.message ?? "انجام شد."),
      });
      router.refresh();
    } catch {
      setBanner({ tone: "err", text: "ارتباط با سرور هنگام پردازش صف قطع شد." });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleAutoDrain() {
    if (autoDraining) {
      stopRef.current = true;
      return;
    }
    if (busyAction) return;

    stopRef.current = false;
    setAutoDraining(true);
    setBanner({ tone: "ok", text: "پردازش پیوستهٔ صف تحلیل AI آغاز شد (دسته‌های ۵تایی)…" });

    let totalAnalyzed = 0;
    let totalSent = 0;
    let totalSkipped = 0;

    try {
      for (let pass = 1; pass <= 30; pass += 1) {
        if (stopRef.current) break;

        const data = await callQueueApi({ action: "analyze_batch", limit: 5 });
        if (!data.success) {
          setBanner({
            tone: "err",
            text: `${data.message ?? "خطا در تحلیل دسته‌ای"}${data.detail ? ` (${data.detail})` : ""}`,
          });
          break;
        }

        totalAnalyzed += data.analyzed ?? 0;
        totalSent += data.autoSent ?? 0;
        totalSkipped += data.skippedOfftopic ?? 0;
        const rem = data.remainingReady ?? 0;
        setLiveReady(rem);

        if (data.firstError && (data.analyzed ?? 0) === 0) {
          setBanner({
            tone: "err",
            text: `توقف به دلیل خطای سرویس هوش مصنوعی پس از ${totalAnalyzed} تحلیل: ${data.firstError}`,
          });
          break;
        }

        setBanner({
          tone: "ok",
          text: `در حال تخلیهٔ صف… تا این لحظه ${totalAnalyzed} خبر تحلیل شد${totalSent > 0 ? `، ${totalSent} ارسال خودکار` : ""}${totalSkipped > 0 ? `، ${totalSkipped} خارج از موضوع` : ""} — باقی‌مانده در صف: ${rem}`,
        });
        router.refresh();

        if (rem <= 0 || ((data.analyzed ?? 0) === 0 && (data.skippedOfftopic ?? 0) === 0)) {
          setBanner({
            tone: "ok",
            text: `پردازش صف تکمیل شد ✓ (${totalAnalyzed} خبر تحلیل شد${totalSent > 0 ? `، ${totalSent} ارسال خودکار` : ""}).`,
          });
          break;
        }
      }
    } catch {
      setBanner({
        tone: "warn",
        text: `ارتباط موقتاً قطع شد (${totalAnalyzed} خبر تا قبل از قطع تحلیل شد). می‌توانید دوباره ادامه دهید.`,
      });
    } finally {
      setAutoDraining(false);
      router.refresh();
    }
  }

  if (readyCount === 0 && failedCount === 0 && !banner) {
    return null;
  }

  return (
    <section className="mt-5 rounded-2xl border border-accent/60 bg-surface p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-sm font-bold text-ink">
            پردازش و پالایش صف تحلیل هوش مصنوعی ({liveReady.toLocaleString("fa-IR")} خبر در انتظار)
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            {!topicFilterActive
              ? "⚠️ فیلتر موضوعی «اقتصاد هوش مصنوعی» هنوز روی پیکربندی فعال روشن نیست؛ به همین دلیل همهٔ خبرهای عمومی و آرشیوی فیدها وارد صف آمادهٔ تحلیل شده‌اند. ابتدا دکمهٔ «پالایش هوشمند صف» را بزنید تا فقط خبرهای تازه و مرتبط باقی بمانند."
              : "برای جلوگیری از تایم‌اوت سرور و سقف توکن، خبرها به‌صورت دسته‌ای تحلیل می‌شوند. می‌توانید خبرهای آرشیوی قدیمی‌تر از ۷ روز را بایگانی کنید و بقیه را دسته‌ای تحلیل نمایید."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded-xl border border-accent bg-accent-soft px-3.5 py-2 text-xs font-bold text-accent-ink transition-colors hover:bg-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={Boolean(busyAction) || autoDraining}
            onClick={() => handleSingleAction("apply_ai_pack_filter", {}, "پالایش هوشمند صف")}
            type="button"
          >
            {busyAction === "apply_ai_pack_filter"
              ? "در حال پالایش صف…"
              : "۱. پالایش هوشمند صف (فیلتر اقتصاد AI + حذف آرشیو >۷ روز)"}
          </button>

          <button
            className="rounded-xl bg-accent px-3.5 py-2 text-xs font-bold text-white shadow-sm transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
            disabled={Boolean(busyAction) || autoDraining}
            onClick={() => handleSingleAction("analyze_batch", { limit: 6 }, "تحلیل دستهٔ بعدی")}
            type="button"
          >
            {busyAction === "analyze_batch" ? "در حال تحلیل ۶ خبر…" : "تحلیل ۶ خبر بعدی"}
          </button>

          <button
            className={`rounded-xl px-3.5 py-2 text-xs font-bold transition-colors ${
              autoDraining
                ? "border border-danger-line bg-danger-soft text-danger-ink"
                : "border border-ok-line bg-ok-soft text-ok-ink hover:opacity-90"
            } disabled:cursor-not-allowed disabled:opacity-60`}
            disabled={Boolean(busyAction)}
            onClick={handleAutoDrain}
            type="button"
          >
            {autoDraining ? "توقف پردازش پیوسته" : "پردازش پیوستهٔ خودکار صف"}
          </button>

          <button
            className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs font-medium text-ink-soft transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={Boolean(busyAction) || autoDraining}
            onClick={() => handleSingleAction("archive_stale", { days: 7 }, "بایگانی قدیمی‌ها")}
            type="button"
          >
            {busyAction === "archive_stale" ? "در حال بایگانی…" : "بایگانی قدیمی‌تر از ۷ روز"}
          </button>

          {failedCount > 0 ? (
            <button
              className="rounded-xl border border-warn-line bg-warn-soft px-3 py-2 text-xs font-medium text-warn-ink transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={Boolean(busyAction) || autoDraining}
              onClick={() => handleSingleAction("retry_failed", { days: 7 }, "بازگردانی خطادارها")}
              type="button"
            >
              {busyAction === "retry_failed" ? "در حال بازگردانی…" : "تلاش مجدد خطاهای ۷ روز اخیر"}
            </button>
          ) : null}
        </div>
      </div>

      {banner ? (
        <p
          className={`mt-3 rounded-xl border px-3.5 py-2.5 text-xs leading-6 ${
            banner.tone === "ok"
              ? "border-ok-line bg-ok-soft text-ok-ink"
              : banner.tone === "warn"
                ? "border-warn-line bg-warn-soft text-warn-ink"
                : "border-danger-line bg-danger-soft text-danger-ink"
          }`}
        >
          {banner.text}
        </p>
      ) : null}
    </section>
  );
}
