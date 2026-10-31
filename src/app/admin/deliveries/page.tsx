import Link from "next/link";
import type { ReactNode } from "react";
import { isNextProductionBuild } from "@/db";
import { AdminDbErrorPanel } from "@/components/admin/admin-db-error-panel";
import { AdminGateScreen } from "@/components/admin/admin-gate-screen";
import { AdminKeyQuerySync } from "@/components/admin/admin-key-query-sync";
import { adminKeyForClient, getAdminPageAccess } from "@/lib/admin/page-access";
import { runWithSchemaRepair } from "@/lib/admin/schema-sync";
import { listAdminDeliveries } from "@/lib/delivery/publishing";
import { publishStatusLabel, publishingStatusTone } from "@/lib/delivery/types";
import { Sidebar } from "@/components/sidebar";
import { StatusBadge, type StatusTone } from "@/components/status-badge";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "انتشار و ارسال‌ها | دستیار هوشمند اخبار",
  description: "تأیید انسانی، ویرایش پیام و ارسال کنترل‌شده به بله",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const STATUS_TABS = [
  { value: "", label: "همه" },
  { value: "pending_approval", label: "در انتظار تأیید" },
  { value: "approved", label: "تأییدشده" },
  { value: "sent", label: "ارسال‌شده" },
  { value: "failed", label: "ناموفق" },
  { value: "cancelled", label: "لغوشده" },
];

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.trim() ? raw.trim() : undefined;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
}

