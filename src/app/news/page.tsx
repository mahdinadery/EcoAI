import Link from "next/link";
import { isNextProductionBuild } from "@/db";
import { AdminKeyQuerySync } from "@/components/admin/admin-key-query-sync";
import { recoverStaleProcessing } from "@/lib/news/analysis-queue";
import {
  getNewsStats,
  listLibraryNews,
  type LibraryNewsFilters,
  type NewsListItem,
  type NewsStats,
} from "@/lib/news/ingest";
import { getDeliveryStates } from "@/lib/delivery";
import { NewsList, type NewsDeliveryStates } from "@/components/news-list";
import { NewsRefreshButton } from "@/components/news-refresh-button";
import { Sidebar } from "@/components/sidebar";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "کتابخانه مقالات | دستیار هوشمند اقتصاد هوش مصنوعی",
  description: "فهرست کامل مقالات دریافت‌شده، تحلیل هوشمند و وضعیت ارسال به بله",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.trim() ? raw.trim() : undefined;
}

function buildLibraryHref(
  current: Record<string, string | undefined>,
  overrides: Record<string, string | undefined>,
): string {
  const merged = { ...current, ...overrides };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `/news?${qs}` : "/news";
}

type LoadResult = {
  items: NewsListItem[];
  total: number;
  page: number;
  totalPages: number;
  stats: NewsStats | null;
  deliveryStates: NewsDeliveryStates;
  error: boolean;
};

async function loadNews(filters: LibraryNewsFilters): Promise<LoadResult> {
  // Never open a socket during `next build`; the page is dynamic at runtime.
  if (isNextProductionBuild) {
    return { items: [], total: 0, page: 1, totalPages: 1, stats: null, deliveryStates: {}, error: false };
  }

  try {
    try {
      await recoverStaleProcessing();
    } catch {
      // Non-fatal housekeeping before rendering the news feed.
    }
    const [library, stats] = await Promise.all([listLibraryNews(filters), getNewsStats()]);
    const deliveryStates = await getDeliveryStates(library.items.map((item) => item.id));
    return {
      items: library.items,
      total: library.total,
      page: library.page,
      totalPages: library.totalPages,
      stats,
      deliveryStates,
      error: false,
    };
  } catch {
    return { items: [], total: 0, page: 1, totalPages: 1, stats: null, deliveryStates: {}, error: true };
  }
}

const FILTER_TABS: Array<{ value: NonNullable<LibraryNewsFilters["filter"]>; label: string }> = [
  { value: "all", label: "همهٔ مقالات" },
  { value: "pending", label: "منتظر تحلیل AI" },
  { value: "analyzed", label: "تحلیل‌شده" },
  { value: "ready_to_send", label: "آمادهٔ ارسال به بله" },
];

