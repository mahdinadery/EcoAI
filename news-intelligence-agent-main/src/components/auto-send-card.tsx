"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "./status-badge";

type RuleInfo = {
  success: boolean;
  enabled: boolean;
  destination: string;
  thresholds: { minImportance: number; minRelevance: number; minNovelty: number };
  requireAiRecommendation: boolean;
  categories: string[] | null;
  maxItemsPerPass: number;
  description: string[];
  destinationsReady: { local: boolean; bale: boolean };
  baleMissing: string[];
};

type ItemOutcome = {
  id: string;
  title: string;
  outcome: "sent" | "partially_sent" | "failed" | "already_sent" | "not_matched";
  reasons?: string[];
  errors?: string[];
};

type PassResult = {
  success: boolean;
  enabled?: boolean;
  destination?: string;
  considered?: number;
  matched?: number;
  sent?: number;
  skippedDuplicates?: number;
  failed?: number;
  items?: ItemOutcome[];
  message?: string;
};

const OUTCOME_LABEL: Record<ItemOutcome["outcome"], { text: string; className: string }> = {
  sent: { text: "ارسال شد به صندوق خروجی ✓", className: "bg-ok-soft text-ok-ink ring-ok-line" },
  partially_sent: { text: "بخشی ارسال شد", className: "bg-warn-soft text-warn-ink ring-warn-line" },
  failed: { text: "ناموفق", className: "bg-danger-soft text-danger-ink ring-danger-line" },
  already_sent: { text: "قبلاً ارسال شده (در صندوق خروجی موجود است)", className: "bg-surface-3 text-muted ring-line" },
  not_matched: { text: "مشمول شرایط نیست", className: "bg-surface-3 text-muted ring-line" },
};

const REASON_LABEL: Record<string, string> = {
  not_analyzed: "هنوز با AI تحلیل نشده است",
  ai_no_recommendation: "هوش مصنوعی ارسال را توصیه نکرده است",
  importance_below_threshold: "اهمیت پایین‌تر از حد نصاب تعریف‌شده",
  relevance_below_threshold: "مرتبط بودن پایین‌تر از حد نصاب تعریف‌شده",
  novelty_below_threshold: "تازگی پایین‌تر از حد نصاب تعریف‌شده",
  category_excluded: "خارج از دسته‌های مجاز",
};

