import Link from "next/link";
import type { ReactNode } from "react";
import { isNextProductionBuild } from "@/db";
import { AdminDbErrorPanel } from "@/components/admin/admin-db-error-panel";
import { AdminGateScreen } from "@/components/admin/admin-gate-screen";
import { AdminKeyQuerySync } from "@/components/admin/admin-key-query-sync";
import { adminKeyForClient, getAdminPageAccess } from "@/lib/admin/page-access";
import { runWithSchemaRepair } from "@/lib/admin/schema-sync";
import { getNewsStatusSummary, listAdminNews, listFilterOptions, type AdminNewsFilters } from "@/lib/news/news-admin";
import { NEWS_STATUSES, NEWS_STATUS_LABELS } from "@/lib/news/status";
import { Sidebar } from "@/components/sidebar";
import { StatusBadge } from "@/components/status-badge";
import { NewsStatusTones } from "@/components/admin/news-status-pill";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "مدیریت اخبار | دستیار هوشمند اخبار",
  description: "جست‌وجو، فیلتر و بررسی وضعیت چرخه حیات اخبار",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.trim() ? raw.trim() : undefined;
}

function formatShort(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
}

function buildQuery(filters: Record<string, string | undefined>, overrides: Record<string, string | undefined>): string {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export default async function AdminNewsPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const filters: AdminNewsFilters = {
    q: first(sp.q),
    sourceId: first(sp.source),
    category: first(sp.category),
    status: first(sp.status),
    ai: first(sp.ai) === "done" ? "done" : first(sp.ai) === "pending" ? "pending" : undefined,
    shouldSend: first(sp.send) === "yes" ? "yes" : first(sp.send) === "no" ? "no" : undefined,
    from: first(sp.from),
    to: first(sp.to),
    page: Number(first(sp.page) ?? 1) || 1,
  };

  // Admin pages are DB-backed like the public news page: skip DB during build.
  if (isNextProductionBuild) {
    return <PlaceholderShell />;
  }

  // Gate before touching the database: an unauthorized visitor should get the
  // key popup, not admin data.
  const access = await getAdminPageAccess(first(sp.key));
  if (!access.authorized) {
    return <AdminGateScreen />;
  }

  const clientKey = adminKeyForClient(access);

  const outcome = await runWithSchemaRepair(() =>
    Promise.all([listAdminNews(filters), getNewsStatusSummary(), listFilterOptions()]),
  );

  if (!outcome.ok) {
    return (
      <StatusShell>
        <AdminDbErrorPanel
          adminKey={clientKey}
          error={outcome.error}
          message="بارگذاری فهرست اخبار از پایگاه داده ناموفق بود."
        />
      </StatusShell>
    );
  }

  const [{ items, total, page, totalPages }, summary, options] = outcome.value;

  const rawFilters: Record<string, string | undefined> = {
    q: filters.q,
    source: filters.sourceId,
    category: filters.category,
    status: filters.status,
    ai: first(sp.ai),
    send: first(sp.send),
    from: filters.from,
    to: filters.to,
    key: first(sp.key),
  };

  return (
    <div dir="rtl" className="min-h-screen bg-canvas-2 text-ink">
      <div className="lg:flex">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1480px] p-4 sm:p-6 lg:p-10">
            <AdminKeyQuerySync adminKey={clientKey} />
            <header className="border-b border-line/80 pb-6">
              <p className="mb-2 text-sm font-medium text-accent-ink">مرکز مدیریت اخبار</p>
              <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">اخبار</h1>
              <p className="mt-2 text-sm text-muted">
                کل اخبار: <b className="text-ink-soft">{summary.total}</b>
              </p>
            </header>

            <div className="mt-5 flex flex-wrap gap-2">
              {NEWS_STATUSES.filter((s) => (summary.byStatus[s] ?? 0) > 0).map((status) => (
                <span key={status} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-bold text-muted shadow-sm">
                  {NEWS_STATUS_LABELS[status]}: {summary.byStatus[status]}
                </span>
              ))}
            </div>

            <form action="/admin/news" className="mt-5 grid gap-3 rounded-2xl border border-line/80 bg-surface p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4" method="GET">
              <FilterField label="جست‌وجو (عنوان / لینک)">
                <input className="admin-filter-input" defaultValue={filters.q} name="q" placeholder="عنوان، URL یا منبع…" />
              </FilterField>
              <FilterField label="منبع">
                <select className="admin-filter-input" defaultValue={filters.sourceId ?? ""} name="source">
                  <option value="">همه</option>
                  {options.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="دسته">
                <select className="admin-filter-input" defaultValue={filters.category ?? ""} name="category">
                  <option value="">همه</option>
                  {options.categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="وضعیت">
                <select className="admin-filter-input" defaultValue={filters.status ?? ""} name="status">
                  <option value="">همه (بدون تکراری‌ها)</option>
                  {NEWS_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {NEWS_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="وضعیت AI">
                <select className="admin-filter-input" defaultValue={first(sp.ai) ?? ""} name="ai">
                  <option value="">همه</option>
                  <option value="pending">تحلیل‌نشده</option>
                  <option value="done">تحلیل‌شده</option>
                </select>
              </FilterField>
              <FilterField label="پیشنهاد ارسال">
                <select className="admin-filter-input" defaultValue={first(sp.send) ?? ""} name="send">
                  <option value="">همه</option>
                  <option value="yes">بله</option>
                  <option value="no">خیر</option>
                </select>
              </FilterField>
              <FilterField label="از تاریخ">
                <input className="admin-filter-input" defaultValue={filters.from ?? ""} name="from" type="date" />
              </FilterField>
              <FilterField label="تا تاریخ">
                <input className="admin-filter-input" defaultValue={filters.to ?? ""} name="to" type="date" />
              </FilterField>
              {first(sp.key) ? <input name="key" type="hidden" value={first(sp.key)} /> : null}
              <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
                <button className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-strong" type="submit">
                  اعمال فیلترها
                </button>
                <Link className="rounded-xl border border-line px-4 py-2 text-sm font-medium text-muted hover:bg-surface-2" href="/admin/news">
                  پاک کردن
                </Link>
              </div>
            </form>

            <div className="mt-5 overflow-x-auto rounded-2xl border border-line/80 bg-surface shadow-sm">
              <table className="w-full min-w-[980px] text-right text-sm">
                <thead>
                  <tr className="border-b border-line-soft text-xs text-muted">
                    <th className="p-3 font-medium">عنوان</th>
                    <th className="p-3 font-medium">منبع</th>
                    <th className="p-3 font-medium">انتشار</th>
                    <th className="p-3 font-medium">دریافت</th>
                    <th className="p-3 font-medium">دسته</th>
                    <th className="p-3 font-medium">وضعیت</th>
                    <th className="p-3 font-medium">AI</th>
                    <th className="p-3 font-medium">ارسال؟</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td className="p-8 text-center text-sm text-faint" colSpan={8}>
                        خبری با این فیلترها یافت نشد.
                      </td>
                    </tr>
                  ) : (
                    items.map((row) => (
                      <tr className="border-b border-line-soft align-top last:border-0 hover:bg-surface-2/50" key={row.id}>
                        <td className="max-w-[380px] p-3">
                          <Link className="font-bold text-ink hover:text-accent-ink hover:underline" href={`/admin/news/${row.id}`}>
                            {row.title}
                          </Link>
                        </td>
                        <td className="p-3 text-xs text-muted">{row.source}</td>
                        <td className="p-3 text-xs text-muted">{formatShort(row.publishedAt)}</td>
                        <td className="p-3 text-xs text-muted">{formatShort(row.fetchedAt)}</td>
                        <td className="p-3 text-xs text-muted">{row.category ?? "—"}</td>
                        <td className="p-3">
                          <NewsStatusTones status={row.status} />
                        </td>
                        <td className="p-3">
                          <StatusBadge tone={row.analyzedAt ? "success" : "muted"}>{row.analyzedAt ? "تحلیل‌شده" : "بی‌تحلیل"}</StatusBadge>
                        </td>
                        <td className="p-3 text-xs">
                          {row.shouldSend === true ? (
                            <span className="font-bold text-ok-ink">بله ({row.importanceScore ?? "—"})</span>
                          ) : (
                            <span className="text-faint">خیر</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
              <p className="text-xs text-faint">
                نمایش {items.length} از {total} خبر — صفحه {page} از {totalPages}
              </p>
              <div className="flex gap-2">
                {page > 1 ? (
                  <Link
                    className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-bold text-muted hover:bg-surface-2"
                    href={`/admin/news${buildQuery(rawFilters, { page: String(page - 1) })}`}
                  >
                    قبلی
                  </Link>
                ) : null}
                {page < totalPages ? (
                  <Link
                    className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-bold text-muted hover:bg-surface-2"
                    href={`/admin/news${buildQuery(rawFilters, { page: String(page + 1) })}`}
                  >
                    بعدی
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function StatusShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas-2 text-ink" dir="rtl">
      <div className="lg:flex">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1480px] p-4 sm:p-6 lg:p-10">{children}</div>
        </main>
      </div>
    </div>
  );
}

function PlaceholderShell() {
  return (
    <div dir="rtl" className="min-h-screen bg-canvas-2 text-ink">
      <div className="lg:flex">
        <Sidebar />
        <main className="min-w-0 flex-1 p-10">
          <p className="text-sm text-faint">این صفحه هنگام build آماده‌سازی می‌شود و در زمان اجرا پر می‌گردد.</p>
        </main>
      </div>
    </div>
  );
}
