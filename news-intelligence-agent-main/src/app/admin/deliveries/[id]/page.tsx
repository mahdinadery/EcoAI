import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isNextProductionBuild } from "@/db";
import { AdminGateScreen } from "@/components/admin/admin-gate-screen";
import { AdminKeyQuerySync } from "@/components/admin/admin-key-query-sync";
import { AdminPageErrorShell } from "@/components/admin/admin-page-error-shell";
import { adminKeyForClient, getAdminPageAccess } from "@/lib/admin/page-access";
import { runWithSchemaRepair } from "@/lib/admin/schema-sync";
import { getDeliveryDetail } from "@/lib/delivery/publishing";
import { publishStatusLabel, publishingStatusTone } from "@/lib/delivery/types";
import { DeliveryActions } from "@/components/admin/delivery-actions";
import { Sidebar } from "@/components/sidebar";
import { StatusBadge } from "@/components/status-badge";
import { DELIVERY_EVENT_LABELS } from "@/lib/delivery/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "جزئیات ارسال | انتشار اخبار",
  description: "تأیید انسانی، ویرایش پیام و تاریخچه ارسال",
};

type PageProps = {
  params: Promise<{ id: string }> | { id: string };
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function formatFull(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("fa-IR");
}

export default async function AdminDeliveryDetailPage({ params, searchParams }: PageProps) {
  const resolvedParams = "then" in params ? await params : params;
  const sp = await searchParams;
  const providedKeyRaw = sp.key;
  const providedKey = Array.isArray(providedKeyRaw) ? providedKeyRaw[0] : providedKeyRaw;

  if (isNextProductionBuild) notFound();

  const access = await getAdminPageAccess(providedKey);
  if (!access.authorized) {
    return <AdminGateScreen width="narrow" />;
  }

  const clientKey = adminKeyForClient(access);

  const outcome = await runWithSchemaRepair(() => getDeliveryDetail(resolvedParams.id));
  if (!outcome.ok) {
    return (
      <AdminPageErrorShell
        adminKey={clientKey}
        error={outcome.error}
        message="بارگذاری جزئیات ارسال از پایگاه داده ناموفق بود."
      />
    );
  }

  const detail = outcome.value;
  if (!detail) notFound();

  const { delivery, article, analysis, events } = detail;
  const backHref = `/admin/deliveries${clientKey ? `?key=${encodeURIComponent(clientKey)}` : ""}`;

  return (
    <div dir="rtl" className="min-h-screen bg-canvas-2 text-ink">
      <div className="lg:flex">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1180px] space-y-6 p-4 sm:p-6 lg:p-10">
            <AdminKeyQuerySync adminKey={clientKey} />
            <header>
              <Link className="text-sm font-medium text-accent-ink hover:underline" href={backHref}>
                → بازگشت به فهرست ارسال‌ها
              </Link>
              <h1 className="mt-3 text-2xl font-bold leading-9 tracking-tight text-ink">{article.title}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                <StatusBadge tone={publishingStatusTone(delivery.status)}>{publishStatusLabel(delivery.status)}</StatusBadge>
                <span>مقصد: {delivery.destination === "bale" ? "بله" : "Local"}</span>
                <span>· شروع‌کننده: {delivery.triggeredBy === "auto" ? "قوانین خودکار" : "دستی"}</span>
              </div>
            </header>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="خبر">
                <dl className="space-y-2 text-sm">
                  <Row label="منبع" value={article.source} />
                  <Row
                    label="آدرس اصلی"
                    value={
                      <a className="break-all text-accent-ink hover:underline" dir="ltr" href={article.url} rel="noopener noreferrer nofollow" target="_blank">
                        {article.url}
                      </a>
                    }
                  />
                  <Row label="تاریخ انتشار" value={article.publishedAt ? formatFull(article.publishedAt.toISOString()) : "—"} />
                  <Row label="تاریخ دریافت" value={formatFull(article.fetchedAt.toISOString())} />
                  <Row label="وضعیت خبر" value={article.status} />
                </dl>
                {article.summary ? (
                  <p className="mt-3 rounded-xl bg-surface-2 p-3 text-sm leading-7 text-ink-soft">{article.summary}</p>
                ) : null}
              </Card>

              <Card title="تحلیل AI (معتبر برای این ارسال)">
                {analysis ? (
                  <>
                    <div className="flex flex-wrap gap-2 text-[11px]">
                      <span className="rounded-full bg-surface-3 px-2.5 py-1 font-bold text-muted">
                        پیکربندی نسخه {analysis.configurationVersion ?? "—"}
                      </span>
                      <span className="rounded-full bg-surface-3 px-2.5 py-1 font-mono text-muted" dir="ltr">
                        {analysis.model ?? "—"}
                      </span>
                      <span className="rounded-full bg-surface-3 px-2.5 py-1 text-muted">{formatFull(analysis.createdAt.toISOString())}</span>
                    </div>
                    <p className="mt-3 text-sm leading-7 text-ink-soft">{analysis.summary}</p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <Chip>دسته: {analysis.category ?? "—"}</Chip>
                      <Chip>اهمیت: {analysis.importance ?? "—"}</Chip>
                      <Chip>مرتبط بودن: {analysis.relevance ?? "—"}</Chip>
                      <Chip>تازگی: {analysis.novelty ?? "—"}</Chip>
                    </div>
                    {analysis.mainEvent ? <p className="mt-2 text-xs text-muted">رویداد اصلی: {analysis.mainEvent}</p> : null}
                    <div className="mt-3 flex items-center gap-2">
                      <span className="text-xs font-bold text-muted">تصمیم AI:</span>
                      <StatusBadge tone={analysis.shouldSend ? "success" : "muted"}>
                        {analysis.shouldSend ? "باید ارسال شود" : "عدم توصیه ارسال"}
                      </StatusBadge>
                    </div>
                    {analysis.reason ? <p className="mt-1 text-xs leading-6 text-muted">دلیل: {analysis.reason}</p> : null}
                  </>
                ) : (
                  <p className="text-sm text-faint">
                    این رکورد به یک تحلیل خاص لینک نشده است (رکوردهای پیش از این milestone) — متن خبر همان چیزی است که
                    پایین‌تر در «متن پیام» می‌بینید.
                  </p>
                )}
              </Card>
            </div>

            <Card title="متن پیام (محصول نهایی انتشار)">
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-xl bg-surface-2 p-4 text-sm leading-7 text-ink-soft ring-1 ring-line-soft">
                {delivery.message ?? "—"}
              </pre>
              <p className="mt-2 text-[11px] text-faint">
                این متن یک اثر مستقل انتشار است؛ ویرایش آن عنوان خبر، خلاصه AI و امتیازها را تغییر نمی‌دهد.
              </p>
            </Card>

            <DeliveryActions
              adminKey={clientKey}
              canRetry={!delivery.providerMessageId && !delivery.sentAt}
              deliveryId={delivery.id}
              destination={delivery.destination}
              message={delivery.message ?? ""}
              status={delivery.status}
            />

            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="وضعیت انتشار">
                <dl className="space-y-2 text-sm">
                  <Row label="ساخته‌شده" value={formatFull(delivery.createdAt.toISOString())} />
                  <Row label="تأیید توسط" value={delivery.approvedBy ?? "—"} />
                  <Row label="زمان تأیید" value={delivery.approvedAt ? formatFull(delivery.approvedAt.toISOString()) : "—"} />
                  <Row label="زمان ارسال" value={delivery.sentAt ? formatFull(delivery.sentAt.toISOString()) : "—"} />
                  <Row label="شناسه پیام بله" value={delivery.providerMessageId ? <code className="font-mono text-xs" dir="ltr">{delivery.providerMessageId}</code> : "—"} />
                  <Row label="تعداد تلاش مجدد" value={String(delivery.retryCount ?? 0)} />
                  {delivery.overrideRequested ? (
                    <Row label="override" value={<span className="font-bold text-brand-ink">{delivery.overrideReason ?? "ثبت شده"}</span>} />
                  ) : null}
                  {delivery.errorMessage ? <Row label="آخرین خطا" value={<span className="text-danger-ink">{delivery.errorMessage}</span>} /> : null}
                </dl>
              </Card>

              <Card title="تاریخچه اقدامات">
                {events.length === 0 ? (
                  <p className="text-sm text-faint">رویدادی ثبت نشده است.</p>
                ) : (
                  <ul className="space-y-2">
                    {events.map((event) => (
                      <li className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-surface-2/60 px-3 py-2 text-xs" key={event.id}>
                        <span className="font-bold text-ink-soft">{DELIVERY_EVENT_LABELS[event.event] ?? event.event}</span>
                        <span className="text-faint">{formatFull(event.createdAt.toISOString())}</span>
                        {event.actor ? <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted">{event.actor}</span> : null}
                        {event.detail ? <span className="w-full break-words text-[11px] text-muted">{event.detail}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <p className="text-[11px] leading-5 text-faint">
              ارسال فقط با کلیک انجام می‌شود؛ هیچ ارسال خودکاری برای مسیر تأیید انسانی فعال نیست. اعتبارنامه‌های بله
              هرگز در این صفحه یا پاسخ API نمایش داده نمی‌شوند.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line/80 bg-surface p-5 shadow-sm">
      <h2 className="text-sm font-bold text-ink">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line-soft pb-1.5 last:border-0">
      <dt className="shrink-0 text-xs font-bold text-faint">{label}</dt>
      <dd className="text-left text-ink-soft">{value}</dd>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-indigo-50 px-2.5 py-1 font-bold text-indigo-700 ring-1 ring-indigo-100">{children}</span>;
}
