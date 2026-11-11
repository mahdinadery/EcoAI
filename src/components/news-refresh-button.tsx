"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Explicit, button-driven ingestion for the News Library (`/news` — کتابخانه اخبار).
 *
 * Runs in two decoupled stages so Render / reverse-proxy timeouts never swallow
 * newly fetched articles:
 *   1. Fast RSS ingestion (`ingestOnly: true`) -> immediately refreshes `/news`
 *      so new papers appear at the top of the library in seconds.
 *   2. Follow-up parallel AI analysis + Bale auto-send batch -> refreshes again
 *      as translations & summaries finish.
 */
export function NewsRefreshButton({ adminKey = "" }: { adminKey?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [phaseNote, setPhaseNote] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [unlockKey, setUnlockKey] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  async function runFetch(keyOverride?: string) {
    if (busy) return;
    setBusy(true);
    setPhaseNote({ tone: "ok", text: "در حال دریافت مقالات جدید از منابع فعال RSS…" });

    const effectiveKey = (keyOverride ?? adminKey).trim();
    const authHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(effectiveKey ? { "x-admin-key": effectiveKey } : {}),
    };

    try {
      const response = await fetch("/api/news/fetch", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ ingestOnly: true }),
      });

      if (response.status === 401) {
        setNeedsUnlock(true);
        setPhaseNote({
          tone: "warn",
          text: "برای دریافت مقالات جدید، کلید دسترسی مدیریتی (ADMIN_ACCESS_KEY) را وارد کنید.",
        });
        return;
      }

      const data = (await response.json()) as {
        success: boolean;
        stored?: number;
        fetched?: number;
        duplicates?: number;
        filtered?: number;
        message?: string;
      };

      if (!data.success) {
        setPhaseNote({
          tone: "err",
          text: data.message ?? "دریافت مقالات ناموفق بود.",
        });
        return;
      }

      setNeedsUnlock(false);
      const storedCount = data.stored ?? 0;
      const dupCount = data.duplicates ?? 0;
      setPhaseNote({
        tone: "ok",
        text: `${storedCount} مقالهٔ جدید به کتابخانه اضافه شد (${dupCount} تکراری از ${data.fetched ?? 0} آیتم بررسی‌شده). در حال ترجمه و تحلیل هوشمند…`,
      });
      // Immediately render all newly ingested papers at the top of `/news`!
      router.refresh();

      // Stage 2: non-blocking AI analysis + Bale auto-send batch
      try {
        const queueRes = await fetch("/api/admin/news/queue", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ action: "analyze_batch", limit: 12, concurrency: 4 }),
        });
        if (queueRes.ok) {
          const queueData = (await queueRes.json()) as {
            success?: boolean;
            analyzed?: number;
            autoSent?: number;
          };
          if (queueData.success) {
            const analyzed = queueData.analyzed ?? 0;
            const sent = queueData.autoSent ?? 0;
            setPhaseNote({
              tone: "ok",
              text: `${storedCount} مقالهٔ جدید دریافت شد (${dupCount} تکراری)${analyzed > 0 ? ` · ${analyzed} مقاله تحلیل شد` : ""}${sent > 0 ? ` · ${sent} مقاله به بله ارسال شد ✓` : ""}.`,
            });
            router.refresh();
            return;
          }
        }
      } catch {
        // Non-fatal: ingestion itself already succeeded and refreshed the list.
      }

      setPhaseNote({
        tone: "ok",
        text: `${storedCount} مقالهٔ جدید به کتابخانه اضافه شد (${dupCount} تکراری).`,
      });
    } catch {
      setPhaseNote({
        tone: "err",
        text: "دریافت مقالات با خطای شبکه/تایم‌اوت مواجه شد. دوباره تلاش کنید.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlockSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = unlockKey.trim();
    if (!trimmed || unlocking) return;
    setUnlocking(true);
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: trimmed }),
      });
      const payload = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !payload.success) {
        setPhaseNote({ tone: "err", text: payload.message ?? "کلید مدیریتی نامعتبر است." });
        return;
      }
      setNeedsUnlock(false);
      setUnlockKey("");
      await runFetch(trimmed);
    } catch {
      setPhaseNote({ tone: "err", text: "ارتباط با سرور برای تأیید کلید برقرار نشد." });
    } finally {
      setUnlocking(false);
    }
  }

  const toneClass =
    phaseNote?.tone === "err"
      ? "text-danger-ink"
      : phaseNote?.tone === "warn"
        ? "text-warn-ink"
        : "text-ok-ink";

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <button
        className="rounded-2xl bg-accent px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-faint"
        disabled={busy || unlocking}
        onClick={() => void runFetch()}
        type="button"
      >
        {busy ? "در حال دریافت و تحلیل…" : "دریافت مقالات جدید"}
      </button>

      {needsUnlock ? (
        <form className="mt-1 flex flex-wrap items-center gap-2" onSubmit={handleUnlockSubmit}>
          <input
            className="rounded-xl border border-line bg-surface px-3 py-1.5 text-xs text-ink"
            dir="ltr"
            onChange={(e) => setUnlockKey(e.target.value)}
            placeholder="ADMIN_ACCESS_KEY"
            type="password"
            value={unlockKey}
          />
          <button
            className="rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-strong disabled:opacity-50"
            disabled={unlocking || !unlockKey.trim()}
            type="submit"
          >
            {unlocking ? "بررسی…" : "تأیید و دریافت"}
          </button>
        </form>
      ) : null}

      {phaseNote ? <p className={`max-w-md text-xs font-medium ${toneClass}`}>{phaseNote.text}</p> : null}
    </div>
  );
}