export default async function NewsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const adminKey = first(sp.key) ?? "";
  const filterParam = first(sp.filter);
  const activeFilter: NonNullable<LibraryNewsFilters["filter"]> =
    filterParam === "pending" || filterParam === "analyzed" || filterParam === "ready_to_send" || filterParam === "offtopic"
      ? filterParam
      : "all";
  const activeSort: NonNullable<LibraryNewsFilters["sort"]> = first(sp.sort) === "published" ? "published" : "fetched";
  const searchQuery = first(sp.q);
  const requestedPage = Math.max(1, Number(first(sp.page) ?? 1) || 1);

  const { items, total, page, totalPages, stats, deliveryStates, error } = await loadNews({
    q: searchQuery,
    filter: activeFilter,
    sort: activeSort,
    page: requestedPage,
  });

  const baseQuery: Record<string, string | undefined> = {
    q: searchQuery,
    filter: activeFilter === "all" ? undefined : activeFilter,
    sort: activeSort === "fetched" ? undefined : activeSort,
    key: adminKey || undefined,
  };

  const analyzedCount = items.filter((item) => item.analyzedAt).length;
  const sentCount = items.filter((item) => {
    const state = deliveryStates[item.id];
    return state?.local === "sent" || state?.bale === "sent";
  }).length;

  return (
    <div dir="rtl" className="min-h-screen bg-canvas-2 text-ink">
      <div className="lg:flex">
        <Sidebar />

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1180px] p-4 sm:p-6 lg:p-10">
            <AdminKeyQuerySync adminKey={adminKey} />

            <header className="flex flex-col gap-5 border-b border-line/80 pb-7 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="mb-3 text-sm font-medium text-accent-ink">کتابخانه اخبار</p>
                <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">کتابخانهٔ مقالات و اخبار</h1>
                <p className="mt-2 text-sm text-muted">
                  مرتب‌شده بر اساس جدیدترین مقالات واردشده به سیستم — تمام مقالات جدید بلافاصله در ابتدای فهرست قرار می‌گیرند
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="rounded-2xl border border-line bg-surface px-4 py-3 text-center shadow-sm shadow-line/40">
                  <p className="text-xs text-muted">کل مقالات کتابخانه</p>
                  <p className="mt-1 text-lg font-bold text-ink">{(stats?.totalStored ?? total).toLocaleString("fa-IR")}</p>
                </div>
                <div className="rounded-2xl border border-line bg-surface px-4 py-3 text-center shadow-sm shadow-line/40">
                  <p className="text-xs text-muted">تحلیل‌شده (این صفحه)</p>
                  <p className="mt-1 text-lg font-bold text-ink">{analyzedCount.toLocaleString("fa-IR")}</p>
                </div>
                <div className="rounded-2xl border border-line bg-surface px-4 py-3 text-center shadow-sm shadow-line/40">
                  <p className="text-xs text-muted">ارسال‌شده (این صفحه)</p>
                  <p className="mt-1 text-lg font-bold text-ink">{sentCount.toLocaleString("fa-IR")}</p>
                </div>
                <NewsRefreshButton adminKey={adminKey} />
              </div>
            </header>

            <section className="mt-5 flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm shadow-line/30 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                {FILTER_TABS.map((tab) => {
                  const isActive = activeFilter === tab.value;
                  return (
                    <Link
                      className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
                        isActive
                          ? "bg-accent text-white shadow-sm"
                          : "bg-surface-2 text-muted hover:bg-surface-3 hover:text-ink"
                      }`}
                      href={buildLibraryHref(baseQuery, {
                        filter: tab.value === "all" ? undefined : tab.value,
                        page: undefined,
                      })}
                      key={tab.value}
                    >
                      {tab.label}
                    </Link>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <form action="/news" className="flex items-center gap-2" method="GET">
                  {activeFilter !== "all" ? <input name="filter" type="hidden" value={activeFilter} /> : null}
                  {activeSort !== "fetched" ? <input name="sort" type="hidden" value={activeSort} /> : null}
                  <input
                    className="w-44 rounded-xl border border-line bg-canvas-2 px-3 py-1.5 text-xs text-ink placeholder:text-faint sm:w-56"
                    defaultValue={searchQuery ?? ""}
                    name="q"
                    placeholder="جست‌وجوی عنوان یا منبع…"
                    type="search"
                  />
                  <button
                    className="rounded-xl bg-surface-3 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-track"
                    type="submit"
                  >
                    جست‌وجو
                  </button>
                </form>

                <div className="flex items-center gap-1 rounded-xl border border-line bg-canvas-2 p-1 text-[11px]">
                  <Link
                    className={`rounded-lg px-2.5 py-1 font-semibold ${
                      activeSort === "fetched" ? "bg-surface text-ink shadow-xs" : "text-muted hover:text-ink"
                    }`}
                    href={buildLibraryHref(baseQuery, { sort: undefined, page: undefined })}
                  >
                    جدیدترین دریافتی‌ها
                  </Link>
                  <Link
                    className={`rounded-lg px-2.5 py-1 font-semibold ${
                      activeSort === "published" ? "bg-surface text-ink shadow-xs" : "text-muted hover:text-ink"
                    }`}
                    href={buildLibraryHref(baseQuery, { sort: "published", page: undefined })}
                  >
                    تاریخ انتشار فید
                  </Link>
                </div>
              </div>
            </section>

            {error ? (
              <p className="mt-6 rounded-2xl border border-danger-line bg-danger-soft px-5 py-4 text-sm text-danger-ink">
                خواندن مقالات از پایگاه داده ناموفق بود. لطفاً بعداً دوباره تلاش کنید.
              </p>
            ) : null}

            <p className="mt-5 text-xs text-faint">
              نمایش {items.length.toLocaleString("fa-IR")} مقاله از مجموع {total.toLocaleString("fa-IR")} مقالهٔ منطبق (صفحهٔ{" "}
              {page.toLocaleString("fa-IR")} از {totalPages.toLocaleString("fa-IR")}).
            </p>

            <section aria-label="فهرست مقالات" className="mt-5">
              <NewsList adminKey={adminKey} deliveryStates={deliveryStates} items={items} />
            </section>

            {totalPages > 1 ? (
              <nav aria-label="صفحه‌بندی کتابخانه" className="mt-7 flex items-center justify-between gap-3">
                {page > 1 ? (
                  <Link
                    className="rounded-xl border border-line bg-surface px-4 py-2 text-xs font-semibold text-ink hover:bg-surface-2"
                    href={buildLibraryHref(baseQuery, { page: String(page - 1) })}
                  >
                    ← صفحهٔ قبل
                  </Link>
                ) : (
                  <span />
                )}
                <span className="text-xs text-muted">
                  صفحهٔ {page.toLocaleString("fa-IR")} از {totalPages.toLocaleString("fa-IR")}
                </span>
                {page < totalPages ? (
                  <Link
                    className="rounded-xl border border-line bg-surface px-4 py-2 text-xs font-semibold text-ink hover:bg-surface-2"
                    href={buildLibraryHref(baseQuery, { page: String(page + 1) })}
                  >
                    صفحهٔ بعد →
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
