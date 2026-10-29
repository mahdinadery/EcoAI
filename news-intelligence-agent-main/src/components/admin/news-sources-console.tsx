"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { CREDIT_RATING_PACK } from "@/lib/news/news-packs";
import { SchemaRepairCard } from "./schema-repair-card";

type Health = "healthy" | "warning" | "failed" | "paused";

type SourceView = {
  id: string;
  name: string;
  type: string;
  url: string;
  description: string | null;
  category: string | null;
  priority: number;
  active: boolean;
  fetchIntervalMinutes: number;
  maxItemsPerFetch: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  errorCount: number;
  totalFetched: number;
  totalAccepted: number;
  totalDuplicates: number;
  lastItemCount: number | null;
  lastNewestPublishedAt: string | null;
  health: Health;
  healthDetail: string | null;
};

type RunView = {
  id: string;
  sourceId: string | null;
  status: string;
  startedAt: string;
  itemsFound: number;
  itemsCreated: number;
  itemsFiltered?: number;
  duplicates: number;
  errors: number;
  errorMessage: string | null;
};

type TestResult = {
  ok: boolean;
  elapsedMs?: number;
  feedTitle?: string;
  itemCount?: number;
  skipped?: number;
  sample?: Array<{ title: string; url: string; publishedAt: string | null }>;
  message?: string;
  detail?: string | null;
};

type PackSourceOutcome = {
  name: string;
  url: string;
  status: "added" | "skipped" | "failed";
  message?: string;
};

type PackApplyResult = {
  success: boolean;
  pack?: { id: string; title: string };
  topics?: {
    ok?: boolean;
    applied?: boolean;
    reason?: string;
    added?: string[];
    skipped?: string[];
    truncated?: number;
    version?: number;
    total?: number;
    message?: string;
  } | null;
  audienceNote?: { applied: boolean; alreadyPresent: boolean } | null;
  sources?: {
    results?: PackSourceOutcome[];
    added?: number;
    skipped?: number;
    failed?: number;
    message?: string;
  } | null;
  warnings?: string[];
  message?: string;
};

type FormState = {
  id: string | null; // null = create
  name: string;
  type: "rss" | "api";
  url: string;
  description: string;
  category: string;
  priority: number;
  active: boolean;
  fetchIntervalMinutes: number;
  maxItemsPerFetch: number;
};

const HEALTH_LABEL: Record<Health, string> = {
  healthy: "سالم",
  warning: "هشدار",
  failed: "خطا",
  paused: "غیرفعال",
};

const HEALTH_TONE: Record<Health, "success" | "warning" | "danger" | "muted"> = {
  healthy: "success",
  warning: "warning",
  failed: "danger",
  paused: "muted",
};

/**
 * Curated Persian feeds for the credit-rating / finance domain (Phase 3
 * deliverable: «چند منبع»). One click fills the add-source form; the operator
 * can edit before saving. URLs are the outlets' public RSS endpoints.
 */
const PRESET_SOURCES: Array<{ name: string; url: string; category: string; note: string }> = [
  { name: "خبرگزاری جمهوری اسلامی (ایرنا)", url: "https://www.irna.ir/rss", category: "خبرگزاری", note: "رسمی‌ترین خبرگزاری دولتی — سیاست‌ها و مقررات" },
  { name: "خبرگزاری دانشجویان ایران (ایسنا)", url: "https://www.isna.ir/rss", category: "خبرگزاری", note: "پوشش گستردهٔ اقتصادی و بانکی" },
  { name: "خبرگزاری مهر", url: "https://www.mehrnews.com/rss", category: "خبرگزاری", note: "اقتصاد، بازار پول و سرمایه" },
  { name: "روزنامهٔ دنیای اقتصاد", url: "https://donya-e-eqtesad.com/feeds", category: "اقتصادی", note: "تخصصی‌ترین رسانهٔ اقتصادی — بهترین منبع اعتبارسنجی" },
  { name: "خبرآنلاین", url: "https://www.khabaronline.ir/rss", category: "عمومی", note: "اقتصاد و بازارهای مالی" },
  { name: "سنا (خبرگزاری بازار سرمایه)", url: "https://www.sena.ir/rss", category: "بورس", note: "بورس، ناشران و ابزارهای مالی — قبل از ذخیره تست کنید" },
];