export function AutoSendCard({
  onAutoSendComplete,
  adminKey = "",
}: {
  onAutoSendComplete?: () => void;
  /** Forwarded as x-admin-key when the dashboard is opened with ?key=... */
  adminKey?: string;
}) {
  const [rule, setRule] = useState<RuleInfo | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PassResult | null>(null);

  const loadRule = useCallback(() => {
    return fetch("/api/agent/rules", { cache: "no-store" })
      .then((res) => res.json() as Promise<RuleInfo>)
      .then((data) => {
        setRule(data);
      })
      .catch(() => {
        setRule(null);
      });
  }, []);

  useEffect(() => {
    void loadRule();
  }, [loadRule]);

  async function handleRun(force = false) {
    if (running) return;
    setRunning(true);
    setResult(null);

    try {
      const res = await fetch("/api/agent/auto-send", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(adminKey ? { "x-admin-key": adminKey } : {}) },
        body: JSON.stringify({ force }),
      });
      const data = (await res.json()) as PassResult;
      setResult(data);
      await loadRule();
      onAutoSendComplete?.();
    } catch {
      setResult({ success: false, message: "اجرای ارسال خودکار ناموفق بود." });
    } finally {
      setRunning(false);
    }
  }

  const destinationLabel =
    rule?.destination === "both" ? "Local و بله" : rule?.destination === "bale" ? "بله" : "صندوق محلی (Local Outbox)";

  return (
    <section
      aria-labelledby="auto-send-heading"
      className="mt-6 rounded-2xl border border-brand-line/80 bg-surface p-5 shadow-sm shadow-brand-line/50 sm:p-6"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-4">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand text-white shadow-md shadow-brand/20">
            <svg aria-hidden="true" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 2 4.5 13H11l-1 9 8.5-11H12l1-9Z" />
            </svg>
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="auto-send-heading" className="text-base font-bold text-ink">
                قواعد ارسال خودکار هوشمند 🤖
              </h2>
              {rule ? (
                <StatusBadge tone={rule.enabled ? "success" : "muted"}>
                  {rule.enabled ? "ارسال خودکار: فعال" : "غیرفعال"}
                </StatusBadge>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-muted">
              هر خبری که شرایط مشخص‌شده (اهمیت ≥ {rule?.thresholds?.minImportance ?? 50}٪ و مرتبط بودن ≥ {rule?.thresholds?.minRelevance ?? 50}٪) را داشته باشد، خودکار به صندوق خروجی ارسال می‌شود.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className={`rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm transition-all ${
              running ? "cursor-not-allowed bg-surface-3 text-faint" : "bg-brand text-white hover:bg-brand-strong"
            }`}
            disabled={running}
            onClick={() => handleRun(false)}
            type="button"
          >
            {running ? "در حال بررسی..." : "بررسی و ارسال خودکار"}
          </button>
          <button
            className="rounded-xl border border-brand-line bg-brand-soft px-3 py-2.5 text-xs font-bold text-brand-ink transition-colors hover:bg-brand-soft"
            disabled={running}
            onClick={() => handleRun(true)}
            title="ارسال حتی اگر قبلاً ارسال شده باشد (جهت تست فوری صندوق خروجی)"
            type="button"
          >
            ارسال مجدد تستی واجد شرایط
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-4 border-t border-line-soft pt-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-xl bg-surface-2 p-3">
          <p className="text-xs font-semibold text-muted">مقصد ارسال خودکار</p>
          <p className="mt-1 text-sm font-bold text-brand-ink">{destinationLabel}</p>
        </div>
        <div className="rounded-xl bg-surface-2 p-3">
          <p className="text-xs font-semibold text-muted">وضعیت اتصال مقصدها</p>
          <p className="mt-1 text-xs font-semibold text-ink-soft">
            صندوق محلی (Local):{" "}
            <span className="text-ok-ink">آماده و فعال ✓</span>
            {" · "}
            بله:{" "}
            {rule?.destinationsReady?.bale ? (
              <span className="text-ok-ink">کلید تنظیم شده</span>
            ) : (
              <span className="text-faint">بدون کلید</span>
            )}
          </p>
        </div>
        <div className="rounded-xl bg-surface-2 p-3">
          <p className="text-xs font-semibold text-muted">شرایط تعیین‌شده (حد نصاب‌ها)</p>
          <p className="mt-1 text-xs font-bold text-ink-soft">
            اهمیت ≥ {rule?.thresholds?.minImportance ?? 50}٪ · مرتبط بودن ≥ {rule?.thresholds?.minRelevance ?? 50}٪
          </p>
        </div>
      </div>

      {result ? (
        <div className="mt-5 rounded-xl border border-line bg-surface-2/80 p-4">
          {!result.success ? (
            <p className="text-sm font-medium text-danger-ink">{result.message ?? "اجرای ارسال خودکار ناموفق بود."}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-4 text-xs font-semibold">
                <span className="text-muted">
                  خبرهای بررسی‌شده: <b className="text-ink">{result.considered ?? 0}</b>
                </span>
                <span className="text-brand-ink">
                  واجد شرایط: <b>{result.matched ?? 0}</b>
                </span>
                <span className="text-ok-ink">
                  ارسال جدید به صندوق خروجی: <b>{result.sent ?? 0}</b>
                </span>
                <span className="text-muted">
                  قبلاً در صندوق موجود است: <b>{result.skippedDuplicates ?? 0}</b>
                </span>
              </div>

              {result.items && result.items.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {result.items.slice(0, 10).map((item) => {
                    const meta = OUTCOME_LABEL[item.outcome] ?? OUTCOME_LABEL.sent;
                    return (
                      <li className="rounded-lg bg-surface p-3 ring-1 ring-line-soft" key={item.id}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ring-inset ${meta.className}`}
                          >
                            {meta.text}
                          </span>
                          <span className="text-xs font-semibold text-ink-soft">{item.title}</span>
                        </div>
                        {item.reasons && item.reasons.length > 0 ? (
                          <p className="mt-1.5 text-xs text-muted">
                            علت: {item.reasons.map((reason) => REASON_LABEL[reason] ?? reason).join(" · ")}
                          </p>
                        ) : null}
                        {item.errors && item.errors.length > 0 ? (
                          <p className="mt-1 break-words font-mono text-[11px] text-danger-ink" dir="ltr">
                            {item.errors.join(" | ")}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-muted">
                  هیچ خبر تحلیل‌شده‌ای یافت نشد. ابتدا در صفحه «اخبار» روی «تحلیل با AI» بزنید.
                </p>
              )}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
