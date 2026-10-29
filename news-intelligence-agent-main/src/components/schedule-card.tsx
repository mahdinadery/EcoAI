"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { buildIntervalTimes, detectInterval, intervalLabel } from "@/lib/agent/interval-times";
import { describeRejectionReasons } from "@/lib/agent/rejection-reasons";
import { diagnoseRunSummary } from "@/lib/agent/run-diagnosis";
import { StatusBadge } from "./status-badge";

type Destination = "local" | "bale" | "both";

type PublishMode = "single" | "bulletin" | "both";

type ScheduleConfig = {
  enabled: boolean;
  timezone: string;
  times: string[];
  destination: Destination;
  minImportance: number;
  minRelevance: number;
  minNovelty: number;
  requireAiRecommendation: boolean;
  maxAnalyze: number;
  maxSend: number;
  gapSearchEnabled: boolean;
  gapSearchQueries: string[];
  publishMode: PublishMode;
  bulletinTimes: string[];
};

type RunSummary = {
  ok: boolean;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  slotKey: string | null;
  ingest: { attempted: boolean; sources: number; created: number; duplicates: number; failed: number; detail?: string } | null;
  analysis: { selected: number; analyzed: number; failed: number; skippedOfftopic: number } | null;
  send: {
    enabled: boolean;
    destination: string;
    considered: number;
    matched: number;
    sent: number;
    skippedDuplicates: number;
    skippedReview: number;
    failed: number;
    rejected?: Array<{ title: string; reasons: string[] }>;
  } | null;
  gapSearch?: {
    ran: boolean;
    reason: string | null;
    detail?: string;
    queries: string[];
    found: number;
    analyzed: number;
    sent: number;
  } | null;
  bulletin?: {
    attempted: boolean;
    sent: boolean;
    itemCount: number;
    reason: string | null;
  } | null;
  errors: string[];
};

type ApiResponse = {
  success: boolean;
  config?: ScheduleConfig;
  status?: {
    persisted: boolean;
    enabled: boolean;
    nextRunAt: string | null;
    nextRunSlot: string | null;
    lastRunAt: string | null;
    lastRunSlot: string | null;
    lastResult: RunSummary | null;
    dueReason?: string;
    running?: boolean;
    lastTickAt?: string | null;
    cronStale?: boolean;
  };
  destinationsReady?: { local: boolean; bale: boolean };
  baleMissing?: string[];
  description?: string[];
  message?: string;
  /** Actionable cause (e.g. the DNS/hostaddr recipe) when a save fails. */
  hint?: string;
  errors?: string[];
  summary?: RunSummary;
};

const TIMEZONES = [
  "Asia/Tehran",
  "UTC",
  "Europe/Berlin",
  "Europe/London",
  "Asia/Dubai",
  "Asia/Istanbul",
  "America/New_York",
];

const DESTINATION_LABELS: Record<Destination, string> = {
  bale: "بله (کانال/چت)",
  local: "صندوق محلی (بدون ارسال واقعی)",
  both: "بله + صندوق محلی",
};

const DIAGNOSIS_TONES = {
  success: "border-ok-line bg-ok-soft text-ok-ink",
  warning: "border-warn-line bg-warn-soft text-warn-ink",
  error: "border-danger-line bg-danger-soft text-danger-ink",
  info: "border-accent bg-accent-soft text-accent-ink",
} as const;

function authHeaders(adminKey: string): Record<string, string> {
  return adminKey ? { "x-admin-key": adminKey } : {};
}

function formatInZone(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return date.toLocaleString("fa-IR", { timeZone, dateStyle: "medium", timeStyle: "short" });
  } catch {
    return date.toLocaleString("fa-IR");
  }
}

const INTERVAL_PRESETS = [15, 30, 60, 120];

function defaultConfig(): ScheduleConfig {
  return {
    enabled: false,
    timezone: "Asia/Tehran",
    times: ["08:00"],
    destination: "bale",
    minImportance: 50,
    minRelevance: 50,
    minNovelty: 0,
    requireAiRecommendation: false,
    maxAnalyze: 8,
    maxSend: 10,
    gapSearchEnabled: false,
    gapSearchQueries: [],
    publishMode: "single",
    bulletinTimes: ["08:00", "14:00"],
  };
}

