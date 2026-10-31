import type { ReactNode } from "react";
import { ActivityList } from "@/components/activity-list";
import { AdminKeyQuerySync } from "@/components/admin/admin-key-query-sync";
import { DashboardActions } from "@/components/dashboard-actions";
import { DashboardCard } from "@/components/dashboard-card";
import { Sidebar } from "@/components/sidebar";
import { StatusBadge } from "@/components/status-badge";
import { getDeliveryStats } from "@/lib/delivery/publishing";
import { getAiTokenUsageStats, getNewsStats, type AiTokenUsageSummary } from "@/lib/news/ingest";
import { listRecentRuns, listSourcesForAdmin, summarizeSources } from "@/lib/news/sources-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type StatCard = {
  label: string;
  value: ReactNode;
  detail: string;
  accent: "blue" | "violet" | "amber" | "slate";
  icon: ReactNode;
};

const sourcesIcon = (
  <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 4.5h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h6M7 16h4" />
  </svg>
);

const newsIcon = (
  <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 5.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 8h8M8 12h8M8 16h5" />
  </svg>
);

const sendIcon = (
  <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path strokeLinecap="round" strokeLinejoin="round" d="m21 3-7.6 18-3.8-7.6L2 9.6 21 3Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="m9.6 13.4 4.8-4.8" />
  </svg>
);

const clockIcon = (
  <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="12" r="8.5" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2" />
  </svg>
);

const tokenIcon = (
  <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path strokeLinecap="round" strokeLinejoin="round" d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
  </svg>
);

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("fa-IR");
}

function formatNumber(num: number): string {
  return num.toLocaleString("fa-IR");
}

/**
 * Real dashboard counters (the UI milestone's static placeholders, as the
 * backend is now ready). Every source is best-effort: a DB hiccup degrades one
 * card to "—" instead of breaking the whole page.
 */
async function loadDashboardStats(): Promise<StatCard[]> {
  let activeSources = 0;
  let totalStored = 0;
  let sentCount: number | null = null;
  let lastRunAt: string | null = null;
  let tokenUsage: AiTokenUsageSummary | null = null;

  try {
    const summary = summarizeSources(await listSourcesForAdmin());
    activeSources = summary.active;
  } catch {
    // keep 0
  }

  try {
    const stats = await getNewsStats();
    totalStored = stats.totalStored;
  } catch {
    // keep 0
  }

  try {
    const delivery = await getDeliveryStats();
    sentCount = delivery.sent;
  } catch {
    // keep null
  }

  try {
    const runs = await listRecentRuns(1);
    lastRunAt = runs[0]?.startedAt ?? null;
  } catch {
    // keep null
  }

  try {
    tokenUsage = await getAiTokenUsageStats();
  } catch {
    // keep null
  }

  return [
    {
      label: "منابع خبری",
      value: String(activeSources),
      detail: "منبع فعال",
      accent: "blue",
      icon: sourcesIcon,
    },
    {
      label: "اخبار دریافت‌شده",
      value: String(totalStored),
      detail: "در تمام منابع",
      accent: "violet",
      icon: newsIcon,
    },
    {
      label: "اخبار ارسال‌شده",
      value: sentCount === null ? "—" : String(sentCount),
      detail: "در تمام مقاصد",
      accent: "amber",
      icon: sendIcon,
    },
    {
      label: "مصرف توکن AI",
      value: tokenUsage === null ? "—" : formatNumber(tokenUsage.totalTokens),
      detail:
        tokenUsage === null
          ? "در دسترس نیست"
          : `امروز: ${formatNumber(tokenUsage.todayTokens)} · ورودی: ${formatNumber(tokenUsage.promptTokens)} / خروجی: ${formatNumber(tokenUsage.completionTokens)}`,
      accent: "violet",
      icon: tokenIcon,
    },
    {
      label: "آخرین اجرای Agent",
      value: lastRunAt ? formatTime(lastRunAt) : "هنوز اجرا نشده",
      detail: lastRunAt ? "آخرین نوبت دریافت منابع" : "از بخش منابع خبری اجرا کنید",
      accent: "slate",
      icon: clockIcon,
    },
  ];
}

export const metadata = {
  title: "داشبورد | دستیار هوشمند اخبار",
  description: "داشبورد مدیریت دریافت، تحلیل و ارسال اخبار",
};

type DashboardPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const params = await searchParams;
  const keyParam = params.key;
  const adminKey = (Array.isArray(keyParam) ? keyParam[0] : keyParam)?.trim() ?? "";
  const dashboardStats = await loadDashboardStats();
  return (
    <div dir="rtl" className="min-h-screen bg-canvas-2 text-ink">
      <div className="lg:flex">
        <Sidebar />

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1480px] p-4 sm:p-6 lg:p-10">
            <AdminKeyQuerySync adminKey={adminKey} />
            <header className="flex flex-col gap-5 border-b border-line/80 pb-7 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="mb-3 text-sm font-medium text-accent-ink">مرکز کنترل اخبار</p>
                <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
                  دستیار هوشمند اخبار
                </h1>
                <p className="mt-2 text-sm text-muted sm:text-base">
                  مدیریت دریافت، تحلیل و ارسال اخبار
                </p>
              </div>

              <div className="flex w-fit items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-sm shadow-line/40">
                <span className="text-sm font-medium text-muted">وضعیت سیستم:</span>
                <StatusBadge>فعال</StatusBadge>
              </div>
            </header>

            <section aria-labelledby="stats-heading" className="mt-7">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 id="stats-heading" className="text-lg font-bold text-ink">نمای کلی</h2>
                  <p className="mt-1 text-sm text-faint">خلاصه وضعیت فعلی دستیار اخبار</p>
                </div>
                <span className="hidden text-xs text-faint sm:block">به‌روزرسانی لحظه‌ای فعال نیست</span>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                {dashboardStats.map((stat) => (
                  <DashboardCard
                    accent={stat.accent}
                    detail={stat.detail}
                    icon={stat.icon}
                    key={stat.label}
                    label={stat.label}
                    value={stat.value}
                  />
                ))}
              </div>
            </section>

            <DashboardActions adminKey={adminKey} />

            <section aria-labelledby="activity-heading" className="mt-6 rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6">
              <div className="mb-5">
                <h2 id="activity-heading" className="text-lg font-bold text-ink">آخرین فعالیت‌ها</h2>
                <p className="mt-1 text-sm text-faint">رویدادهای اخیر دستیار در این بخش ثبت می‌شوند</p>
              </div>
              <ActivityList />
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
