"use client";

import { useEffect, useState } from "react";
import type { AiConfigInput } from "@/lib/ai/config-types";

type ArticleOption = { id: string; title: string; source: string; analyzed: boolean };

type ValidationIssue = { field: string; message: string };

type TestResponse = {
  success: boolean;
  message?: string;
  detail?: string | null;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  promptUsed?: { systemPrompt: string; userPrompt: string };
  operationalPreview?: { topicGate: { verdict: string; reason: string; blockedKeywords?: string[]; matchedTopics: string[] }; graderWouldRun: boolean; shadowEvaluation: import("@/lib/ai/shadow-evaluation").ShadowEvaluation | null };
  rawResponse?: string;
  publishingPreview?: string | null;
  validation?: {
    valid: boolean;
    issues: ValidationIssue[];
    parsed: Record<string, unknown> | null;
  };
};

type Props = {
  draftConfig: AiConfigInput;
  adminKey: string;
};

function authHeaders(adminKey: string): HeadersInit {
  return adminKey ? { "x-admin-key": adminKey } : {};
}

export function AiConfigTestPanel({ draftConfig, adminKey }: Props) {
  const [articles, setArticles] = useState<ArticleOption[]>([]);
  const [selectedArticleId, setSelectedArticleId] = useState<string>("");
  const [manualMode, setManualMode] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [manualSource, setManualSource] = useState("تست دستی");

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResponse | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/ai-config/test", { headers: authHeaders(adminKey), cache: "no-store" })
      .then((res) => res.json())
      .then((data: { success: boolean; articles?: ArticleOption[] }) => {
        if (cancelled || !data.success) return;
        setArticles(data.articles ?? []);
        if (data.articles && data.articles.length > 0) {
          setSelectedArticleId(data.articles[0].id);
        }
      })
      .catch(() => {
        // Article list is a convenience only; manual mode still works.
      });

    return () => {
      cancelled = true;
    };
  }, [adminKey]);

  async function handleRunTest() {
    if (running) return;
    setRunning(true);
    setResult(null);

    const body: Record<string, unknown> = { draftConfig };

    if (manualMode) {
      body.manualArticle = {
        title: manualTitle,
        description: manualDescription || null,
        source: manualSource || "تست دستی",
        publishedAt: null,
      };
    } else {
      body.articleId = selectedArticleId;
    }

    try {
      const response = await fetch("/api/admin/ai-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as TestResponse;
      setResult(data);
    } catch {
      setResult({ success: false, message: "ارتباط با سرور برای اجرای آزمایش برقرار نشد." });
    } finally {
      setRunning(false);
    }
  }

  const canRun = manualMode ? manualTitle.trim().length > 0 : Boolean(selectedArticleId);

  return (
    <section className="rounded-2xl border border-brand-line/80 bg-surface p-5 shadow-sm shadow-brand-line/40 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand text-white">
          <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
          </svg>
        </div>
        <div>
          <h2 className="text-base font-bold text-ink">آزمایش پیکربندی (Test Configuration)</h2>
          <p className="mt-1 text-sm text-muted">
            پیکربندی فعلی (شامل تغییرات ذخیره‌نشده) را روی یک خبر اجرا کنید — چیزی به بله یا Local ارسال نمی‌شود و
            خبری در پایگاه داده تغییر نمی‌کند.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <button
          className={`rounded-lg px-3 py-1.5 text-xs font-bold ${!manualMode ? "bg-brand text-white" : "bg-surface-3 text-muted"}`}
          onClick={() => setManualMode(false)}
          type="button"
        >
          انتخاب از اخبار موجود
        </button>
        <button
          className={`rounded-lg px-3 py-1.5 text-xs font-bold ${manualMode ? "bg-brand text-white" : "bg-surface-3 text-muted"}`}
          onClick={() => setManualMode(true)}
          type="button"
        >
          وارد کردن خبر دستی
        </button>
      </div>

      {manualMode ? (
        <div className="mt-4 space-y-3">
          <input
            className="w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-brand focus:outline-none"
            onChange={(event) => setManualTitle(event.target.value)}
            placeholder="عنوان خبر آزمایشی"
            value={manualTitle}
          />
          <textarea
            className="w-full resize-y rounded-lg border border-line px-3 py-2 text-sm focus:border-brand focus:outline-none"
            onChange={(event) => setManualDescription(event.target.value)}
            placeholder="متن/توضیحات خبر"
            rows={3}
            value={manualDescription}
          />
          <input
            className="w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-brand focus:outline-none"
            onChange={(event) => setManualSource(event.target.value)}
            placeholder="منبع (اختیاری)"
            value={manualSource}
          />
        </div>
      ) : (
        <select
          className="mt-4 w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-brand focus:outline-none"
          onChange={(event) => setSelectedArticleId(event.target.value)}
          value={selectedArticleId}
        >
          {articles.length === 0 ? <option value="">هیچ خبری در پایگاه داده یافت نشد</option> : null}
          {articles.map((article) => (
            <option key={article.id} value={article.id}>
              {article.analyzed ? "✓ " : ""}
              {article.title} — {article.source}
            </option>
          ))}
        </select>
      )}

      <button
        className="mt-4 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-brand-strong disabled:cursor-not-allowed disabled:bg-brand-line"
        disabled={running || !canRun}
        onClick={handleRunTest}
        type="button"
      >
        {running ? "در حال اجرای آزمایش..." : "اجرای آزمایش با AI"}
      </button>

      {result ? (
        <div className="mt-5 space-y-3 border-t border-line-soft pt-4">
          {!result.success ? (
            <div className="rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">
              <p className="font-bold">{result.message}</p>
              {result.detail ? <p className="mt-1 font-mono text-xs opacity-80">{result.detail}</p> : null}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                <span>مدل استفاده‌شده: {result.model}</span>
                {result.usage ? (
                  <span className="rounded-full bg-surface-3 px-2.5 py-1 font-medium text-ink-soft">
                    مصرف توکن: {result.usage.totalTokens.toLocaleString("fa-IR")} (ورودی:{" "}
                    {result.usage.promptTokens.toLocaleString("fa-IR")} · خروجی:{" "}
                    {result.usage.completionTokens.toLocaleString("fa-IR")})
                  </span>
                ) : null}
                <button
                  className="rounded-md border border-line px-2 py-1 hover:bg-surface-2"
                  onClick={() => setShowPrompt(!showPrompt)}
                  type="button"
                >
                  {showPrompt ? "پنهان کردن پرامپت ارسالی" : "نمایش پرامپت ارسالی"}
                </button>
              </div>

              {showPrompt && result.promptUsed ? (
                <div className="space-y-2">
                  <div>
                    <p className="text-xs font-bold text-muted">System Prompt:</p>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-3 p-3 text-[11px] leading-5 text-ink-soft" dir="ltr">
                      {result.promptUsed.systemPrompt}
                    </pre>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-muted">User Prompt:</p>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-3 p-3 text-[11px] leading-5 text-ink-soft" dir="ltr">
                      {result.promptUsed.userPrompt}
                    </pre>
                  </div>
                </div>
              ) : null}

              <div>
                <p className="text-xs font-bold text-muted">پاسخ خام هوش مصنوعی (Raw Response):</p>
                <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-xs leading-5 text-ink-soft ring-1 ring-line-soft">
                  {result.rawResponse}
                </pre>
              </div>

              {result.operationalPreview ? (
                <div className="rounded-xl border border-line p-3 text-sm" dir="rtl">
                  <h4 className="font-bold">پیش‌نمایش قواعد اجرایی</h4>
                  <p>فیلتر اولیه: {result.operationalPreview.topicGate.verdict === "pass" ? "عبور" : "حذف پیش از AI"} — {result.operationalPreview.topicGate.reason}</p>
                  <p>تطبیق: {[...(result.operationalPreview.topicGate.blockedKeywords ?? []), ...result.operationalPreview.topicGate.matchedTopics].join("، ") || "ندارد"}</p>
                  <p>داور دوم: {result.operationalPreview.graderWouldRun ? "در تحلیل واقعی اجرا می‌شود" : "اجرا نمی‌شود"}</p>
                  <p className="text-xs text-muted">تست عمداً حتی برای خبر فیلترشده، AI را اجرا می‌کند و توکن مصرف می‌کند. این پیش‌نمایش از عنوان و توضیح استفاده می‌کند؛ فیلتر دریافت خبر متن کامل موجود را هم می‌بیند.</p>
                  {result.operationalPreview.shadowEvaluation ? <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(result.operationalPreview.shadowEvaluation, null, 2)}</pre> : <p>ارزیابی آزمایشی خاموش است.</p>}
                </div>
              ) : null}
              {result.publishingPreview ? (
                <div className="rounded-xl border border-line p-3">
                  <h4 className="font-bold">پیش‌نمایش قالب انتشار با خروجی همین تست</h4>
                  <p className="text-xs text-muted">فقط پیش‌نمایش؛ ذخیره یا ارسال نمی‌شود. لینک خبر در این پیش‌نمایش نمونه است.</p>
                  <pre className="mt-2 whitespace-pre-wrap text-sm" dir="rtl">{result.publishingPreview}</pre>
                </div>
              ) : null}
              {result.validation?.valid ? (
                <div className="rounded-xl border border-ok-line bg-ok-soft p-3">
                  <p className="text-sm font-bold text-ok-ink">✓ خروجی با ساختار تعریف‌شده مطابقت دارد</p>
                  <dl className="mt-2 grid gap-1.5 text-xs text-ok-ink sm:grid-cols-2">
                    {result.validation.parsed
                      ? Object.entries(result.validation.parsed).map(([key, value]) => (
                          <div className="flex justify-between gap-2 rounded-md bg-surface/60 px-2 py-1" key={key}>
                            <dt className="font-mono">{key}</dt>
                            <dd className="truncate font-bold">{String(value)}</dd>
                          </div>
                        ))
                      : null}
                  </dl>
                </div>
              ) : (
                <div className="rounded-xl border border-danger-line bg-danger-soft p-3">
                  <p className="text-sm font-bold text-danger-ink">خطاهای اعتبارسنجی ساختار خروجی:</p>
                  <ul className="mt-2 space-y-1 text-xs text-danger-ink">
                    {result.validation?.issues.map((issue, index) => (
                      <li key={`${issue.field}-${index}`}>
                        <span className="font-mono font-bold">{issue.field}</span>: {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
