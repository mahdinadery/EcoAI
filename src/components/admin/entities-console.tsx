"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { StatusBadge } from "../status-badge";
import {
  sortStats,
  type DossierKpis,
  type MetricStat,
  type SortDir,
  type SortKey,
} from "@/lib/admin/dossier-stats";

type DetailNews = {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  category: string | null;
  importanceScore: number | null;
  relevanceScore: number | null;
  corroborationCount: number;
  relevanceGrade: string | null;
  publishedAt: string | null;
};

type ApiResponse = {
  success: boolean;
  entities?: MetricStat[];
  publishers?: MetricStat[];
  kpis?: DossierKpis;
  stats?: MetricStat;
  kind?: "entity" | "publisher";
  news?: DetailNews[];
  message?: string;
  sent?: boolean;
  itemCount?: number;
  reason?: string | null;
};

type TabKey = "publishers" | "entities";
type DetailKind = "entity" | "publisher";

const SORT_LABELS: Record<Exclude<SortKey, "name">, string> = {
  count: "تعداد",
  time: "زمان",
  importance: "امتیاز اهمیت",
};

function authHeaders(adminKey: string): Record<string, string> {
  return adminKey ? { "x-admin-key": adminKey } : {};
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("fa-IR", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function formatDateShort(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("fa-IR", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function importanceTone(avg: number): { pill: string; label: string } {
  if (avg >= 70) return { pill: "bg-ok-soft text-ok-ink", label: "اهمیت بالا" };
  if (avg >= 40) return { pill: "bg-warn-soft text-warn-ink", label: "اهمیت متوسط" };
  return { pill: "bg-surface-3 text-ink-soft", label: "اهمیت پایین" };
}

/** High (>=70) / mid (40..69) / low (<40) importance distribution bar. */
function DistributionBar({ stat }: { stat: MetricStat }) {
  const total = stat.scoredCount;
  if (total <= 0) {
    return <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3" />;
  }
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-3" title="توزیع اهمیت: بالا/متوسط/پایین">
      <div className="bg-ok" style={{ width: `${(stat.highCount / total) * 100}%` }} />
      <div className="bg-warn" style={{ width: `${(stat.midCount / total) * 100}%` }} />
      <div className="bg-track-strong" style={{ width: `${(stat.lowCount / total) * 100}%` }} />
    </div>
  );
}

function KpiCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3.5">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="mt-1 text-xl font-bold text-ink">{value}</p>
      <p className="mt-1 text-[11px] leading-5 text-faint">{detail}</p>
    </div>
  );
}

function StatRow({
  stat,
  active,
  onSelect,
}: {
  stat: MetricStat;
  active: boolean;
  onSelect: () => void;
}) {
  const tone = importanceTone(stat.avgImportance);
  return (
    <button
      className={`w-full rounded-lg border px-3 py-2 text-right text-sm transition ${
        active ? "border-accent bg-accent-soft text-accent-ink" : "border-line-soft hover:bg-surface-2"
      }`}
      onClick={onSelect}
      type="button"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{stat.name}</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${tone.pill}`}>
          {stat.avgImportance.toLocaleString("fa-IR")}
        </span>
      </span>
      <span className="mt-1.5 block">
        <DistributionBar stat={stat} />
      </span>
      <span className="mt-1.5 block text-[11px] text-muted">
        {stat.count.toLocaleString("fa-IR")} خبر
        {stat.corroboratedCount > 0 ? ` · ${stat.corroboratedCount.toLocaleString("fa-IR")} تأییدشده` : ""}
        {stat.recent7d > 0 ? ` · ${stat.recent7d.toLocaleString("fa-IR")} در ۷ روز اخیر` : ""}
        {" · آخرین: "}
        {formatDateShort(stat.lastPublishedAt)}
      </span>
    </button>
  );
}

function NewsList({ items }: { items: DetailNews[] }) {
  if (items.length === 0) {
    return <p className="p-4 text-center text-xs text-faint">خبری برای این مورد پیدا نشد.</p>;
  }
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <article key={item.id} className="rounded-xl border border-line-soft p-3">
          <div className="flex flex-wrap items-center gap-2">
            <a
              className="text-sm font-medium text-accent-ink hover:underline"
              href={item.url}
              rel="noreferrer"
              target="_blank"
            >
              {item.title}
            </a>
            {(item.corroborationCount ?? 0) >= 2 ? <StatusBadge tone="success">تأییدشده</StatusBadge> : null}
            {item.relevanceGrade === "rejected" ? <StatusBadge tone="danger">نامرتبط (گریدر)</StatusBadge> : null}
          </div>
          {item.summary ? (
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{item.summary}</p>
          ) : null}
          <p className="mt-1 text-[11px] text-faint">
            {item.source} · اهمیت {(item.importanceScore ?? 0).toLocaleString("fa-IR")} · مرتبط بودن{" "}
            {(item.relevanceScore ?? 0).toLocaleString("fa-IR")} · {formatDate(item.publishedAt)}
          </p>
        </article>
      ))}
    </div>
  );
}

export function EntitiesConsole({ adminKey = "" }: { adminKey?: string }) {
  const [entities, setEntities] = useState<MetricStat[]>([]);
  const [publishers, setPublishers] = useState<MetricStat[]>([]);
  const [kpis, setKpis] = useState<DossierKpis | null>(null);
  const [tab, setTab] = useState<TabKey>("publishers");
  const [sortKey, setSortKey] = useState<Exclude<SortKey, "name">>("count");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selected, setSelected] = useState<string | null>(null);
  const [detailKind, setDetailKind] = useState<DetailKind | null>(null);
  const [detail, setDetail] = useState<{ stats: MetricStat; news: DetailNews[] } | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [bulletinBusy, setBulletinBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);

  // NOTE: no synchronous setState here — the effect below calls load() on
  // mount and react-hooks/set-state-in-effect forbids sync set-state in it.
  const load = useCallback(() => {
    fetch("/api/admin/entities", { headers: authHeaders(adminKey), cache: "no-store" })
      .then((res) => res.json() as Promise<ApiResponse>)
      .then((data) => {
        if (data.success) {
          setEntities(data.entities ?? []);
          setPublishers(data.publishers ?? []);
          setKpis(data.kpis ?? null);
          setLoadFailure(null);
        } else {
          setLoadFailure(data.message ?? "بارگذاری داشبورد ناموفق بود.");
        }
      })
      .catch(() => setLoadFailure("ارتباط با سرور برقرار نشد."))
      .finally(() => setLoading(false));
  }, [adminKey]);

  useEffect(() => {
    load();
  }, [load]);

  const loadDetail = useCallback(
    (kind: DetailKind, name: string) => {
      setSelected(name);
      setDetailKind(kind);
      setDetailLoading(true);
      setDetail(null);
      const param = kind === "entity" ? "name" : "publisher";
      fetch(`/api/admin/entities?${param}=${encodeURIComponent(name)}`, {
        headers: authHeaders(adminKey),
        cache: "no-store",
      })
        .then((res) => res.json() as Promise<ApiResponse>)
        .then((data) => {
          if (data.success && data.stats) {
            setDetail({ stats: data.stats, news: data.news ?? [] });
          } else {
            setMessage({ kind: "err", text: data.message ?? "خواندن پرونده ناموفق بود." });
          }
        })
        .catch(() => setMessage({ kind: "err", text: "ارتباط با سرور برقرار نشد." }))
        .finally(() => setDetailLoading(false));
    },
    [adminKey],
  );

  const sendBulletin = useCallback(async () => {
    if (!selected || detailKind !== "entity" || bulletinBusy) return;
    setBulletinBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/entities/bulletin", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
        body: JSON.stringify({ name: selected }),
      });
      const data = (await response.json()) as ApiResponse;
      if (data.success && data.sent) {
        setMessage({ kind: "ok", text: `بولتن «${selected}» با ${data.itemCount ?? 0} خبر ارسال شد.` });
      } else {
        setMessage({
          kind: "err",
          text: `بولتن ارسال نشد${data.reason ? ` (${data.reason === "no_qualifying_items" ? "خبر واجد شرایط نبود" : data.reason})` : ""}.`,
        });
      }
    } catch {
      setMessage({ kind: "err", text: "ارتباط با سرور برقرار نشد." });
    } finally {
      setBulletinBusy(false);
    }
  }, [adminKey, bulletinBusy, detailKind, selected]);

  const list = tab === "publishers" ? publishers : entities;
  const detailMatchesTab = detailKind === (tab === "publishers" ? "publisher" : "entity");

  const visible = useMemo(() => {
    const clean = query.trim();
    const filtered = clean ? list.filter((stat) => stat.name.includes(clean)) : list;
    return sortStats(filtered, sortKey, sortDir);
  }, [list, query, sortDir, sortKey]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-ink">پروندهٔ ناشران و نهادها</h1>
          <p className="mt-1 text-xs leading-5 text-muted">
            داشبورد رتبه‌بندی ناشران و نهادها بر اساس <strong>تعداد</strong>، <strong>زمان</strong> و{" "}
            <strong>امتیاز میزان اهمیت</strong>. نام بانک‌ها/شرکت‌ها/نهادها را هوش مصنوعی از تحلیل خبرها استخراج
            می‌کند و از هر موجودیت می‌توانید «بولتن موردی» همان نهاد را برای کانال بفرستید.
          </p>
        </div>
        <button
          className="rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-ink-soft hover:bg-surface-2"
          onClick={() => {
            setLoading(true);
            load();
          }}
          type="button"
        >
          تازه‌سازی
        </button>
      </div>

      {loadFailure ? (
        <p className="rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger-ink">{loadFailure}</p>
      ) : null}
      {message ? (
        <p
          className={`rounded-xl border px-4 py-3 text-sm ${
            message.kind === "ok"
              ? "border-ok-line bg-ok-soft text-ok-ink"
              : "border-danger-line bg-danger-soft text-danger-ink"
          }`}
        >
          {message.text}
        </p>
      ) : null}

      {/* KPI cards — count / time / importance at a glance. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard
          label="ناشران"
          value={(kpis?.publisherCount ?? 0).toLocaleString("fa-IR")}
          detail="منبع دارای خبر تحلیل‌شده"
        />
        <KpiCard
          label="نهادها"
          value={(kpis?.entityCount ?? 0).toLocaleString("fa-IR")}
          detail="موجودیت استخراج‌شده از تحلیل‌ها"
        />
        <KpiCard
          label="اخبار تحلیل‌شده"
          value={(kpis?.scanned ?? 0).toLocaleString("fa-IR")}
          detail={`تأیید چندمنبعی: ${(kpis?.corroboratedCount ?? 0).toLocaleString("fa-IR")}`}
        />
        <KpiCard
          label="میانگین اهمیت"
          value={(kpis?.avgImportance ?? 0).toLocaleString("fa-IR")}
          detail="امتیاز میزان اهمیت از ۱۰۰"
        />
        <KpiCard
          label="آخرین خبر"
          value={kpis?.lastPublishedAt ? formatDateShort(kpis.lastPublishedAt) : "—"}
          detail="زمان آخرین خبر تحلیل‌شده"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <section className="rounded-2xl border border-line bg-surface p-4 lg:col-span-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ["publishers", "ناشران"],
                ["entities", "نهادها"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  tab === key ? "bg-accent text-white" : "border border-line bg-surface text-muted hover:bg-surface-2"
                }`}
                onClick={() => {
                  setTab(key);
                  setSelected(null);
                  setDetailKind(null);
                  setDetail(null);
                  setQuery("");
                }}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          <input
            className="mt-3 w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-accent focus:outline-none"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tab === "publishers" ? "جست‌وجوی ناشر..." : "جست‌وجوی موجودیت..."}
            value={query}
          />

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-faint">مرتب‌سازی:</span>
            {(["count", "time", "importance"] as const).map((key) => (
              <button
                key={key}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                  sortKey === key
                    ? "bg-ink text-on-ink"
                    : "border border-line bg-surface text-muted hover:bg-surface-2"
                }`}
                onClick={() => {
                  if (sortKey === key) {
                    setSortDir((dir) => (dir === "desc" ? "asc" : "desc"));
                  } else {
                    setSortKey(key);
                    setSortDir("desc");
                  }
                }}
                type="button"
              >
                {SORT_LABELS[key]}
                {sortKey === key ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
              </button>
            ))}
          </div>

          <div className="mt-3 max-h-[560px] space-y-1 overflow-y-auto">
            {loading ? <p className="p-3 text-xs text-faint">در حال بارگذاری...</p> : null}
            {!loading && visible.length === 0 ? (
              <p className="p-3 text-xs leading-6 text-faint">
                {tab === "publishers"
                  ? "هنوز ناشری با خبر تحلیل‌شده ثبت نشده است."
                  : "هنوز موجودیتی استخراج نشده است. خبرهای تحلیل‌شدهٔ جدید به‌صورت خودکار این فهرست را پر می‌کنند."}
              </p>
            ) : null}
            {visible.map((stat) => (
              <StatRow
                active={detailMatchesTab && selected === stat.name}
                key={`${tab}-${stat.name}`}
                onSelect={() => loadDetail(tab === "publishers" ? "publisher" : "entity", stat.name)}
                stat={stat}
              />
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-line bg-surface p-4 lg:col-span-3">
          {!selected ? (
            <p className="p-6 text-center text-sm text-faint">
              یک ناشر یا موجودیت را از فهرست انتخاب کنید تا پروندهٔ آن با جزئیات تعداد، زمان و اهمیت نمایش داده شود.
            </p>
          ) : detailLoading ? (
            <p className="p-6 text-center text-sm text-faint">در حال بارگذاری پرونده...</p>
          ) : detail ? (
            <div>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-base font-bold text-ink">{detail.stats.name}</h2>
                  <p className="mt-1 text-xs text-muted">
                    {detailKind === "publisher" ? "ناشر" : "موجودیت"} ·{" "}
                    {detail.stats.count.toLocaleString("fa-IR")} خبر تحلیل‌شده · میانگین اهمیت{" "}
                    {detail.stats.avgImportance.toLocaleString("fa-IR")} · بیشینه{" "}
                    {detail.stats.maxImportance.toLocaleString("fa-IR")} ·{" "}
                    {detail.stats.corroboratedCount.toLocaleString("fa-IR")} تأییدشده · اولین:{" "}
                    {formatDate(detail.stats.firstPublishedAt)} · آخرین: {formatDate(detail.stats.lastPublishedAt)}
                  </p>
                  <p className="mt-1 text-[11px] text-faint">
                    توزیع اهمیت: بالا {detail.stats.highCount.toLocaleString("fa-IR")} · متوسط{" "}
                    {detail.stats.midCount.toLocaleString("fa-IR")} · پایین{" "}
                    {detail.stats.lowCount.toLocaleString("fa-IR")} · در ۷ روز اخیر{" "}
                    {detail.stats.recent7d.toLocaleString("fa-IR")} خبر
                  </p>
                  <div className="mt-2 max-w-md">
                    <DistributionBar stat={detail.stats} />
                  </div>
                </div>
                {detailKind === "entity" ? (
                  <button
                    className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent-strong disabled:opacity-50"
                    disabled={bulletinBusy}
                    onClick={sendBulletin}
                    type="button"
                  >
                    {bulletinBusy ? "در حال ارسال..." : "ارسال بولتن این موجودیت"}
                  </button>
                ) : null}
              </div>

              <div className="mt-4">
                <NewsList items={detail.news} />
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