/** API rows may carry null for the manual query list; the form keeps arrays. */
function normalizeLoadedConfig(config: ScheduleConfig): ScheduleConfig {
  return {
    ...config,
    gapSearchQueries: config.gapSearchQueries ?? [],
    bulletinTimes: config.bulletinTimes ?? ["08:00", "14:00"],
  };
}

export function ScheduleCard({
  adminKey = "",
  onRunComplete,
}: {
  adminKey?: string;
  onRunComplete?: () => void;
}) {
  const [config, setConfig] = useState<ScheduleConfig>(defaultConfig);
  const [status, setStatus] = useState<ApiResponse["status"] | null>(null);
  const [baleReady, setBaleReady] = useState<boolean | null>(null);
  const [baleMissing, setBaleMissing] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [timesEditing, setTimesEditing] = useState(false);
  // Auto-save bookkeeping («کلیک = اعمال») — declared early because `load`
  // hydrates it.
  const [hydrated, setHydrated] = useState(false);
  const [lastSavedJson, setLastSavedJson] = useState<string | null>(null);

  const load = useCallback(() => {
    return fetch("/api/agent/scheduler", { cache: "no-store" })
      .then((response) => response.json() as Promise<ApiResponse>)
      .then((data) => {
        if (data.success && data.config) {
          const normalized = normalizeLoadedConfig(data.config);
          setLastSavedJson(JSON.stringify(normalized));
          setHydrated(true);
          setConfig(normalized);
          setStatus(data.status ?? null);
          setBaleReady(Boolean(data.destinationsReady?.bale));
          setBaleMissing(data.baleMissing ?? []);
          setLastRun(data.status?.lastResult ?? null);
        }
      })
      .catch(() => {
        setMessage({ kind: "err", text: "بارگذاری وضعیت زمان‌بندی ناموفق بود." });
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const nextRunLabel = useMemo(
    () => formatInZone(status?.nextRunAt ?? null, config.timezone),
    [status?.nextRunAt, config.timezone],
  );

  const interval = useMemo(() => detectInterval(config.times), [config.times]);
  const diagnosis = useMemo(() => diagnoseRunSummary(lastRun), [lastRun]);

  function updateTime(index: number, value: string) {
    setConfig((prev) => {
      const times = [...prev.times];
      times[index] = value;
      return { ...prev, times };
    });
  }

  function addTime() {
    setConfig((prev) => ({ ...prev, times: [...prev.times, "18:00"] }));
  }

  function removeTime(index: number) {
    setConfig((prev) => ({ ...prev, times: prev.times.filter((_, i) => i !== index) }));
  }

  // ── Auto-save («کلیک = اعمال») ──────────────────────────────────────────
  // Every change is persisted shortly after the last edit, so settings survive
  // a page refresh even if the operator never presses the save button.
  // `persist` takes the snapshot as a parameter so its memoization stays stable
  // (react-hooks compiler rules require this shape).
  const persist = useCallback(
    async (snapshot: ScheduleConfig, silent: boolean) => {
      setSaving(true);
      if (!silent) setMessage(null);

      try {
        const response = await fetch("/api/agent/scheduler", {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
          body: JSON.stringify(snapshot),
        });
        const data = (await response.json()) as ApiResponse;

        if (!response.ok || !data.success) {
          const details = data.errors?.length ? ` — ${data.errors.join(" · ")}` : "";
          const hint = data.hint ? `\n${data.hint}` : "";
          setMessage({
            kind: "err",
            text:
              response.status === 401
                ? "برای ذخیرهٔ زمان‌بندی باید کلید مدیریتی را وارد کرده باشید. یک‌بار با ?key=... وارد داشبورد شوید یا از صفحه «پیکربندی AI» کلید را وارد کنید."
                : `${data.message ?? "ذخیره زمان‌بندی ناموفق بود."}${details}${hint}`,
          });
          return;
        }

        if (data.config) {
          const normalized = normalizeLoadedConfig(data.config);
          setLastSavedJson(JSON.stringify(normalized));
          setConfig(normalized);
        }
        setStatus(data.status ?? null);
        if (silent) {
          setMessage(null);
        } else {
          setMessage({ kind: "ok", text: "زمان‌بندی ذخیره شد. اجرای خودکار از نوبت بعدی فعال است." });
        }
      } catch {
        setMessage({ kind: "err", text: "ارتباط با سرور برقرار نشد؛ ذخیره انجام نشد." });
      } finally {
        setSaving(false);
      }
    },
    [adminKey],
  );

  useEffect(() => {
    if (!hydrated) return;
    // Nothing changed since the last save (e.g. server echo) => skip.
    if (lastSavedJson !== null && JSON.stringify(config) === lastSavedJson) return;
    const timer = setTimeout(() => {
      void persist(config, true);
    }, 1200);
    return () => clearTimeout(timer);
  }, [config, hydrated, lastSavedJson, persist]);

  const dirty = hydrated && lastSavedJson !== null && JSON.stringify(config) !== lastSavedJson;

  async function handleSave() {
    if (saving) return;
    await persist(config, false);
  }

  const [bulletinRunning, setBulletinRunning] = useState(false);

  async function handleRunBulletin() {
    if (bulletinRunning) return;
    setBulletinRunning(true);
    setMessage(null);

    try {
      const response = await fetch("/api/agent/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
        body: JSON.stringify({ kind: "bulletin" }),
      });
      const data = (await response.json()) as ApiResponse;

      if (!response.ok || !data.success || !data.summary) {
        setMessage({
          kind: "err",
          text:
            response.status === 401
              ? "ارسال بولتن به کلید مدیریتی نیاز دارد (یک‌بار با ?key=... وارد شوید)."
              : data.message ?? "ارسال بولتن ناموفق بود.",
        });
        return;
      }

      setLastRun(data.summary);
      const bulletin = data.summary.bulletin;
      const reasonLabel =
        bulletin?.reason === "no_qualifying_items"
          ? "خبر واجد شرایط نبود"
          : bulletin?.reason === "nothing_new"
            ? "خبر تازه‌ای نبود"
            : bulletin?.reason === "delivery_failed"
              ? "ارسال ناموفق بود"
              : (bulletin?.reason ?? "—");
      setMessage({
        kind: bulletin?.sent ? "ok" : "err",
        text: bulletin?.sent
          ? `بولتن با ${bulletin.itemCount.toLocaleString("fa-IR")} خبر ارسال شد.`
          : `بولتن ارسال نشد (${reasonLabel}).`,
      });
    } catch {
      setMessage({ kind: "err", text: "ارتباط با سرور برقرار نشد." });
    } finally {
      setBulletinRunning(false);
    }
  }

  async function handleRunNow() {
    if (running) return;
    setRunning(true);
    setMessage(null);

    try {
      const response = await fetch("/api/agent/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
        body: "{}",
      });
      const data = (await response.json()) as ApiResponse;

      if (!response.ok || !data.success || !data.summary) {
        setMessage({
          kind: "err",
          text:
            response.status === 401
              ? "اجرای فوری به کلید مدیریتی نیاز دارد (یک‌بار با ?key=... وارد شوید)."
              : data.message ?? "اجرای فوری ناموفق بود.",
        });
        return;
      }

      setLastRun(data.summary);
      setMessage({
        kind: data.summary.ok ? "ok" : "err",
        text: `اجرای فوری تمام شد: ${data.summary.analysis?.analyzed ?? 0} تحلیل، ${data.summary.send?.sent ?? 0} ارسال${
          data.summary.errors.length > 0 ? ` — ${data.summary.errors.length} خطا` : ""
        }.`,
      });
      onRunComplete?.();
      void load();
    } catch {
      setMessage({ kind: "err", text: "ارتباط با سرور برقرار نشد." });
    } finally {
      setRunning(false);
    }
  }

  const enabledCount = config.times.filter(Boolean).length;

  return (
    <section
      aria-labelledby="schedule-heading"
      className="mt-6 rounded-2xl border border-accent/80 bg-surface p-5 shadow-sm shadow-accent-line/50 sm:p-6"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-4">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent text-white shadow-md shadow-accent/20">
            <svg aria-hidden="true" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M12 7v5l3.2 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-ink" id="schedule-heading">
                ارسال خودکار زمان‌بندی‌شده (تحلیل + بله)
              </h2>
              <StatusBadge tone={config.enabled ? "success" : "muted"}>
                {config.enabled ? "زمان‌بندی فعال" : "خاموش"}
              </StatusBadge>
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
              در هر زمان مشخص، خبرهای تازه دریافت، تحلیل و در صورت عبور از حد نصاب‌ها بدون تأیید دستی به بله ارسال
              می‌شوند. نوبت‌ها به وقت <b className="text-ink-soft">{config.timezone}</b> اجرا می‌شوند و اجرای تکراری
              همان نوبت ممکن نیست.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className={`rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm transition-all ${
              running ? "cursor-not-allowed bg-surface-3 text-faint" : "bg-accent text-white hover:bg-accent-strong"
            }`}
            disabled={running}
            onClick={handleRunNow}
            type="button"
          >
            {running ? "در حال اجرا…" : "اجرای فوری چرخه کامل"}
          </button>
          <button
            className="rounded-xl border border-accent bg-accent-soft px-4 py-2.5 text-sm font-bold text-accent-ink transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60"
            disabled={saving}
            onClick={handleSave}
            type="button"
          >
            {saving ? "در حال ذخیره…" : "ذخیره زمان‌بندی"}
          </button>
          <span className={`text-xs ${dirty ? "text-warn-ink" : "text-ok-ink"}`}>
            {saving
              ? "در حال ذخیره…"
              : dirty
                ? "تغییرات به‌صورت خودکار ذخیره می‌شوند…"
                : lastSavedJson
                  ? "همهٔ تغییرات ذخیره شد ✓"
                  : ""}
          </span>
        </div>
      </div>

      {status && status.persisted === false ? (
        <p className="mt-4 whitespace-pre-line rounded-xl border border-warn-line bg-warn-soft px-4 py-3 text-sm leading-6 text-warn-ink">
          {
            "⚠️ تنظیمات هنوز در پایگاه داده ذخیره نشده است — احتمالاً اتصال به پایگاه داده برقرار نیست. تا زمان رفع، تغییرات فقط در همین صفحه می‌ماند."
          }
        </p>
      ) : null}

      {message ? (
        <p
          className={`mt-4 whitespace-pre-line rounded-xl border px-4 py-3 text-sm leading-6 ${
            message.kind === "ok"
              ? "border-ok-line bg-ok-soft text-ok-ink"
              : "border-danger-line bg-danger-soft text-danger-ink"
          }`}
        >
          {message.text}
        </p>
      ) : null}

      <div
        className={`mt-4 rounded-xl border p-4 ${
          status?.cronStale ? "border-warn-line bg-warn-soft" : "border-accent-line bg-accent-soft/50"
        }`}
      >
        <p className="text-sm font-bold text-ink-soft">⏱️ کار پیوسته بدون باز بودن صفحه</p>
        <p className="mt-1 text-xs leading-5 text-muted">
          این سامانه روی سرور اجرا می‌شود؛ کرون GitHub Actions هر ۵ دقیقه سرور را صدا می‌زند و ارسال‌ها بدون باز بودن
          این صفحه انجام می‌شوند. وضعیت زیر ثابت می‌کند کرون واقعاً در حال تماس است.
        </p>
        <p className="mt-2 text-xs leading-5">
          {status?.lastTickAt ? (
            <span className={status.cronStale ? "font-bold text-warn-ink" : "text-ok-ink"}>
              ضربان کرون: آخرین تماس {formatInZone(status.lastTickAt, config.timezone)}
              {status.cronStale ? " — بیش از ۱۵ دقیقه بی‌تماس!" : " ✓"}
            </span>
          ) : (
            <span className="font-bold text-warn-ink">هنوز هیچ تماسی از کرون خارجی ثبت نشده است.</span>
          )}
        </p>
        {status?.cronStale ? (
          <p className="mt-2 text-xs leading-5 text-warn-ink">
            برای فعال‌سازی: در مخزن GitHub ← Settings ← Secrets and variables ← Actions دو متغیر{" "}
            <code className="rounded bg-surface px-1 font-mono text-[10px]" dir="ltr">
              APP_URL
            </code>{" "}
            (آدرس Render بدون انتهای <code dir="ltr">/</code>) و{" "}
            <code className="rounded bg-surface px-1 font-mono text-[10px]" dir="ltr">
              ADMIN_ACCESS_KEY
            </code>{" "}
            را ست کنید و در تب Actions ورک‌فلوی «Scheduled auto-publish» را فعال نگه دارید. توجه: GitHub پس از حدود ۶۰
            روز فعالیت‌نبودن مخزن، cron‌های زمان‌بندی‌شده را خودکار غیرفعال می‌کند.
          </p>
        ) : null}
      </div>

      <div className="mt-5 grid gap-4 border-t border-line-soft pt-4 lg:grid-cols-3">
        <div className="rounded-xl bg-surface-2 p-3.5">
          <p className="text-xs font-semibold text-muted">وضعیت</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-bold text-ink-soft">
              <input
                checked={config.enabled}
                className="h-4 w-4 accent-sky-600"
                onChange={(event) => setConfig({ ...config, enabled: event.target.checked })}
                type="checkbox"
              />
              فعال باشد
            </label>
          </div>
          <p className="mt-2 text-xs text-muted">
            نوبت بعدی: <b className="text-ink-soft">{config.enabled ? nextRunLabel : "—"}</b>
          </p>
        </div>

        <div className="rounded-xl bg-surface-2 p-3.5">
          <p className="text-xs font-semibold text-muted">مقصد ارسال خودکار</p>
          <select
            className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none"
            onChange={(event) => setConfig({ ...config, destination: event.target.value as Destination })}
            value={config.destination}
          >
            {(Object.keys(DESTINATION_LABELS) as Destination[]).map((value) => (
              <option key={value} value={value}>
                {DESTINATION_LABELS[value]}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-muted">
            بله:{" "}
            {baleReady ? (
              <b className="text-ok-ink">آماده ✓</b>
            ) : (
              <b className="text-danger-ink">
                تنظیم نشده{baleMissing.length > 0 ? ` (${baleMissing.join(", ")})` : ""}
              </b>
            )}
          </p>
        </div>

        <div className="rounded-xl bg-surface-2 p-3.5">
          <p className="text-xs font-semibold text-muted">آخرین اجرا</p>
          <p className="mt-2 text-xs text-muted">
            {lastRun ? (
              <>
                {formatInZone(lastRun.startedAt, config.timezone)}
                <span className="mx-1 text-faint">·</span>
                <span className={lastRun.ok ? "text-ok-ink" : "text-warn-ink"}>
                  {lastRun.send?.sent ?? 0} ارسال / {lastRun.analysis?.analyzed ?? 0} تحلیل
                  {lastRun.bulletin ? (
                    <span className="mr-2 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted">
                      {lastRun.bulletin.sent
                        ? `بولتن: ${lastRun.bulletin.itemCount} خبر ارسال شد`
                        : `بولتن ارسال نشد (${lastRun.bulletin.reason ?? "—"})`}
                    </span>
                  ) : null}
                  {lastRun.gapSearch ? (
                    <span className="mr-2 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted">
                      {lastRun.gapSearch.ran
                        ? `جست‌وجوی هدفمند: ${lastRun.gapSearch.found} یافت / ${lastRun.gapSearch.analyzed} تحلیل / ${lastRun.gapSearch.sent} ارسال`
                        : `جست‌وجوی هدفمند اجرا نشد (${lastRun.gapSearch.reason ?? "—"}${lastRun.gapSearch.detail ? `: ${lastRun.gapSearch.detail}` : ""})`}
                    </span>
                  ) : null}
                </span>
              </>
            ) : (
              "هنوز اجرا نشده است"
            )}
          </p>
          <p className="mt-2 text-[11px] leading-5 text-faint">
            اجرای خودکار فقط وقتی رخ می‌دهد که این کارت ذخیره و فعال شده باشد و کرون بیرونی هر چند دقیقه یک‌بار تیک
            بزند.
          </p>
        </div>
      </div>

      {diagnosis ? (
        <div className={`mt-4 rounded-xl border px-4 py-3 text-xs leading-6 ${DIAGNOSIS_TONES[diagnosis.level]}`}>
          <p className="font-bold">{diagnosis.title}</p>
          {diagnosis.hints.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pr-4">
              {diagnosis.hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {lastRun?.send?.rejected && lastRun.send.rejected.length > 0 ? (
        <details className="mt-3 rounded-xl border border-line bg-surface-2/70 p-3 text-xs text-ink-soft">
          <summary className="cursor-pointer font-bold">
            چرا خبری ارسال نشد؟ ({lastRun.send.rejected.length} نمونه از خبرهای ردشده)
          </summary>
          <ul className="mt-2 space-y-1">
            {lastRun.send.rejected.map((item, index) => (
              <li className="break-words" key={`${item.title}-${index}`}>
                • <b>{item.title}</b> — {describeRejectionReasons(item.reasons)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-5 text-faint">
            برای ارسال، همهٔ حد نصاب‌ها (اهمیت، مرتبط بودن و در صورت تنظیم تازگی) باید هم‌زمان برقرار باشند. حد
            نصاب‌ها را در «تنظیمات پیشرفته» و کلیدواژه‌های ممنوع را در «پیکربندی AI» تنظیم کنید.
          </p>
        </details>
      ) : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-ink-soft">زمان‌های اجرا (به وقت {config.timezone})</p>
            <button
              className="rounded-lg border border-line px-2.5 py-1 text-xs font-bold text-muted hover:bg-surface-2"
              onClick={() => {
                addTime();
                setTimesEditing(true);
              }}
              type="button"
            >
              + افزودن زمان
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-muted">تکرار سریع:</span>
            {INTERVAL_PRESETS.map((minutes) => (
              <button
                className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                  interval === minutes
                    ? "border-accent bg-accent-soft text-accent-ink"
                    : "border-line bg-surface-2 text-muted hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
                }`}
                key={minutes}
                onClick={() => {
                  setConfig({ ...config, times: buildIntervalTimes(minutes) });
                  setTimesEditing(false);
                }}
                type="button"
              >
                {intervalLabel(minutes)}
              </button>
            ))}
          </div>

          {interval && !timesEditing ? (
            <div className="mt-2 rounded-lg border border-ok-line bg-ok-soft px-3 py-2 text-xs leading-6 text-ok-ink">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  زمان‌بندی فعلی: <b>{intervalLabel(interval)}</b> ({config.times.length} نوبت در روز)
                </span>
                <button
                  className="rounded-md border border-ok-line bg-surface px-2 py-0.5 text-[11px] font-bold text-ok-ink hover:bg-ok-soft"
                  onClick={() => setTimesEditing(true)}
                  type="button"
                >
                  ویرایش دستی زمان‌ها
                </button>
              </div>
              <p className="mt-1 text-[11px] text-ok-ink/80">
                در هر نوبت، خبرهای تازه تحلیل می‌شوند و فقط در صورت وجود خبر واجد شرایط ارسالی انجام می‌شود.
              </p>
            </div>
          ) : (
            <>
              <div className="mt-2 space-y-2">
                {config.times.length === 0 ? (
                  <p className="rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-xs text-warn-ink">
                    حداقل یک زمان اضافه کنید تا زمان‌بندی بتواند اجرا شود.
                  </p>
                ) : null}
                {config.times.map((time, index) => (
                  <div className="flex items-center gap-2" key={`${index}-${time}`}>
                    <input
                      className="w-36 rounded-lg border border-line px-3 py-2 text-sm focus:border-accent focus:outline-none"
                      onChange={(event) => updateTime(index, event.target.value)}
                      step={300}
                      type="time"
                      value={time}
                    />
                    <button
                      aria-label="حذف زمان"
                      className="rounded-lg px-2 py-1.5 text-xs font-bold text-danger-ink hover:bg-danger-soft disabled:opacity-40"
                      disabled={config.times.length <= 1}
                      onClick={() => removeTime(index)}
                      type="button"
                    >
                      حذف
                    </button>
                  </div>
                ))}
              </div>

              {interval ? (
                <button
                  className="mt-2 text-[11px] font-bold text-ok-ink underline-offset-2 hover:underline"
                  onClick={() => setTimesEditing(false)}
                  type="button"
                >
                  نمایش خلاصه بازه
                </button>
              ) : null}
            </>
          )}

          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-medium text-muted">منطقه زمانی</span>
            <select
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none"
              onChange={(event) => setConfig({ ...config, timezone: event.target.value })}
              value={config.timezone}
            >
              {(TIMEZONES.includes(config.timezone) ? TIMEZONES : [config.timezone, ...TIMEZONES]).map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="rounded-xl border border-line p-4">
          <button
            className="flex w-full items-center justify-between text-sm font-bold text-ink-soft"
            onClick={() => setAdvancedOpen((value) => !value)}
            type="button"
          >
            <span>تنظیمات پیشرفته (حد نصاب‌ها و حجم هر اجرا)</span>
            <span className="text-faint">{advancedOpen ? "−" : "+"}</span>
          </button>

          {advancedOpen ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <NumberField
                label="حداقل اهمیت"
                max={100}
                min={0}
                onChange={(value) => setConfig({ ...config, minImportance: value })}
                value={config.minImportance}
              />
              <NumberField
                label="حداقل مرتبط بودن"
                max={100}
                min={0}
                onChange={(value) => setConfig({ ...config, minRelevance: value })}
                value={config.minRelevance}
              />
              <NumberField
                label="حداقل تازگی"
                max={100}
                min={0}
                onChange={(value) => setConfig({ ...config, minNovelty: value })}
                value={config.minNovelty}
              />
              <NumberField
                label="حداکثر تحلیل در هر اجرا"
                max={30}
                min={1}
                onChange={(value) => setConfig({ ...config, maxAnalyze: value })}
                value={config.maxAnalyze}
              />
              <NumberField
                label="حداکثر ارسال در هر اجرا"
                max={50}
                min={1}
                onChange={(value) => setConfig({ ...config, maxSend: value })}
                value={config.maxSend}
              />
              <label className="flex items-start gap-2 text-xs leading-5 text-muted sm:col-span-2">
                <input
                  checked={config.requireAiRecommendation}
                  className="mt-0.5 h-4 w-4 accent-sky-600"
                  onChange={(event) => setConfig({ ...config, requireAiRecommendation: event.target.checked })}
                  type="checkbox"
                />
                <span>
                  فقط خبرهایی ارسال شوند که هوش مصنوعی هم صریحاً ارسال را توصیه کرده است (
                  <code className="rounded bg-surface-3 px-1 font-mono text-[10px]" dir="ltr">
                    shouldSend = true
                  </code>
                  ).
                </span>
              </label>
            </div>
          ) : (
            <p className="mt-2 text-xs leading-6 text-muted">
              پیش‌فرض: اهمیت ≥ {config.minImportance}٪، مرتبط بودن ≥ {config.minRelevance}٪، حداکثر{" "}
              {config.maxAnalyze} تحلیل و {config.maxSend} ارسال در هر نوبت.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-line p-4">
          <h3 className="text-sm font-bold text-ink-soft">جست‌وجوی هدفمند (پر کردن شکاف پوشش)</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            وقتی در یک نوبت هیچ خبری ارسال نشود، بازو خودش دنبال موضوعات پوشش می‌گردد، نتایج را از همان فیلتر
            موضوعی و قانون سخت‌گیرانهٔ ارسال عبور می‌دهد و فقط خبرهای واجد شرایط را می‌فرستد. حداکثر ۵ آیتم در هر
            نوبت، با وقفهٔ حداقل ۳ ساعت بین جست‌وجوها.
          </p>
          <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-muted">
            <input
              checked={config.gapSearchEnabled}
              className="mt-0.5 h-4 w-4 accent-sky-600"
              onChange={(event) => setConfig({ ...config, gapSearchEnabled: event.target.checked })}
              type="checkbox"
            />
            <span>وقتی خبری برای ارسال نبود، جست‌وجوی هدفمند انجام شود.</span>
          </label>
          {config.gapSearchEnabled ? (
            <label className="mt-3 block text-xs leading-5 text-muted">
              <span className="mb-1 block font-medium text-ink-soft">
                عبارت‌های جست‌وجو (هر خط یک عبارت؛ خالی = برداشت خودکار از موضوعات پوشش)
              </span>
              <textarea
                className="min-h-[84px] w-full rounded-lg border border-line p-2 font-mono text-[12px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent-line"
                dir="rtl"
                onChange={(event) =>
                  setConfig({
                    ...config,
                    gapSearchQueries: event.target.value
                      .split(/\r?\n/)
                      .map((line) => line.trim())
                      .filter(Boolean),
                  })
                }
                placeholder={"رتبه‌بندی اعتباری / اعتبارسنجی"}
                value={config.gapSearchQueries.join("\n")}
              />
            </label>
          ) : null}
        </div>

        <div className="rounded-xl border border-line p-4">
          <h3 className="text-sm font-bold text-ink-soft">حالت انتشار</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            «بولتن»: همهٔ خبرهای واجد شرایط منتظر می‌مانند و سرِ ساعت‌های تعیین‌شده در یک پیام گواردیجست می‌شوند
            (عنوان + یک‌خطی + چرا مهم + لینک، با یک جمع‌بندی از هوش مصنوعی). «هر دو»: تک‌پیام‌ها فوری می‌روند و بولتن،
            جمع‌بندی همان خبرها در ساعت‌های بولتن است.
          </p>

          <label className="mt-3 block text-xs leading-5 text-muted">
            <span className="mb-1 block font-medium text-ink-soft">نحوهٔ انتشار در کانال</span>
            <select
              className="w-full rounded-lg border border-line p-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent-line"
              onChange={(event) => setConfig({ ...config, publishMode: event.target.value as PublishMode })}
              value={config.publishMode}
            >
              <option value="single">تک‌پیام (رفتار فعلی)</option>
              <option value="bulletin">فقط بولتن (همه منتظر بولتن می‌مانند)</option>
              <option value="both">هر دو (تک‌پیام فوری + بولتن جمع‌بندی)</option>
            </select>
          </label>

          {config.publishMode !== "single" ? (
            <div className="mt-3">
              <span className="mb-1 block text-xs font-medium text-ink-soft">
                ساعت‌های انتشار بولتن (به وقت {config.timezone})
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {config.bulletinTimes.map((time, index) => (
                  <span key={index} className="flex items-center gap-1">
                    <input
                      className="w-[72px] rounded-lg border border-line p-1.5 text-center font-mono text-xs focus:border-accent focus:outline-none"
                      dir="ltr"
                      onChange={(event) => {
                        const next = [...config.bulletinTimes];
                        next[index] = event.target.value;
                        setConfig({ ...config, bulletinTimes: next });
                      }}
                      value={time}
                    />
                    <button
                      aria-label="حذف ساعت"
                      className="rounded px-1.5 py-0.5 text-xs text-danger-ink hover:bg-danger-soft"
                      onClick={() =>
                        setConfig({
                          ...config,
                          bulletinTimes: config.bulletinTimes.filter((_, i) => i !== index),
                        })
                      }
                      type="button"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <button
                  className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2 disabled:opacity-50"
                  disabled={config.bulletinTimes.length >= 12}
                  onClick={() => setConfig({ ...config, bulletinTimes: [...config.bulletinTimes, "12:00"] })}
                  type="button"
                >
                  + افزودن ساعت
                </button>
              </div>

              <button
                className="mt-3 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent-strong disabled:opacity-50"
                disabled={bulletinRunning}
                onClick={handleRunBulletin}
                type="button"
              >
                {bulletinRunning ? "در حال ارسال بولتن..." : "ارسال فوری بولتن"}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {lastRun && lastRun.errors.length > 0 ? (
        <details className="mt-4 rounded-xl border border-warn-line bg-warn-soft/70 p-3 text-xs text-warn-ink">
          <summary className="cursor-pointer font-bold">خطاهای آخرین اجرا ({lastRun.errors.length})</summary>
          <ul className="mt-2 space-y-1">
            {lastRun.errors.map((error, index) => (
              <li key={index} className="break-words">
                • {error}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="mt-4 text-[11px] leading-5 text-faint">
        برای ارسال واقعی به بله، متغیرهای <code className="font-mono" dir="ltr">BALE_BOT_TOKEN</code> و{" "}
        <code className="font-mono" dir="ltr">BALE_CHAT_ID</code> باید روی سرور تنظیم شده باشند. اجرای زمان‌بندی‌شده
        توسط کرون بیرونی (GitHub Actions) فعال می‌شود و به باز بودن دائمی سرور نیاز ندارد.
        {loading ? " — در حال بارگذاری وضعیت…" : ""}
      </p>
    </section>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <input
        className="w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-accent focus:outline-none"
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        type="number"
        value={value}
      />
    </label>
  );
}
