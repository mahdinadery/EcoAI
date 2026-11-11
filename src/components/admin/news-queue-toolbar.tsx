"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type QueueToolbarProps = {
  adminKey?: string;
  readyCount: number;
  readyToSendCount?: number;
  failedCount: number;
  topicFilterActive: boolean;
};

type QueueActionResponse = {
  success: boolean;
  analyzed?: number;
  failed?: number;
  skippedOfftopic?: number;
  autoSent?: number;
  restoredCount?: number;
  sweptOfftopic?: number;
  requeued?: number;
  remainingReady?: number;
  remainingReadyToSend?: number;
  firstError?: string | null;
  message?: string;
  detail?: string;
};

export function NewsQueueToolbar({
  adminKey = "",
  readyCount,
  readyToSendCount = 0,
  failedCount,
  topicFilterActive,
}: QueueToolbarProps) {
  const router = useRouter();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [autoDraining, setAutoDraining] = useState(false);
  const stopRef = useRef(false);
  const [liveReadyOverride, setLiveReadyOverride] = useState<number | null>(null);
  const [liveSendOverride, setLiveSendOverride] = useState<number | null>(null);
  const [banner, setBanner] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);
  const displayedReady = liveReadyOverride ?? readyCount;
  const displayedReadyToSend = liveSendOverride ?? readyToSendCount;

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
      if (action === "send_ready_to_bale") {
        let totalSent = 0;
        let lastMsg = "";
        for (let pass = 1; pass <= 20; pass += 1) {
          const data = await callQueueApi({ action: "send_ready_to_bale", limit: 20 });
          if (!data.success) {
            setBanner({
              tone: "err",
              text: `${data.message ?? `اجرای «${label}» ناموفق بود.`}${data.detail ? ` (${data.detail})` : ""}`,
            });
            return;
          }
          totalSent += data.autoSent ?? 0;
          lastMsg = data.message ?? "";
          if (typeof data.remainingReadyToSend === "number") {
            setLiveSendOverride(data.remainingReadyToSend);
          }
          if (data.firstError && (data.autoSent ?? 0) === 0) {
            setBanner({ tone: "err", text: lastMsg || data.firstError });
            return;
          }
          if ((data.autoSent ?? 0) === 0) break;
          setBanner({
            tone: "ok",
            text: `در حال ارسال پیوسته به کانال بله… تا این لحظه ${totalSent} مقالهٔ مرتبط و بااهمیت ارسال شد.`,
          });
        }
        setBanner({
          tone: "ok",
          text:
            totalSent > 0
              ? `تمام مقالات مرتبط و بااهمیت ارسال شدند ✓ (مجموعاً ${totalSent} مقاله به کانال بله ارسال شد).`
              : (lastMsg || "مقالهٔ ارسال‌نشدهٔ واجد شرایطی باقی نمانده است."),
        });
        router.refresh();
        return;
      }

      const data = await callQueueApi({ action, ...payload });
      if (!data.success) {
        setBanner({
          tone: "err",
          text: `${data.message ?? `اجرای «${label}» ناموفق بود.`}${data.detail ? ` (${data.detail})` : ""}`,
        });
        return;
      }
      if (typeof data.remainingReady === "number") {
        setLiveReadyOverride(data.remainingReady);
      }
      if (typeof data.remainingReadyToSend === "number") {
        setLiveSendOverride(data.remainingReadyToSend);
      }
      const hasWarn = Boolean(data.firstError) && (data.autoSent ?? 0) === 0;
      setBanner({
        tone: hasWarn ? "warn" : "ok",
        text: data.message ?? "انجام شد.",
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
    const startedMs = Date.now();
    setBanner({
      tone: "ok",
      text: "پردازش صف به ترتیب ورود آغاز شد؛ هر مقاله پس از تحلیل و در صورت واجد شرایط بودن، ارسال می‌شود…",
    });

    let totalAnalyzed = 0;
    let totalSent = 0;
    let totalSkipped = 0;

    try {
      for (let pass = 1; pass <= 60; pass += 1) {
        if (stopRef.current) break;

        const data = await callQueueApi({ action: "analyze_batch", limit: 15 });
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
        setLiveReadyOverride(rem);

        if (data.firstError && (data.analyzed ?? 0) === 0) {
          setBanner({
            tone: "err",
            text: `توقف پس از ${totalAnalyzed} تحلیل: ${data.firstError}`,
          });
          break;
        }

        const elapsedMin = Math.max(0.1, (Date.now() - startedMs) / 60_000);
        const ratePerMin = Math.round(totalAnalyzed / elapsedMin);

        setBanner({
          tone: data.firstError && totalSent === 0 ? "warn" : "ok",
          text: `در حال ورود سریع به فرآیند… تا این لحظه ${totalAnalyzed} مقاله تحلیل شد (~${ratePerMin} مقاله/دقیقه)، ${totalSent} ارسال به بله${totalSkipped > 0 ? `، ${totalSkipped} خارج از موضوع` : ""} — باقی‌مانده در صف: ${rem}${data.message ? ` | آخرین دسته: ${data.message}` : ""}`,
        });
        router.refresh();

        if (rem <= 0 || ((data.analyzed ?? 0) === 0 && (data.skippedOfftopic ?? 0) === 0)) {
          setBanner({
            tone: "ok",
            text: `پردازش کل مقالات صف تکمیل شد ✓ (${totalAnalyzed} مقاله تحلیل شد، ${totalSent} مقاله به بله ارسال شد).`,
          });
          break;
        }
      }
    } catch {
      setBanner({
        tone: "warn",
        text: `ارتباط موقتاً قطع شد (${totalAnalyzed} مقاله تا این لحظه تحلیل شد). با یک کلیک می‌توانید از ادامهٔ صف شروع کنید.`,
      });
    } finally {
      setAutoDraining(false);
      router.refresh();
    }
  }

  if (readyCount === 0 && readyToSendCount === 0 && failedCount === 0 && !banner) {
    return null;
  }

  return (
    <section className="mt-5 rounded-2xl border border-accent/60 bg-surface p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-sm font-bold text-ink">
            شتاب‌دهندهٔ ورود و ارسال مقالات ({displayedReady.toLocaleString("fa-IR")} آماده تحلیل ·{" "}
            {displayedReadyToSend.toLocaleString("fa-IR")} آماده ارسال)
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            مقالات بدون محدودیت تاریخ، به ترتیب ورود تحلیل و در صورت واجد شرایط بودن ارسال می‌شوند. در صورت خطا، صف منتظر تلاش مجدد مقالهٔ قبلی می‌ماند.
            {!topicFilterActive
              ? " پیشنهاد می‌شود «فیلتر موضوعی اقتصاد AI» را فعال کنید تا فقط مقالات مرتبط تحلیل شوند."
              : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded-xl border border-ok-line bg-ok-soft px-3.5 py-2 text-xs font-bold text-ok-ink shadow-sm transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={Boolean(busyAction) || autoDraining}
            onClick={() => handleSingleAction("send_ready_to_bale", { limit: 15 }, "ارسال به بله")}
            type="button"
          >
            {busyAction === "send_ready_to_bale"
              ? "در حال ارسال به بله…"
              : `ارسال همهٔ مقالات مرتبط و بااهمیت به بله${displayedReadyToSend > 0 ? ` (${displayedReadyToSend}+)` : ""}`}
          </button>

          <button
            className={`rounded-xl px-3.5 py-2 text-xs font-bold transition-colors ${
              autoDraining
                ? "border border-danger-line bg-danger-soft text-danger-ink"
                : "bg-accent text-white shadow-sm hover:bg-accent-strong"
            } disabled:cursor-not-allowed disabled:opacity-60`}
            disabled={Boolean(busyAction)}
            onClick={handleAutoDrain}
            type="button"
          >
            {autoDraining ? "توقف پردازش صف" : "پردازش پیوستهٔ صف به ترتیب ورود"}
          </button>

          <button
            className="rounded-xl border border-accent bg-accent-soft px-3.5 py-2 text-xs font-bold text-accent-ink transition-colors hover:bg-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={Boolean(busyAction) || autoDraining}
            onClick={() => handleSingleAction("analyze_batch", { limit: 15 }, "تحلیل سریع ۱۵ مقاله")}
            type="button"
          >
            {busyAction === "analyze_batch" ? "در حال بررسی مقالات به ترتیب ورود…" : "تحلیل حداکثر ۱۵ مقالهٔ بعدی"}
          </button>

          <button
            className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs font-medium text-ink-soft transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={Boolean(busyAction) || autoDraining}
            onClick={() => handleSingleAction("apply_ai_pack_filter", {}, "فعال‌سازی فیلتر موضوعی اقتصاد AI")}
            type="button"
          >
            {busyAction === "apply_ai_pack_filter"
              ? "در حال بررسی موضوعی…"
              : "فیلتر موضوعی اقتصاد AI (حفظ همهٔ تاریخ‌ها)"}
          </button>

          {failedCount > 0 ? (
            <button
              className="rounded-xl border border-warn-line bg-warn-soft px-3 py-2 text-xs font-medium text-warn-ink transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={Boolean(busyAction) || autoDraining}
              onClick={() => handleSingleAction("retry_failed", {}, "بازگردانی همهٔ خطاها")}
              type="button"
            >
              {busyAction === "retry_failed" ? "در حال بازگردانی…" : "تلاش مجدد همهٔ مقالات خطادار"}
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
