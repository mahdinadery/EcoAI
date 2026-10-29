"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Props = {
  deliveryId: string;
  status: string;
  destination: string;
  message: string;
  canRetry: boolean;
  adminKey: string;
};

/**
 * Human-driven publishing controls (Milestone 8).
 *
 * Nothing here runs automatically: approve/reject/edit are DB-only, and the
 * two send buttons are the only paths that call a provider — each requires an
 * explicit click. "Send to Bale" is offered only for a Bale candidate, so the
 * Local rehearsal path can never publish to the production channel by accident.
 */
export function DeliveryActions({ deliveryId, status, destination, message, canRetry, adminKey }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  // Set when the server refuses because this news already reached this
  // destination: the admin can still re-publish, but only explicitly.
  const [needsRepublish, setNeedsRepublish] = useState(false);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (adminKey) headers["x-admin-key"] = adminKey;

  const isOpen = status === "pending_approval" || status === "approved";

  async function action(name: string, path: string, body?: unknown, method = "POST") {
    if (busy) return;
    setBusy(name);
    setNote(null);
    try {
      const res = await fetch(path, { method, headers, body: body === undefined ? "{}" : JSON.stringify(body) });
      const data = (await res.json()) as { success: boolean; code?: string; message?: string; detail?: string | null };
      setNeedsRepublish(!data.success && data.code === "already_delivered");
      setNote({
        kind: data.success ? "ok" : "err",
        text: data.success ? (data.message ?? "انجام شد.") : `${data.message ?? "ناموفق بود."}${data.detail ? ` — ${data.detail}` : ""}`,
      });
    } catch {
      setNote({ kind: "err", text: "ارتباط با سرور برقرار نشد." });
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  return (
    <div className="space-y-4 rounded-2xl border border-line/80 bg-surface p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-ink">کنترل انتشار</h2>
        <span className="rounded-full bg-surface-3 px-2.5 py-1 text-[11px] font-bold text-muted">
          وضعیت فعلی: {status}
        </span>
      </div>

      {status === "pending_approval" ? (
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-xl bg-ok px-4 py-2.5 text-sm font-bold text-white hover:bg-ok-strong disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => action("approve", `/api/admin/deliveries/${deliveryId}/approve`)}
            type="button"
          >
            {busy === "approve" ? "..." : "تأیید"}
          </button>
          <button
            className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-muted hover:bg-surface-2 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => action("reject", `/api/admin/deliveries/${deliveryId}/reject`, { reason: "رد توسط مدیر" })}
            type="button"
          >
            {busy === "reject" ? "..." : "رد"}
          </button>
          <button
            className="rounded-xl border border-brand-line bg-brand-soft px-4 py-2.5 text-sm font-bold text-brand-ink hover:bg-brand-soft disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => setOverrideOpen((v) => !v)}
            type="button"
          >
            تأیید دستی برخلاف نظر AI
          </button>
        </div>
      ) : null}

      {overrideOpen && status === "pending_approval" ? (
        <div className="rounded-xl border border-brand-line bg-brand-soft/50 p-3">
          <p className="text-xs font-bold text-brand-ink">
            نظر هوش مصنوعی تغییر نمی‌کند؛ فقط یک override روی همین رکورد ارسال ثبت می‌شود (به‌همراه دلیل، در تاریخچه).
          </p>
          <input
            className="mt-2 w-full rounded-lg border border-brand-line bg-surface px-3 py-2 text-sm"
            onChange={(e) => setOverrideReason(e.target.value)}
            placeholder="دلیل override (الزامی)"
            value={overrideReason}
          />
          <button
            className="mt-2 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white hover:bg-brand-strong disabled:opacity-50"
            disabled={busy !== null || !overrideReason.trim()}
            onClick={() =>
              action("override", `/api/admin/deliveries/${deliveryId}/approve`, { force: true, reason: overrideReason.trim() })
            }
            type="button"
          >
            {busy === "override" ? "..." : "ثبت اختلاف‌نظر و تأیید"}
          </button>
        </div>
      ) : null}

      {status === "approved" ? (
        <div className="flex flex-wrap items-center gap-2">
          {destination === "bale" ? (
            <button
              className="rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-white hover:bg-accent-strong disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => action("send", `/api/admin/deliveries/${deliveryId}/send`)}
              type="button"
            >
              {busy === "send" ? "در حال ارسال..." : "ارسال به بله"}
            </button>
          ) : (
            <button
              className="rounded-xl bg-ink px-4 py-2.5 text-sm font-bold text-on-ink hover:bg-ink/90 disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => action("send", `/api/admin/deliveries/${deliveryId}/send`)}
              type="button"
            >
              {busy === "send" ? "..." : "ارسال به Local (آزمایش)"}
            </button>
          )}
          <button
            className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-muted hover:bg-surface-2 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => action("cancel", `/api/admin/deliveries/${deliveryId}/cancel`)}
            type="button"
          >
            لغو
          </button>
          <span className="text-[11px] text-faint">
            ارسال اتمی است: دو کلیک هم‌زمان فقط یک پیام می‌سازد.
          </span>
        </div>
      ) : null}

      {needsRepublish && status === "approved" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warn-line bg-warn-soft px-3 py-2">
          <span className="text-xs font-bold text-warn-ink">
            این خبر قبلاً به همین مقصد ارسال شده است؛ برای جلوگیری از تکرار، ارسال مسدود شد.
          </span>
          <button
            className="rounded-lg bg-warn px-3 py-1.5 text-xs font-bold text-white hover:bg-warn-strong disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => action("force", `/api/admin/deliveries/${deliveryId}/send`, { force: true })}
            type="button"
          >
            {busy === "force" ? "..." : "ارسال مجدد (اجباری — در تاریخچه ثبت می‌شود)"}
          </button>
        </div>
      ) : null}

      {status === "failed" && canRetry ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded-xl bg-warn px-4 py-2.5 text-sm font-bold text-white hover:bg-warn-strong disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => action("retry", `/api/admin/deliveries/${deliveryId}/retry`)}
            type="button"
          >
            {busy === "retry" ? "..." : "تلاش مجدد (با همان متن)"}
          </button>
          <span className="text-[11px] text-faint">اگر رکورد قبلاً ارسال شده باشد، تلاش مجدد از سمت سرور رد می‌شود.</span>
        </div>
      ) : null}

      {status === "sending" ? (
        <p className="rounded-xl border border-warn-line bg-warn-soft px-3 py-2 text-xs text-warn-ink">
          یک درخواست ارسال روی این رکورد در جریان است. برای دیدن نتیجه، صفحه را تازه کنید.
        </p>
      ) : null}

      {isOpen ? (
        <div className="border-t border-line-soft pt-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold text-muted">متن پیام نهایی</p>
            <button
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2"
              onClick={() => setEditing((v) => !v)}
              type="button"
            >
              {editing ? "بستن ویرایش" : "ویرایش متن"}
            </button>
          </div>
          {editing ? (
            <>
              <textarea
                className="mt-2 w-full resize-y rounded-xl border border-line p-3 text-sm leading-6 focus:border-accent focus:outline-none"
                onChange={(e) => setDraft(e.target.value)}
                rows={12}
                value={draft}
              />
              <div className="mt-2 flex items-center gap-3">
                <button
                  className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-strong disabled:opacity-50"
                  disabled={busy !== null || !draft.trim()}
                  onClick={() => action("edit", `/api/admin/deliveries/${deliveryId}/message`, { message: draft }, "PATCH")}
                  type="button"
                >
                  {busy === "edit" ? "..." : "ذخیره متن"}
                </button>
                <span className="text-[11px] text-faint">ویرایش فقط همین رکورد را تغییر می‌دهد؛ خبر و تحلیل AI دست‌نخورده‌اند.</span>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {note ? (
        <p className={`rounded-xl border px-3 py-2 text-xs ${note.kind === "ok" ? "border-ok-line bg-ok-soft text-ok-ink" : "border-danger-line bg-danger-soft text-danger-ink"}`}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}
