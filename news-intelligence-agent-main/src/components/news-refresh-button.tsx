"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Explicit, button-driven ingestion for the news page.
 * Reuses the same POST /api/news/fetch endpoint as the dashboard, then refreshes
 * the server-rendered list. Never runs automatically.
 */
export function NewsRefreshButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    setNote(null);

    try {
      const response = await fetch("/api/news/fetch", { method: "POST" });
      const data = (await response.json()) as {
        success: boolean;
        stored?: number;
        fetched?: number;
        duplicates?: number;
        message?: string;
      };

      setNote(
        data.success
          ? `${data.stored ?? 0} خبر جدید ذخیره شد (${data.duplicates ?? 0} تکراری).`
          : (data.message ?? "دریافت اخبار ناموفق بود."),
      );
      router.refresh();
    } catch {
      setNote("دریافت اخبار ناموفق بود.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <button
        className="rounded-2xl bg-accent px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-faint"
        disabled={busy}
        onClick={handleClick}
        type="button"
      >
        {busy ? "در حال دریافت..." : "دریافت اخبار"}
      </button>
      {note ? <p className="text-xs text-muted">{note}</p> : null}
    </div>
  );
}