function buildQuery(overrides: Record<string, string | undefined>, base: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export default async function AdminDeliveriesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const base = {
    status: first(sp.status),
    destination: first(sp.destination),
    q: first(sp.q),
    key: first(sp.key),
  };

  if (isNextProductionBuild) {
    return (
      <Shell>
        <p className="text-sm text-faint">این صفحه در زمان اجرا پر می‌شود.</p>
      </Shell>
    );
  }

  // Gate before touching the database: an unauthorized visitor should get the
  // key popup, not admin data.
  const access = await getAdminPageAccess(first(sp.key));
  if (!access.authorized) {
    return <AdminGateScreen />;
  }

  const clientKey = adminKeyForClient(access);

  const outcome = await runWithSchemaRepair(() =>
    listAdminDeliveries({
      ...base,
      page: Number(first(sp.page) ?? 1) || 1,
    }),
  );

  if (!outcome.ok) {
    return (
      <Shell>
        <AdminDbErrorPanel
          adminKey={clientKey}
          error={outcome.error}
          message="بارگذاری فهرست ارسال‌ها از پایگاه داده ناموفق بود."
        />
      </Shell>
    );
  }

  const { rows, total, page, totalPages, stats } = outcome.value;

  return (
    <Shell>
      <AdminKeyQuerySync adminKey={clientKey} />
      <header className="border-b border-line/80 pb-6">
        <p className="mb-2 text-sm font-medium text-accent-ink">مرکز مدیریت اخبار</p>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">انتشار و ارسال‌ها</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
          هیچ خبری به‌صورت خودکار منتشر نمی‌شود. خبرهای «آماده ارسال» به صورت <b>نامزد</b> اینجا می‌آیند؛ باید تأیید
          (یا رد) شوند و سپس با کلیک شما به مقصد ارسال می‌شوند.
        </p>
      </header>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="در انتظار تأیید" value={stats.pendingApproval} tone="warning" />
        <StatCard label="تأییدشده (آماده ارسال)" value={stats.approved} tone="warning" />
        <StatCard label="ارسال‌شده امروز" value={stats.sentToday} tone="success" />
        <StatCard label="ناموفق" value={stats.failed} tone="danger" />
        <StatCard label="لغوشده" value={stats.cancelled} tone="muted" />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((tab) => {
          const active = (base.status ?? "") === tab.value;
          return (
            <Link
              className={`rounded-xl px-3.5 py-2 text-sm font-bold transition-colors ${
                active ? "bg-accent text-white" : "border border-line bg-surface text-muted hover:bg-surface-2"
              }`}
              href={`/admin/deliveries${buildQuery({ status: tab.value || undefined, page: undefined }, base)}`}
              key={tab.value || "all"}
            >
              {tab.label}
            </Link>
          );
        })}
        <span className="mx-2 h-6 w-px bg-track" />
        {(["bale", "local"] as const).map((destination) => {
          const active = base.destination === destination;
          return (
            <Link
              className={`rounded-xl px-3 py-2 text-xs font-bold ${
                active ? "bg-ink text-on-ink" : "border border-line bg-surface text-muted hover:bg-surface-2"
              }`}
              href={`/admin/deliveries${buildQuery({ destination, page: undefined }, base)}`}
              key={destination}
            >
              {destination === "bale" ? "مقصد: بله" : "مقصد: Local"}
            </Link>
          );
        })}
        {base.destination ? (
          <Link className="text-xs font-medium text-faint underline" href={`/admin/deliveries${buildQuery({ destination: undefined, page: undefined }, base)}`}>
            حذف فیلتر مقصد
          </Link>
        ) : null}
      </div>

      <div className="mt-5 overflow-x-auto rounded-2xl border border-line/80 bg-surface shadow-sm">
        <table className="w-full min-w-[1080px] text-right text-sm">
          <thead>
            <tr className="border-b border-line-soft text-xs text-muted">
              <th className="p-3 font-medium">خبر / منبع</th>
              <th className="p-3 font-medium">تصمیم AI</th>
              <th className="p-3 font-medium">اهمیت</th>
              <th className="p-3 font-medium">مرتبط / تازگی</th>
              <th className="p-3 font-medium">مقصد</th>
              <th className="p-3 font-medium">وضعیت ارسال</th>
              <th className="p-3 font-medium">ساخت / تأیید / ارسال</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="p-8 text-center text-sm text-faint" colSpan={7}>
                  رکوردی یافت نشد. خبرهای تحلیل‌شده با «پیشنهاد ارسال = بله» پس از تحلیل، به‌عنوان نامزد اینجا ظاهر می‌شوند.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr className="border-b border-line-soft align-top last:border-0 hover:bg-surface-2/50" key={row.id}>
                  <td className="max-w-[360px] p-3">
                    <Link className="font-bold text-ink hover:text-accent-ink hover:underline" href={`/admin/deliveries/${row.id}`}>
                      {row.newsTitle}
                    </Link>
                    <p className="mt-0.5 text-[11px] text-faint">{row.newsSource}</p>
                  </td>
                  <td className="p-3">
                    {row.shouldSend === true ? (
                      <span className="rounded-full bg-ok-soft px-2.5 py-1 text-xs font-bold text-ok-ink ring-1 ring-ok-line">
                        باید ارسال شود
                      </span>
                    ) : row.shouldSend === false ? (
                      <span className="rounded-full bg-surface-3 px-2.5 py-1 text-xs font-bold text-muted">توصیه نشده</span>
                    ) : (
                      <span className="text-xs text-faint">—</span>
                    )}
                  </td>
                  <td className="p-3 text-xs font-bold text-ink-soft">{row.importanceScore ?? "—"}</td>
                  <td className="p-3 text-xs text-muted">
                    {row.relevanceScore ?? "—"} / {row.noveltyScore ?? "—"}
                  </td>
                  <td className="p-3 text-xs font-bold text-ink-soft">{row.destination === "bale" ? "بله" : "Local"}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge tone={publishingStatusTone(row.status)}>{publishStatusLabel(row.status)}</StatusBadge>
                      {row.overrideRequested ? (
                        <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold text-brand-ink ring-1 ring-brand-line" title={row.overrideReason ?? undefined}>
                          override
                        </span>
                      ) : null}
                      {row.retryCount > 0 ? <span className="text-[10px] text-faint">تلاش: {row.retryCount}</span> : null}
                    </div>
                    {row.errorMessage ? <p className="mt-1 max-w-[260px] truncate text-[11px] text-danger-ink" title={row.errorMessage}>{row.errorMessage}</p> : null}
                  </td>
                  <td className="p-3 text-[11px] text-muted">
                    <p>ساخت: {formatTime(row.createdAt)}</p>
                    <p className="mt-0.5">تأیید: {formatTime(row.approvedAt)}</p>
                    <p className="mt-0.5">ارسال: {formatTime(row.sentAt)}</p>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-faint">
          نمایش {rows.length} از {total} رکورد — صفحه {page} از {totalPages}
        </p>
        <div className="flex gap-2">
          {page > 1 ? (
            <Link className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-bold text-muted hover:bg-surface-2" href={`/admin/deliveries${buildQuery({ page: String(page - 1) }, base)}`}>
              قبلی
            </Link>
          ) : null}
          {page < totalPages ? (
            <Link className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-bold text-muted hover:bg-surface-2" href={`/admin/deliveries${buildQuery({ page: String(page + 1) }, base)}`}>
              بعدی
            </Link>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div dir="rtl" className="min-h-screen bg-canvas-2 text-ink">
      <div className="lg:flex">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1480px] p-4 sm:p-6 lg:p-10">{children}</div>
        </main>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: StatusTone }) {
  const toneClass =
    tone === "success" ? "text-ok-ink" : tone === "warning" ? "text-warn-ink" : tone === "danger" ? "text-danger-ink" : "text-muted";
  return (
    <div className="rounded-2xl border border-line/80 bg-surface px-4 py-3 shadow-sm">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-xl font-bold ${toneClass}`}>{value}</p>
    </div>
  );
}