const emptyForm = (): FormState => ({
  id: null,
  name: "",
  type: "rss",
  url: "",
  description: "",
  category: "",
  priority: 3,
  active: true,
  fetchIntervalMinutes: 60,
  maxItemsPerFetch: 50,
});

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("fa-IR");
}

export function NewsSourcesConsole({ adminKey }: { adminKey: string }) {
  const [sources, setSources] = useState<SourceView[]>([]);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [summary, setSummary] = useState({ total: 0, active: 0, healthy: 0, warning: 0, failed: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [pageMessage, setPageMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [loadFailure, setLoadFailure] = useState<{
    message: string;
    hint?: string;
    detail?: string;
    code?: string | null;
    schemaMismatch?: boolean;
  } | null>(null);

  const [form, setForm] = useState<FormState | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [fetchReports, setFetchReports] = useState<Record<string, string>>({});
  const [probeBusy, setProbeBusy] = useState(false);

  // Manual RSS/XML import (for geo-blocked Iranian hosts)
  const [importOpen, setImportOpen] = useState(false);
  const [importXml, setImportXml] = useState("");
  const [importSourceId, setImportSourceId] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // One-click domain pack (credit rating news for a rating company)
  const [packTopics, setPackTopics] = useState(true);
  const [packSources, setPackSources] = useState(true);
  const [packAudience, setPackAudience] = useState(true);
  const [packBusy, setPackBusy] = useState(false);
  const [packResult, setPackResult] = useState<PackApplyResult | null>(null);

  const headers = useCallback((): Record<string, string> => {
    const base: Record<string, string> = { "Content-Type": "application/json" };
    if (adminKey) base["x-admin-key"] = adminKey;
    return base;
  }, [adminKey]);

  const load = useCallback(() => {
    return fetch("/api/admin/news-sources", { headers: headers(), cache: "no-store" })
      .then((res) => res.json() as Promise<{
        success: boolean;
        sources?: SourceView[];
        runs?: RunView[];
        summary?: { total: number; active: number; healthy: number; warning: number; failed: number };
        message?: string;
        detail?: string;
        hint?: string;
        code?: string | null;
        schemaMismatch?: boolean;
        schemaSynced?: boolean;
      }>)
      .then((data) => {
        if (data.success) {
          setSources(data.sources ?? []);
          setRuns(data.runs ?? []);
          if (data.schemaSynced) {
            setPageMessage({ kind: "ok", text: "ساختار پایگاه داده به‌صورت خودکار همگام‌سازی شد." });
          }
          // Functional update keeps `load`'s deps stable — a previous version
          // depended on `summary` state, which made every response re-trigger
          // the load effect (an endless fetch loop while the page stayed open).
          setSummary((prev) => data.summary ?? prev);
          setLoadFailure(null);
        } else if (data.schemaMismatch) {
          // Missing table/column: show the error panel WITH the repair button
          // instead of a one-line message the operator cannot act on.
          setLoadFailure({
            message: data.message ?? "بارگذاری منابع ناموفق بود.",
            hint: data.hint,
            detail: data.detail,
            code: data.code,
            schemaMismatch: true,
          });
        } else {
          // Surface the real cause + actionable hint (never the old opaque error).
          const parts = [data.message ?? "بارگذاری منابع ناموفق بود."];
          if (data.hint) parts.push(data.hint);
          if (data.detail) parts.push(`جزئیات: ${data.detail}`);
          setPageMessage({ kind: "err", text: parts.join(" — ") });
        }
      })
      .catch(() => {
        setPageMessage({ kind: "err", text: "ارتباط با سرور برقرار نشد." });
      })
      .finally(() => {
        setLoading(false);
      });
  }, [headers]);

  const handleProbeAll = useCallback(() => {
    setProbeBusy(true);
    setPageMessage(null);
    fetch("/api/admin/news-sources/probe", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    })
      .then((res) => res.json() as Promise<{ success: boolean; summary?: { total: number; ok: number; failed: number }; message?: string }>)
      .then((data) => {
        if (data.success && data.summary) {
          const { total, ok, failed } = data.summary;
          setPageMessage({
            kind: failed > 0 ? "err" : "ok",
            text: `بررسی سلامت ${total} فید: ${ok} سالم${failed > 0 ? `، ${failed} ناسالم (جزئیات در ستون «سلامت»)}` : ""}.`,
          });
        } else {
          setPageMessage({ kind: "err", text: data.message ?? "بررسی سلامت فیدها ناموفق بود." });
        }
      })
      .catch(() => setPageMessage({ kind: "err", text: "بررسی سلامت فیدها ناموفق بود." }))
      .finally(() => {
        setProbeBusy(false);
        void load();
      });
  }, [headers, load]);

  useEffect(() => {
    void load();
  }, [load]);

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  async function handleSubmit() {
    if (!form) return;
    await withBusy("form", async () => {
      setFormErrors([]);
      const body = {
        name: form.name,
        type: form.type,
        url: form.url,
        description: form.description || null,
        category: form.category || null,
        priority: form.priority,
        active: form.active,
        fetchIntervalMinutes: form.fetchIntervalMinutes,
        maxItemsPerFetch: form.maxItemsPerFetch,
      };
      const res = await fetch(form.id ? `/api/admin/news-sources/${form.id}` : "/api/admin/news-sources", {
        method: form.id ? "PATCH" : "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { success: boolean; errors?: string[]; message?: string };
      if (data.success) {
        setForm(null);
        setPageMessage({ kind: "ok", text: form.id ? "منبع به‌روزرسانی شد." : "منبع جدید ثبت شد." });
        await load();
      } else {
        setFormErrors(data.errors ?? [data.message ?? "ذخیره منبع ناموفق بود."]);
      }
    });
  }

  async function handleTest(source: SourceView) {
    await withBusy(`test-${source.id}`, async () => {
      try {
        const res = await fetch(`/api/admin/news-sources/${source.id}/test`, { method: "POST", headers: headers(), body: "{}" });
        const data = (await res.json()) as { success: boolean; test?: TestResult };
        if (data.test) setTestResults((prev) => ({ ...prev, [source.id]: data.test as TestResult }));
      } catch {
        setTestResults((prev) => ({ ...prev, [source.id]: { ok: false, message: "خطای ارتباط با سرور." } }));
      }
    });
  }

  async function handleFetch(source: SourceView) {
    await withBusy(`fetch-${source.id}`, async () => {
      try {
        const res = await fetch(`/api/admin/news-sources/${source.id}/fetch`, { method: "POST", headers: headers(), body: "{}" });
        const data = (await res.json()) as {
          success: boolean;
          report?: { itemsFound: number; itemsCreated: number; itemsFiltered?: number; duplicates: number; skipped: number };
          failure?: { message: string };
          message?: string;
        };
        const filteredPart = data.report?.itemsFiltered ? ` · خارج از موضوع: ${data.report.itemsFiltered}` : "";
        const text = data.report
          ? `موارد یافت‌شده: ${data.report.itemsFound} · جدید: ${data.report.itemsCreated}${filteredPart} · تکراری: ${data.report.duplicates} · خطا: ${data.report.skipped}`
          : (data.failure?.message ?? data.message ?? "دریافت ناموفق بود.");
        setFetchReports((prev) => ({ ...prev, [source.id]: text }));
        await load();
      } catch {
        setFetchReports((prev) => ({ ...prev, [source.id]: "خطای ارتباط با سرور." }));
      }
    });
  }

  async function handleToggle(source: SourceView) {
    await withBusy(`toggle-${source.id}`, async () => {
      await fetch(`/api/admin/news-sources/${source.id}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ active: !source.active }),
      });
      await load();
    });
  }

  async function handleDelete(source: SourceView) {
    if (!window.confirm(`منبع «${source.name}» حذف شود؟ اخبار ثبت‌شده حفظ می‌شوند.`)) return;
    await withBusy(`delete-${source.id}`, async () => {
      await fetch(`/api/admin/news-sources/${source.id}`, { method: "DELETE", headers: headers() });
      setPageMessage({ kind: "ok", text: "منبع حذف شد." });
      await load();
    });
  }

  async function handleImport() {
    if (importBusy || !importXml.trim()) return;
    setImportBusy(true);
    setImportResult(null);
    try {
      const res = await fetch("/api/admin/news-import", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ xml: importXml, sourceId: importSourceId || undefined }),
      });
      const data = (await res.json()) as {
        success: boolean;
        message?: string;
        itemsFound?: number;
        itemsCreated?: number;
        duplicates?: number;
      };
      setImportResult(
        data.success
          ? { kind: "ok", text: `ورود انجام شد — یافت: ${data.itemsFound} · جدید: ${data.itemsCreated} · تکراری: ${data.duplicates}` }
          : { kind: "err", text: data.message ?? "ورود ناموفق بود." },
      );
      if (data.success) {
        setImportXml("");
        await load();
      }
    } catch {
      setImportResult({ kind: "err", text: "خطای ارتباط با سرور." });
    } finally {
      setImportBusy(false);
    }
  }

  async function handleApplyPack() {
    if (packBusy) return;
    setPackBusy(true);
    setPackResult(null);
    try {
      const res = await fetch("/api/admin/news-packs/apply", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          packId: CREDIT_RATING_PACK.id,
          applyTopics: packTopics,
          applySources: packSources,
          applyAudienceNote: packAudience,
        }),
      });
      const data = (await res.json()) as PackApplyResult;
      setPackResult(data);
      if (data.success) {
        setLoading(true);
        void load();
      }
    } catch {
      setPackResult({ success: false, message: "ارتباط با سرور برقرار نشد." });
    } finally {
      setPackBusy(false);
    }
  }

  async function handleRunDue() {
    await withBusy("run-due", async () => {
      try {
        const res = await fetch("/api/admin/news-sources/run-due", { method: "POST", headers: headers(), body: "{}" });
        const data = (await res.json()) as { success: boolean; considered?: number; fetched?: number; results?: Array<{ sourceName: string; status: string; detail?: string }>; message?: string };
        const detail = (data.results ?? []).map((r) => `${r.sourceName}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`).join(" | ");
        setPageMessage(
          data.success
            ? { kind: "ok", text: `بررسی ${data.considered ?? 0} منبع فعال — ${data.fetched ?? 0} دریافت شد. ${detail}` }
            : { kind: "err", text: data.message ?? "اجرای دریافت زمان‌بندی‌شده ناموفق بود." },
        );
        await load();
      } catch {
        setPageMessage({ kind: "err", text: "خطای ارتباط با سرور." });
      }
    });
  }

  return (
    <div className="space-y-6">
      <header className="border-b border-line/80 pb-6">
        <p className="mb-2 text-sm font-medium text-accent-ink">مرکز مدیریت اخبار</p>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">منابع خبری</h1>
        <p className="mt-2 text-sm text-muted">افزودن، تست، فعال/غیرفعال کردن و دریافت دستی منابع RSS</p>
      </header>

      {loadFailure ? (
        <SchemaRepairCard
          adminKey={adminKey}
          code={loadFailure.code}
          detail={loadFailure.detail}
          hint={loadFailure.hint}
          message={loadFailure.message}
          onRepaired={() => {
            setLoading(true);
            void load();
          }}
          schemaMismatch={Boolean(loadFailure.schemaMismatch)}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          بررسی سلامت، فید هر منبع را بی‌آنکه خبری ذخیره شود می‌گیرد و وضعیت «سالم/خالی/کهنه/ناسالم» را به‌روز می‌کند.
        </p>
        <button
          className="rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-ink-soft hover:bg-surface-2 disabled:opacity-50"
          disabled={probeBusy}
          onClick={handleProbeAll}
          type="button"
        >
          {probeBusy ? "در حال بررسی..." : "بررسی سلامت فیدها"}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="کل منابع" value={summary.total} />
        <StatCard label="فعال" value={summary.active} />
        <StatCard label="سالم" value={summary.healthy} tone="success" />
        <StatCard label="هشدار" value={summary.warning} tone="warning" />
        <StatCard label="خطا" value={summary.failed} tone="danger" />
      </div>

      <section className="rounded-2xl border border-ok-line bg-ok-soft/40 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-ink">بسته خبری اعتبارسنجی (اخبار داخلی)</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{CREDIT_RATING_PACK.description}</p>
          </div>
          <div className="flex shrink-0 gap-2 text-xs">
            <span className="rounded-full bg-surface px-3 py-1 font-semibold text-ok-ink">
              {CREDIT_RATING_PACK.topics.length} موضوع
            </span>
            <span className="rounded-full bg-surface px-3 py-1 font-semibold text-ok-ink">
              {CREDIT_RATING_PACK.sources.length} منبع
            </span>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-soft">
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              checked={packTopics}
              className="h-4 w-4 accent-emerald-600"
              onChange={(event) => setPackTopics(event.target.checked)}
              type="checkbox"
            />
            افزودن موضوعات و فعال‌سازی فیلتر تمرکز
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              checked={packSources}
              className="h-4 w-4 accent-emerald-600"
              onChange={(event) => setPackSources(event.target.checked)}
              type="checkbox"
            />
            افزودن منابع خبری داخلی (هر منبع قبل از ثبت تست می‌شود)
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              checked={packAudience}
              className="h-4 w-4 accent-emerald-600"
              onChange={(event) => setPackAudience(event.target.checked)}
              type="checkbox"
            />
            افزودن زمینه «شرکت اعتبارسنجی» به پرامپت تحلیل
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            className="rounded-xl bg-ok-strong px-4 py-2 text-sm font-bold text-white hover:bg-ok-strong disabled:opacity-50"
            disabled={packBusy || (!packTopics && !packSources && !packAudience)}
            onClick={handleApplyPack}
            type="button"
          >
            {packBusy ? "در حال اعمال و تست منابع…" : "اعمال بسته اعتبارسنجی"}
          </button>
          <span className="text-[11px] text-ok-ink/70">
            موضوعات روی نسخه فعال پیکربندی AI اعمال می‌شوند (نسخه قبلی در تاریخچه می‌ماند).
          </span>
        </div>

        {packResult ? (
          <div
            className={`mt-3 rounded-xl border px-4 py-3 text-xs leading-6 ${
              packResult.success
                ? "border-ok-line bg-surface text-ink-soft"
                : "border-danger-line bg-danger-soft text-danger-ink"
            }`}
          >
            {!packResult.success ? <p className="font-bold">{packResult.message ?? "اعمال بسته ناموفق بود."}</p> : null}

            {packResult.topics ? (
              <p>
                <b>موضوعات:</b>{" "}
                {packResult.topics.ok === false
                  ? packResult.topics.message ?? "ناموفق"
                  : packResult.topics.applied
                    ? `${packResult.topics.added?.length ?? 0} موضوع اضافه شد، ${packResult.topics.skipped?.length ?? 0} مورد از قبل موجود بود${
                        packResult.topics.truncated ? `، ${packResult.topics.truncated} مورد به سقف ۳۰ موضوع نرسید` : ""
                      } (نسخه ${packResult.topics.version ?? "—"}).`
                    : "همه موضوعات این بسته از قبل روی پیکربندی فعال وجود داشتند."}
              </p>
            ) : null}

            {packResult.audienceNote ? (
              <p>
                <b>زمینه مخاطب:</b>{" "}
                {packResult.audienceNote.applied
                  ? "به پرامپت سیستم اضافه شد."
                  : "از قبل در پرامپت وجود داشت."}
              </p>
            ) : null}

            {packResult.sources ? (
              <div>
                <b>منابع:</b>{" "}
                {packResult.sources.message
                  ? packResult.sources.message
                  : `${packResult.sources.added ?? 0} منبع جدید اضافه شد، ${packResult.sources.skipped ?? 0} از قبل موجود بود، ${packResult.sources.failed ?? 0} منبع در دسترس نبود.`}
                {packResult.sources.results && packResult.sources.results.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {packResult.sources.results.map((item) => (
                      <li key={`${item.url}-${item.status}`} className="break-words">
                        <span
                          className={
                            item.status === "added"
                              ? "text-ok-ink"
                              : item.status === "failed"
                                ? "text-danger-ink"
                                : "text-muted"
                          }
                        >
                          {item.status === "added" ? "✓" : item.status === "failed" ? "✕" : "•"} {item.name}
                        </span>
                        {item.status === "failed" && item.message ? ` — ${item.message}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {packResult.warnings?.map((warning) => (
              <p className="mt-1 font-semibold text-warn-ink" key={warning}>
                ⚠ {warning}
              </p>
            ))}
          </div>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-white hover:bg-accent-strong"
          onClick={() => {
            setForm(emptyForm());
            setFormErrors([]);
          }}
          type="button"
        >
          + افزودن منبع جدید
        </button>
        <button
          className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink-soft hover:bg-surface-2 disabled:opacity-50"
          disabled={busy === "run-due"}
          onClick={handleRunDue}
          type="button"
        >
          {busy === "run-due" ? "در حال دریافت..." : "دریافت منابع رسید (Due)"}
        </button>
        <button
          className="rounded-xl border border-brand-line bg-brand-soft px-4 py-2.5 text-sm font-semibold text-brand-ink hover:bg-brand-soft"
          onClick={() => setImportOpen((v) => !v)}
          type="button"
        >
          ورود دستی RSS (برای منابعی که سرور به آن‌ها دسترسی ندارد)
        </button>
      </div>

      {importOpen ? (
        <section className="rounded-2xl border border-brand-line bg-brand-soft/40 p-4">
          <p className="text-xs leading-5 text-brand-ink">
            اگر منبعی (مثل سایت‌های ایرانی میزبانی‌شده در داخل) از سرور شما قابل‌دسترس نیست: فایل RSS را با مرورگر یا
            <code className="mx-1 rounded bg-surface px-1 font-mono text-[10px]" dir="ltr">curl</code>
            دریافت کنید، کل محتوای XML را اینجا Paste کنید و وارد نمایید. دقیقاً همان مسیر پردازش (نجارسازی،
            کانونیکال، ضدتکراری، ذخیره) اجرا می‌شود و هیچ ارسالی انجام نمی‌گیرد.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-[240px_1fr]">
            <select
              className="h-10 rounded-lg border border-line bg-surface px-3 text-sm"
              onChange={(e) => setImportSourceId(e.target.value)}
              value={importSourceId}
            >
              <option value="">بدون اتصال به منبع (ورود مستقل)</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  اتصال به: {s.name}
                </option>
              ))}
            </select>
            <textarea
              className="min-h-28 rounded-lg border border-line bg-surface p-3 font-mono text-xs"
              dir="ltr"
              onChange={(e) => setImportXml(e.target.value)}
              placeholder="<rss> … کل XML فید را اینجا بچسبانید … </rss>"
              value={importXml}
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              className="rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white hover:bg-brand-strong disabled:opacity-50"
              disabled={importBusy || !importXml.trim()}
              onClick={handleImport}
              type="button"
            >
              {importBusy ? "در حال ورود..." : "ورود به پایگاه داده"}
            </button>
            {importResult ? (
              <span className={`text-xs font-bold ${importResult.kind === "ok" ? "text-ok-ink" : "text-danger-ink"}`}>
                {importResult.text}
              </span>
            ) : null}
          </div>
        </section>
      ) : null}

      {pageMessage ? (
        <p
          className={`rounded-xl border px-4 py-3 text-sm ${
            pageMessage.kind === "ok" ? "border-ok-line bg-ok-soft text-ok-ink" : "border-danger-line bg-danger-soft text-danger-ink"
          }`}
        >
          {pageMessage.text}
        </p>
      ) : null}

      {!form ? (
        <section className="rounded-2xl border border-ok-line bg-ok-soft/40 p-4">
          <h2 className="text-sm font-bold text-ink">منابع پیشنهادی حوزهٔ اعتبارسنجی و اقتصاد</h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            یک منبع را انتخاب کنید تا فرم افزودن با مشخصات آن پر شود؛ قبل از ذخیره حتماً «تست اتصال» را بزنید.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {PRESET_SOURCES.map((preset) => (
              <button
                key={preset.url}
                className="rounded-lg border border-ok-line bg-surface px-3 py-1.5 text-xs font-medium text-ok-ink hover:bg-ok-soft"
                onClick={() =>
                  setForm({
                    ...emptyForm(),
                    name: preset.name,
                    url: preset.url,
                    category: preset.category,
                  })
                }
                title={preset.note}
                type="button"
              >
                + {preset.name}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {form ? (
        <section className="rounded-2xl border border-accent-line bg-accent-soft/30 p-5">
          <h2 className="text-sm font-bold text-ink">{form.id ? "ویرایش منبع" : "منبع جدید"}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <FieldInput label="نام منبع" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">نوع</label>
              <select
                className="w-full rounded-lg border border-line px-3 py-2 text-sm"
                onChange={(e) => setForm({ ...form, type: e.target.value === "api" ? "api" : "rss" })}
                value={form.type}
              >
                <option value="rss">RSS</option>
                <option value="api">API (به‌زودی)</option>
              </select>
            </div>
            <FieldInput label="آدرس فید (URL)" value={form.url} onChange={(v) => setForm({ ...form, url: v })} dir="ltr" />
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">اولویت (۱=بالاترین)</label>
              <select
                className="w-full rounded-lg border border-line px-3 py-2 text-sm"
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                value={form.priority}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <FieldInput label="دسته پیش‌فرض (اختیاری)" value={form.category} onChange={(v) => setForm({ ...form, category: v })} />
            <FieldInput label="فاصله دریافت (دقیقه)" value={String(form.fetchIntervalMinutes)} onChange={(v) => setForm({ ...form, fetchIntervalMinutes: Number(v) || 30 })} type="number" />
            <FieldInput label="حداکثر آیتم هر دریافت" value={String(form.maxItemsPerFetch)} onChange={(v) => setForm({ ...form, maxItemsPerFetch: Number(v) || 50 })} type="number" />
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-muted">توضیحات</label>
              <input
                className="w-full rounded-lg border border-line px-3 py-2 text-sm"
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                value={form.description}
              />
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input checked={form.active} className="h-4 w-4 accent-blue-600" onChange={(e) => setForm({ ...form, active: e.target.checked })} type="checkbox" />
              فعال
            </label>
          </div>

          {formErrors.length > 0 ? (
            <ul className="mt-3 space-y-1 rounded-lg border border-danger-line bg-danger-soft p-3 text-xs text-danger-ink">
              {formErrors.map((err, i) => (
                <li key={i}>• {err}</li>
              ))}
            </ul>
          ) : null}

          <div className="mt-4 flex gap-2">
            <button className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-strong disabled:opacity-50" disabled={busy === "form"} onClick={handleSubmit} type="button">
              {busy === "form" ? "در حال ذخیره..." : "ذخیره"}
            </button>
            <button className="rounded-xl border border-line px-4 py-2 text-sm text-muted hover:bg-surface-2" onClick={() => setForm(null)} type="button">
              انصراف
            </button>
          </div>
        </section>
      ) : null}

      {loading ? (
        <p className="text-sm text-faint">در حال بارگذاری...</p>
      ) : sources.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line bg-surface-2/70 p-10 text-center text-sm text-muted">
          هنوز منبعی ثبت نشده است. روی «افزودن منبع جدید» بزنید.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line/80 bg-surface shadow-sm">
          <table className="w-full min-w-[900px] text-right text-sm">
            <thead>
              <tr className="border-b border-line-soft text-xs text-muted">
                <th className="p-3 font-medium">منبع</th>
                <th className="p-3 font-medium">سلامت</th>
                <th className="p-3 font-medium">اولویت</th>
                <th className="p-3 font-medium">آمار (یافته/پذیرفته/تکراری)</th>
                <th className="p-3 font-medium">آخرین تلاش / موفق</th>
                <th className="p-3 font-medium">عملیات</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr className="border-b border-line-soft align-top last:border-0" key={source.id}>
                  <td className="p-3">
                    <p className="font-bold text-ink">{source.name}</p>
                    <p className="mt-0.5 max-w-[280px] truncate font-mono text-[11px] text-faint" dir="ltr" title={source.url}>
                      {source.url}
                    </p>
                    <p className="mt-1 text-[11px] text-faint">
                      {source.type.toUpperCase()} · هر {source.fetchIntervalMinutes} دقیقه
                    </p>
                  </td>
                  <td className="p-3">
                    <StatusBadge tone={HEALTH_TONE[source.health]}>{HEALTH_LABEL[source.health]}</StatusBadge>
                    {source.healthDetail ? (
                      <p className="mt-1 max-w-[220px] text-[11px] leading-5 text-warn-ink">{source.healthDetail}</p>
                    ) : null}
                    {source.lastItemCount !== null ? (
                      <p className="mt-1 text-[11px] text-faint">
                        آخرین دریافت: {source.lastItemCount} آیتم
                        {source.lastNewestPublishedAt ? ` · تازه‌ترین خبر: ${formatTime(source.lastNewestPublishedAt)}` : ""}
                      </p>
                    ) : null}
                    {source.errorCount > 0 ? <p className="mt-1 text-[11px] text-danger-ink">خطاهای متوالی/کل: {source.errorCount}</p> : null}
                    {source.lastError ? (
                      <p className="mt-1 max-w-[220px] truncate text-[11px] text-faint" title={source.lastError}>
                        {source.lastError}
                      </p>
                    ) : null}
                  </td>
                  <td className="p-3 text-muted">{source.priority}</td>
                  <td className="p-3 text-xs text-muted">
                    {source.totalFetched} / {source.totalAccepted} / {source.totalDuplicates}
                  </td>
                  <td className="p-3 text-xs text-muted">
                    <p>تلاش: {formatTime(source.lastAttemptAt)}</p>
                    <p className="mt-0.5">موفق: {formatTime(source.lastSuccessAt)}</p>
                  </td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1.5">
                      <MiniButton disabled={busy !== null} onClick={() => handleTest(source)}>
                        تست
                      </MiniButton>
                      <MiniButton disabled={busy !== null} primary onClick={() => handleFetch(source)}>
                        {busy === `fetch-${source.id}` ? "..." : "دریافت فوری"}
                      </MiniButton>
                      <MiniButton disabled={busy !== null} onClick={() => handleToggle(source)}>
                        {source.active ? "غیرفعال" : "فعال"}
                      </MiniButton>
                      <MiniButton
                        disabled={busy !== null}
                        onClick={() =>
                          setForm({
                            id: source.id,
                            name: source.name,
                            type: source.type === "api" ? "api" : "rss",
                            url: source.url,
                            description: source.description ?? "",
                            category: source.category ?? "",
                            priority: source.priority,
                            active: source.active,
                            fetchIntervalMinutes: source.fetchIntervalMinutes,
                            maxItemsPerFetch: source.maxItemsPerFetch,
                          })
                        }
                      >
                        ویرایش
                      </MiniButton>
                      <MiniButton danger disabled={busy !== null} onClick={() => handleDelete(source)}>
                        حذف
                      </MiniButton>
                    </div>
                    {fetchReports[source.id] ? <p className="mt-2 max-w-[260px] text-[11px] text-muted">{fetchReports[source.id]}</p> : null}
                    {testResults[source.id] ? <TestResultView result={testResults[source.id]} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="rounded-2xl border border-line/80 bg-surface p-5 shadow-sm">
        <h2 className="text-base font-bold text-ink">تاریخچه دریافت‌ها (Ingestion Log)</h2>
        {runs.length === 0 ? (
          <p className="mt-3 text-sm text-faint">هنوز رکوردی ثبت نشده است.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {runs.slice(0, 15).map((run) => (
              <li className="flex flex-wrap items-center gap-3 rounded-xl border border-line-soft bg-surface-2/60 px-3 py-2 text-xs" key={run.id}>
                <StatusBadge tone={run.status === "success" ? "success" : run.status === "partial" ? "warning" : "danger"}>
                  {run.status === "success" ? "موفق" : run.status === "partial" ? "ناقص" : "ناموفق"}
                </StatusBadge>
                <span className="text-faint">{formatTime(run.startedAt)}</span>
                <span>
                  یافته: {run.itemsFound} · جدید: {run.itemsCreated}
                  {run.itemsFiltered ? ` · خارج از موضوع: ${run.itemsFiltered}` : ""} · تکراری: {run.duplicates} · خطا: {run.errors}
                </span>
                {run.errorMessage ? <span className="max-w-[400px] truncate text-danger-ink" title={run.errorMessage}>{run.errorMessage}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TestResultView({ result }: { result: TestResult }) {
  return (
    <div className={`mt-2 rounded-lg border p-2.5 text-[11px] ${result.ok ? "border-ok-line bg-ok-soft text-ok-ink" : "border-danger-line bg-danger-soft text-danger-ink"}`}>
      {result.ok ? (
        <>
          <p className="font-bold">
            اتصال موفق ✓ — {result.feedTitle} ({result.itemCount} آیتم، {result.elapsedMs}ms)
          </p>
          {result.sample && result.sample.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {result.sample.slice(0, 3).map((s, i) => (
                <li className="truncate" key={i} title={s.title}>
                  • {s.title}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p>
          اتصال ناموفق: {result.message}
          {result.detail ? <span className="mt-0.5 block opacity-80" dir="ltr">{result.detail}</span> : null}
        </p>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" | "danger" }) {
  const toneClass = tone === "success" ? "text-ok-ink" : tone === "warning" ? "text-warn-ink" : tone === "danger" ? "text-danger-ink" : "text-ink";
  return (
    <div className="rounded-2xl border border-line/80 bg-surface px-4 py-3 shadow-sm">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-xl font-bold ${toneClass}`}>{value}</p>
    </div>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  type = "text",
  dir,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  dir?: "ltr";
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted">{label}</label>
      <input
        className={`w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-accent focus:outline-none ${dir === "ltr" ? "font-mono text-xs" : ""}`}
        dir={dir}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        value={value}
      />
    </div>
  );
}

function MiniButton({
  children,
  onClick,
  disabled,
  primary,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  const cls = primary
    ? "bg-accent text-white hover:bg-accent-strong"
    : danger
      ? "border border-danger-line bg-surface text-danger-ink hover:bg-danger-soft"
      : "border border-line bg-surface text-muted hover:bg-surface-2";
  return (
    <button className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition-colors disabled:opacity-40 ${cls}`} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  );
}
