"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AI_FEATURE_ORDER,
  DEFAULT_AUTO_SEND_POLICY,
  DEFAULT_CONFIG_NAME,
  DEFAULT_DECISION_RULES,
  DEFAULT_FEATURES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_PLACEHOLDER,
  DEFAULT_OUTPUT_SCHEMA,
  DEFAULT_PUBLISHING_TEMPLATE,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TEMPERATURE,
  DEFAULT_TOPIC_FILTER,
  type AiAutoSendPolicy,
  type AiConfigInput,
  type AiFeatureKey,
  type AiTopicFilterConfig,
  type ActiveAiConfig,
} from "@/lib/ai/config-types";
import { DEFAULT_AUDIENCE_FOCUS } from "@/lib/ai/prompt-builder";
import { BulletinConfigPanel } from "./bulletin-config-panel";
import { KeywordListEditor } from "./keyword-list-editor";
import { BASELINE_BLOCKED_KEYWORDS } from "@/lib/news/topic-filter";
import { PUBLISHING_TEMPLATE_VARS, findUnknownTemplateVars } from "@/lib/delivery/template";
import { CREDIT_RATING_PACK } from "@/lib/news/news-packs";
import { TOPIC_PRESETS } from "@/lib/news/topic-filter";
import { AiConfigFeatureRow } from "./ai-config-feature-row";
import { AiConfigOutputFieldRow } from "./ai-config-output-field-row";
import { SchemaRepairCard } from "./schema-repair-card";
import { AiConfigTestPanel } from "./ai-config-test-panel";
import { AiConfigTopicRow } from "./ai-config-topic-row";

import { AiConfigVersionHistory } from "./ai-config-version-history";

/**
 * Generic quick-add presets plus the credit-rating domain topics (the same
 * topics the one-click «بسته خبری اعتبارسنجی» applies, offered individually).
 */
const ALL_TOPIC_PRESETS = [
  ...TOPIC_PRESETS,
  ...CREDIT_RATING_PACK.topics.map((topic) => ({ label: topic.label, keywords: [...topic.keywords] })),
];

/**
 * Starter deny-list keywords: the kinds of news a credit-rating audience never
 * wants. They apply in BOTH filter modes, before the AI stage.
 */
const BLOCKED_KEYWORD_PRESETS = [
  "ورزش",
  "فوتبال",
  "لیگ برتر",
  "سرگرمی",
  "هنرمندان",
  "سینما",
  "حوادث",
  "تصادف",
];

type Props = { adminKey: string };

// These two fields are read directly by the existing analysis pipeline
// (src/lib/news/analyze.ts / src/lib/delivery) — disabling them would silently
// break already-working functionality, so their toggle stays locked in the UI.
const LOCKED_FEATURES: AiFeatureKey[] = ["summary", "shouldSend"];

/**
 * Roadmap Phase 2 task #5: one-click analyst presets. Each fills the system
 * prompt, audience focus, AND the score thresholds together (the operator
 * still reviews and saves — a preset never persists anything by itself).
 */
const ANALYST_PRESETS: Array<{
  key: string;
  label: string;
  systemPrompt: string;
  audienceFocus: string;
  minImportance: number;
  minRelevance: number;
}> = [
  {
    key: "credit",
    label: "تحلیلگر اعتبارسنجی",
    systemPrompt:
      "تو یک تحلیلگر خبرهٔ حوزهٔ اعتبارسنجی و رتبه‌بندی اعتباری هستی. هر خبر را از دید یک شرکت اعتبارسنجی تحلیل کن: تأثیر بر مدل‌های رتبه‌بندی، ریسک اعتباری ناشران و بانک‌ها، بازار بدهی، و مقررات نظارتی. خلاصه را دقیق و فنی بنویس، اهمیت و مرتبط بودن را صادقانه امتیاز بده و فقط خبرهایی را برای ارسال توصیه کن که برای مخاطب حرفه‌ای اعتبارسنجی ارزش عملی داشته باشند.",
    audienceFocus:
      "مخاطب، شرکت‌های اعتبارسنجی و تحلیلگران ریسک اعتباری هستند. خبر مرتبط یعنی: اعتبارسنجی، رتبه‌بندی اعتباری، ریسک اعتباری، سلامت مالی ناشران، بازار بدهی ایران، مقررات نظارتی بانک مرکزی/بورس دربارهٔ اعتبار. اخبار عمومی اقتصادی، قیمت و تورم روزمره، ورزشی، حوادث و سرگرمی بی‌ربط‌اند.",
    minImportance: 70,
    minRelevance: 70,
  },
  {
    key: "capital",
    label: "تحلیلگر بازار سرمایه",
    systemPrompt:
      "تو یک تحلیلگر بازار سرمایه هستی. هر خبر را از دید سرمایه‌گذاران و نهادهای مالی تحلیل کن: تأثیر بر شاخص‌ها، صنایع، ناشران بورسی، ابزارهای مالی و جریان نقدینگی. خلاصه را دقیق بنویس، اهمیت و مرتبط بودن را صادقانه امتیاز بده و فقط خبرهای اثرگذار بر تصمیم سرمایه‌گذاری را برای ارسال توصیه کن.",
    audienceFocus:
      "مخاطب، سرمایه‌گذاران و تحلیلگران بازار سرمایهٔ ایران هستند. خبر مرتبط یعنی: بورس و فرابورس، ناشران بورسی، صکوک و ابزارهای مالی، سیاست‌های پولی-مالی اثرگذار بر بازار، عرضه‌های اولیه، گزارش‌های مالی شرکت‌ها. اخبار بی‌ربط روزمره، ورزشی و سرگرمی بی‌ربط‌اند.",
    minImportance: 65,
    minRelevance: 70,
  },
  {
    key: "insurance",
    label: "تحلیلگر بیمه",
    systemPrompt:
      "تو یک تحلیلگر صنعت بیمه هستی. هر خبر را از دید شرکت‌های بیمه و نهاد ناظر تحلیل کن: تأثیر بر ترکیب پرتفوی، خسارت‌ها، آیین‌نامه‌های بیمه مرکزی، فناوری بیمه و بازار سرمایهٔ بیمه‌ای. خلاصه را دقیق بنویس، اهمیت و مرتبط بودن را صادقانه امتیاز بده و فقط خبرهای اثرگذار بر صنعت بیمه را برای ارسال توصیه کن.",
    audienceFocus:
      "مخاطب، شرکت‌های بیمه، بیمه مرکزی و تحلیلگران صنعت بیمه هستند. خبر مرتبط یعنی: بیمهٔ زندگی و غیرزندگی، خسارت و اتکایی، آیین‌نامه‌های بیمه مرکزی، تحولات فناوری بیمه، عملکرد مالی شرکت‌های بیمه. اخبار عمومی اقتصادی، ورزشی و حوادث بی‌ربط‌اند.",
    minImportance: 65,
    minRelevance: 70,
  },
];


function buildDraft(
  config: Pick<
    ActiveAiConfig,
    | "name"
    | "provider"
    | "model"
    | "systemPrompt"
    | "audienceFocus"
    | "temperature"
    | "maxTokens"
    | "features"
    | "decisionRules"
    | "outputSchema"
    | "publishingTemplate"
    | "topicFilter"
    | "autoSendPolicy"
  >,
): AiConfigInput {
  return {
    name: config.name,
    provider: config.provider,
    model: config.model,
    systemPrompt: config.systemPrompt,
    audienceFocus: config.audienceFocus ?? "",
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    features: config.features,
    decisionRules: config.decisionRules,
    outputSchema: config.outputSchema,
    publishingTemplate: config.publishingTemplate ?? "",
    topicFilter: config.topicFilter ?? DEFAULT_TOPIC_FILTER,
    autoSendPolicy: config.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY,
  };
}

function defaultDraft(): AiConfigInput {
  return {
    name: DEFAULT_CONFIG_NAME,
    provider: "openai-compatible",
    model: DEFAULT_MODEL_PLACEHOLDER,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    audienceFocus: "",
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    features: DEFAULT_FEATURES,
    decisionRules: DEFAULT_DECISION_RULES,
    outputSchema: DEFAULT_OUTPUT_SCHEMA,
    publishingTemplate: DEFAULT_PUBLISHING_TEMPLATE,
    topicFilter: DEFAULT_TOPIC_FILTER,
    autoSendPolicy: DEFAULT_AUTO_SEND_POLICY,
  };
}

function authHeaders(adminKey: string): HeadersInit {
  return adminKey ? { "x-admin-key": adminKey } : {};
}

export function AiConfigConsole({ adminKey }: Props) {
  const [draft, setDraft] = useState<AiConfigInput>(defaultDraft());
  const [meta, setMeta] = useState<{ version: number; isActive: boolean; updatedAt: string } | null>(null);
  const [aiKeyConfigured, setAiKeyConfigured] = useState(false);
  const [effectiveModel, setEffectiveModel] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"draft" | "activate" | null>(null);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<{
    message: string;
    hint?: string;
    detail?: string;
    code?: string | null;
    schemaMismatch?: boolean;
  } | null>(null);
  const [schemaSynced, setSchemaSynced] = useState(false);

  const [versions, setVersions] = useState<ActiveAiConfig[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  const loadActive = useCallback(() => {
    return fetch("/api/admin/ai-config", { headers: authHeaders(adminKey), cache: "no-store" })
      .then((response) => response.json() as Promise<{
        success: boolean;
        config?: ActiveAiConfig;
        aiKeyConfigured?: boolean;
        effectiveModel?: string;
        message?: string;
        detail?: string;
        hint?: string;
        code?: string | null;
        schemaMismatch?: boolean;
        schemaSynced?: boolean;
      }>)
      .then((data) => {
        if (data.success && data.config) {
          setDraft(buildDraft(data.config));
          setMeta({ version: data.config.version, isActive: data.config.isActive, updatedAt: data.config.updatedAt });
          setAiKeyConfigured(Boolean(data.aiKeyConfigured));
          setEffectiveModel(data.effectiveModel ?? "");
          setLoadFailure(null);
          setSchemaSynced(Boolean(data.schemaSynced));
        } else if (!data.success) {
          setLoadFailure({
            message: data.message ?? "بارگذاری پیکربندی ناموفق بود.",
            hint: data.hint,
            detail: data.detail,
            code: data.code,
            schemaMismatch: data.schemaMismatch,
          });
        }
      })
      .catch(() => {
        setLoadFailure({ message: "ارتباط با سرور برای بارگذاری پیکربندی برقرار نشد." });
      })
      .finally(() => {
        setLoading(false);
      });
  }, [adminKey]);

  const loadVersions = useCallback(() => {
    return fetch("/api/admin/ai-config/history", { headers: authHeaders(adminKey), cache: "no-store" })
      .then((response) => response.json() as Promise<{ success: boolean; versions?: ActiveAiConfig[] }>)
      .then((data) => {
        if (data.success) setVersions(data.versions ?? []);
        else setVersions([]);
      })
      .catch(() => {
        setVersions([]);
      })
      .finally(() => {
        setVersionsLoading(false);
      });
  }, [adminKey]);

  useEffect(() => {
    void loadActive();
    void loadVersions();
  }, [loadActive, loadVersions]);

  async function handleSave(activate: boolean) {
    setSaving(activate ? "activate" : "draft");
    setSaveErrors([]);
    setSaveSuccess(null);

    try {
      const response = await fetch("/api/admin/ai-config", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
        body: JSON.stringify({ ...draft, activate }),
      });
      const data = (await response.json()) as {
        success: boolean;
        config?: ActiveAiConfig;
        message?: string;
        errors?: string[];
      };

      if (data.success && data.config) {
        setDraft(buildDraft(data.config));
        setMeta({ version: data.config.version, isActive: data.config.isActive, updatedAt: data.config.updatedAt });
        setLoadFailure(null);
        setSaveSuccess(
          activate
            ? `نسخه ${data.config.version} ذخیره و فعال شد.`
            : `نسخه ${data.config.version} به‌عنوان پیش‌نویس ذخیره شد (غیرفعال).`,
        );
        await loadVersions();
      } else {
        setSaveErrors(data.errors && data.errors.length > 0 ? data.errors : [data.message ?? "ذخیره پیکربندی ناموفق بود."]);
      }
    } catch {
      setSaveErrors(["ارتباط با سرور برای ذخیره پیکربندی برقرار نشد."]);
    } finally {
      setSaving(null);
    }
  }

  async function handleActivateVersion(id: string) {
    setActivatingId(id);
    try {
      const response = await fetch("/api/admin/ai-config/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
        body: JSON.stringify({ id }),
      });
      const data = (await response.json()) as { success: boolean; config?: ActiveAiConfig; message?: string };
      if (data.success && data.config) {
        setDraft(buildDraft(data.config));
        setMeta({ version: data.config.version, isActive: data.config.isActive, updatedAt: data.config.updatedAt });
        setSaveSuccess(`نسخه ${data.config.version} فعال شد.`);
        await loadVersions();
      }
    } finally {
      setActivatingId(null);
    }
  }

  function handleResetToDefault() {
    setDraft(defaultDraft());
    setSaveErrors([]);
    setSaveSuccess("مقادیر پیش‌فرض بارگذاری شد — برای اعمال دائمی، «ذخیره و فعال‌سازی» را بزنید.");
  }

  const promptChars = draft.systemPrompt.length;
  const promptTokensEstimate = Math.ceil(promptChars / 4);
  const unknownTemplateVars = findUnknownTemplateVars(draft.publishingTemplate ?? "");

  return (
    <div className="space-y-6">
      <header className="border-b border-line/80 pb-6">
        <p className="mb-2 text-sm font-medium text-accent-ink">مرکز پیکربندی هوش مصنوعی</p>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">پیکربندی تحلیل هوش مصنوعی</h1>
        <p className="mt-2 text-sm text-muted">
          رفتار تحلیل هوش مصنوعی (پرامپت، ویژگی‌ها، آستانه‌ها و ساختار خروجی) را بدون نیاز به تغییر کد مدیریت کنید.
        </p>
        {meta ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded-full bg-surface-3 px-2.5 py-1 font-bold text-ink-soft">نسخه فعال: {meta.version}</span>
            <span>آخرین به‌روزرسانی: {new Date(meta.updatedAt).toLocaleString("fa-IR")}</span>
          </div>
        ) : null}
      </header>

      {loading ? <p className="text-sm text-faint">در حال بارگذاری پیکربندی...</p> : null}

      {schemaSynced && !loadFailure ? (
        <p className="rounded-xl border border-ok-line bg-ok-soft px-4 py-3 text-sm leading-6 text-ok-ink">
          ساختار پایگاه داده با کد همگام نبود؛ به‌صورت خودکار (بدون حذف داده) همگام‌سازی شد و پیکربندی از مقادیر پیش‌فرض
          ساخته شد. اکنون می‌توانید مقادیر را ذخیره و فعال کنید.
        </p>
      ) : null}

      {loadFailure ? (
        <SchemaRepairCard
          adminKey={adminKey}
          code={loadFailure.code}
          detail={loadFailure.detail}
          hint={loadFailure.hint}
          message={loadFailure.message}
          onRepaired={() => {
            setLoading(true);
            void loadActive();
            void loadVersions();
          }}
          schemaMismatch={Boolean(loadFailure.schemaMismatch)}
        />
      ) : null}

      {/* A. Provider & Model */}
      <section className="rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6">
        <h2 className="text-base font-bold text-ink">ارائه‌دهنده و مدل هوش مصنوعی</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="ارائه‌دهنده">
            <input
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-muted"
              disabled
              value="OpenAI-compatible"
            />
          </Field>
          <Field label="مدل (خالی = استفاده از env)">
            <input
              className="w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-accent focus:outline-none"
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              placeholder={effectiveModel || "gpt-4o-mini"}
              value={draft.model}
            />
          </Field>
          <Field label="Temperature (۰ تا ۲)">
            <input
              className="w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-accent focus:outline-none"
              max={2}
              min={0}
              onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })}
              step={0.1}
              type="number"
              value={draft.temperature}
            />
          </Field>
          <Field label="حداکثر توکن خروجی">
            <input
              className="w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-accent focus:outline-none"
              max={8000}
              min={50}
              onChange={(event) => setDraft({ ...draft, maxTokens: Number(event.target.value) })}
              type="number"
              value={draft.maxTokens}
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 p-3 text-xs">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-bold ring-1 ring-inset ${aiKeyConfigured ? "bg-ok-soft text-ok-ink ring-ok-line" : "bg-danger-soft text-danger-ink ring-danger-line"}`}>
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${aiKeyConfigured ? "bg-ok" : "bg-danger"}`} />
            {aiKeyConfigured ? "کلید API تنظیم شده" : "کلید API تنظیم نشده (AI_API_KEY)"}
          </span>
          <span className="text-muted">مدل مؤثر فعلی: <b className="text-ink-soft">{effectiveModel || "—"}</b></span>
        </div>

        {!loading && !aiKeyConfigured ? (
          <p className="mt-3 rounded-xl border border-warn-line bg-warn-soft px-3 py-2.5 text-xs leading-6 text-warn-ink">
            <b>تحلیل هوش مصنوعی غیرفعال است:</b> متغیر{" "}
            <code className="rounded bg-surface px-1 font-mono text-[11px]" dir="ltr">AI_API_KEY</code>{" "}
            (و در صورت نیاز <code className="rounded bg-surface px-1 font-mono text-[11px]" dir="ltr">AI_API_BASE_URL</code> /{" "}
            <code className="rounded bg-surface px-1 font-mono text-[11px]" dir="ltr">AI_API_MODEL</code>) را در
            Environment Variables سرویس میزبان — مثل Vercel → Settings → Environment Variables — تنظیم کنید و
            سرویس را دوباره Deploy کنید. تا آن زمان هیچ تحلیلی اجرا نمی‌شود، ولی بقیه پنل کار می‌کند.
          </p>
        ) : null}
      </section>

      {/* B. System Prompt */}
      <section className="rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-ink">System Prompt</h2>
          <span className="text-xs text-faint">
            {promptChars.toLocaleString("fa-IR")} کاراکتر · تخمین {promptTokensEstimate.toLocaleString("fa-IR")} توکن
          </span>
        </div>

        <div className="mt-3 rounded-xl border border-accent-line bg-accent-soft/60 p-3">
          <p className="text-xs leading-5 text-accent-ink">
            قالب‌های آماده: متن پرامپت، تمرکز مخاطب و آستانه‌های اهمیت/مرتبط بودن را <b>با هم</b> پر می‌کنند؛ قبل از
            ذخیره قابل ویرایش‌اند.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {ANALYST_PRESETS.map((preset) => (
              <button
                key={preset.key}
                className="rounded-lg border border-accent bg-surface px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent-soft"
                onClick={() =>
                  setDraft({
                    ...draft,
                    systemPrompt: preset.systemPrompt,
                    audienceFocus: preset.audienceFocus,
                    decisionRules: {
                      ...draft.decisionRules,
                      minImportanceToSend: preset.minImportance,
                      minRelevanceToSend: preset.minRelevance,
                    },
                    autoSendPolicy: {
                      ...(draft.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY),
                      minImportance: preset.minImportance,
                      minRelevance: preset.minRelevance,
                    },
                  })
                }
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <textarea
          className="mt-3 w-full resize-y rounded-xl border border-line px-3 py-2.5 text-sm leading-6 text-ink-soft focus:border-accent focus:outline-none"
          onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
          rows={8}
          value={draft.systemPrompt}
        />

        <div className="mt-5">
          <h3 className="text-sm font-bold text-ink">تمرکز مخاطب (ملاک امتیاز مرتبط بودن)</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            مشخص کنید خبر «مرتبط» یعنی چه. اگر خالی بماند، تعریف پیش‌فرض استفاده می‌شود: مخاطب هدف،{" "}
            <b>شرکت اعتبارسنجی</b> است و فقط اخبار اعتبارسنجی/رتبه‌بندی اعتباری/ریسک اعتباری مرتبط محسوب می‌شوند. این
            متن همراه قوانین قطعی («خبر بی‌ربط باید relevance زیر ۳۰ بگیرد، حتی اگر بسیار مهم باشد») به همهٔ درخواست‌های
            تحلیل اضافه می‌شود — پس از ذخیره، روی همهٔ نسخه‌ها اثر دارد.
          </p>
          <textarea
            className="mt-2 w-full resize-y rounded-xl border border-line px-3 py-2.5 text-sm leading-6 text-ink-soft focus:border-accent focus:outline-none"
            onChange={(event) => setDraft({ ...draft, audienceFocus: event.target.value })}
            placeholder={DEFAULT_AUDIENCE_FOCUS}
            rows={3}
            value={draft.audienceFocus ?? ""}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <input
            className="w-64 rounded-lg border border-line px-3 py-2 text-sm focus:border-accent focus:outline-none"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="نام این پیکربندی"
            value={draft.name}
          />
          <button
            className="rounded-lg border border-line px-3 py-2 text-xs font-medium text-muted hover:bg-surface-2"
            onClick={() => setDraft({ ...draft, systemPrompt: DEFAULT_SYSTEM_PROMPT })}
            type="button"
          >
            بازنشانی فقط متن پرامپت
          </button>
        </div>
      </section>

      {/* C. Analysis Features */}
      <section className="rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6">
        <h2 className="text-base font-bold text-ink">ویژگی‌های تحلیل (Analysis Features)</h2>
        <p className="mt-1 text-sm text-muted">هر ویژگی به‌طور مستقل قابل فعال/غیرفعال‌سازی و ویرایش است.</p>
        <div className="mt-4 space-y-3">
          {AI_FEATURE_ORDER.map((key) => (
            <AiConfigFeatureRow
              featureKey={key}
              key={key}
              locked={LOCKED_FEATURES.includes(key)}
              onChange={(next) => setDraft({ ...draft, features: { ...draft.features, [key]: next } })}
              value={draft.features[key]}
            />
          ))}
        </div>
      </section>

      {/* D. Decision Rules */}
      <section className="rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6">
        <h2 className="text-base font-bold text-ink">قوانین تصمیم‌گیری (Decision Rules)</h2>
        <p className="mt-1 text-sm text-muted">
          این آستانه‌ها فقط به هوش مصنوعی می‌گویند چگونه فیلد <code className="rounded bg-surface-3 px-1">shouldSend</code> را
          پیشنهاد دهد. این پیشنهاد به‌تنهایی هیچ ارسالی انجام نمی‌دهد؛ قوانین ارسال خودکار واقعی جدا و در بخش Agent
          تنظیم می‌شوند.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="حداقل امتیاز اهمیت">
            <input
              className="w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-accent focus:outline-none"
              max={100}
              min={0}
              onChange={(event) =>
                setDraft({ ...draft, decisionRules: { ...draft.decisionRules, minImportanceToSend: Number(event.target.value) } })
              }
              type="number"
              value={draft.decisionRules.minImportanceToSend}
            />
          </Field>
          <Field label="حداقل امتیاز مرتبط بودن">
            <input
              className="w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-accent focus:outline-none"
              max={100}
              min={0}
              onChange={(event) =>
                setDraft({ ...draft, decisionRules: { ...draft.decisionRules, minRelevanceToSend: Number(event.target.value) } })
              }
              type="number"
              value={draft.decisionRules.minRelevanceToSend}
            />
          </Field>
          <Field label="حداقل امتیاز تازگی">
            <input
              className="w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-accent focus:outline-none"
              max={100}
              min={0}
              onChange={(event) =>
                setDraft({ ...draft, decisionRules: { ...draft.decisionRules, minNoveltyToSend: Number(event.target.value) } })
              }
              type="number"
              value={draft.decisionRules.minNoveltyToSend}
            />
          </Field>
          {(draft.decisionRules.combine ?? "all") === "any" ? (
            <Field label="آستانه کلی ارسال (فقط حالت OR)">
              <input
                className="w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-accent focus:outline-none"
                max={100}
                min={0}
                onChange={(event) =>
                  setDraft({ ...draft, decisionRules: { ...draft.decisionRules, overallSendThreshold: Number(event.target.value) } })
                }
                type="number"
                value={draft.decisionRules.overallSendThreshold}
              />
            </Field>
          ) : null}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="منطق ترکیب حد نصاب‌ها">
            <select
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none"
              onChange={(event) =>
                setDraft({
                  ...draft,
                  decisionRules: {
                    ...draft.decisionRules,
                    combine: event.target.value === "any" ? "any" : "all",
                  },
                })
              }
              value={draft.decisionRules.combine ?? "all"}
            >
              <option value="all">همهٔ شرط‌ها باید برقرار باشند (AND — پیشنهادی)</option>
              <option value="any">کافی است یکی برقرار باشد (OR — رفتار قدیمی)</option>
            </select>
          </Field>
        </div>
        <p className="mt-2 text-xs leading-6 text-muted">
          در حالت AND، اهمیت بالا هرگز جای مرتبط بودن پایین را نمی‌گیرد؛ خبری که به موضوعات شما مربوط نیست حتی اگر
          بسیار مهم باشد توصیهٔ ارسال نمی‌گیرد. حالت OR فقط برای سازگاری با تنظیمات قدیمی نگه داشته شده و همان دلیلی
          است که پیش‌تر خبرهای نامرتبط ارسال می‌شدند.
        </p>

        <label className="mt-4 inline-flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
          <input
            checked={draft.decisionRules.enableAutoRecommendation}
            className="h-4 w-4 accent-blue-600"
            onChange={(event) =>
              setDraft({ ...draft, decisionRules: { ...draft.decisionRules, enableAutoRecommendation: event.target.checked } })
            }
            type="checkbox"
          />
          فعال‌سازی پیشنهاد خودکار هوش مصنوعی (shouldSend)
        </label>
      </section>

      {/* E1. Topic Filter (pre-AI relevance gate) */}
      <section className="rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-ink">موضوعات و فیلتر مرتبط‌سازی (Topic Filter)</h2>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-ink-soft">
            <input
              checked={draft.topicFilter?.enabled ?? false}
              className="h-4 w-4 accent-blue-600"
              onChange={(event) =>
                setDraft({
                  ...draft,
                  topicFilter: { ...(draft.topicFilter ?? DEFAULT_TOPIC_FILTER), enabled: event.target.checked },
                })
              }
              type="checkbox"
            />
            فعال‌سازی فیلتر موضوعی
          </label>
        </div>
        <p className="mt-1 text-sm text-muted">
          پیش از مرحله پرهزینه تحلیل هوش مصنوعی، اخبار با قواعد ساده کلیدواژه‌ای غربال می‌شوند. اخبار نامرتبط ذخیره اما
          با وضعیت «خارج از موضوع» علامت‌گذاری می‌شوند و هرگز به AI ارسال نمی‌شوند (قابل بازگشت به صف از مدیریت اخبار).
          وقتی فیلتر غیرفعال باشد، موضوعات و کلمات ممنوع سفارشی اعمال نمی‌شوند؛ فهرست ممنوع پایه، در صورت غیرخالی بودن، همچنان اعمال می‌شود.
          برای اعمال تغییرات، «ذخیره و فعال‌سازی» را بزنید؛ ذخیرهٔ پیش‌نویس به‌تنهایی رفتار برنامه را تغییر نمی‌دهد.
          تغییرات در پردازش بعدی اعمال می‌شوند و اخبار قبلاً حذف‌شده خودکار به صف برنمی‌گردند.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Field label="حالت فیلتر">
            <select
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none"
              onChange={(event) =>
                setDraft({
                  ...draft,
                  topicFilter: {
                    ...(draft.topicFilter ?? DEFAULT_TOPIC_FILTER),
                    mode: event.target.value === "exclude" ? "exclude" : "include",
                  },
                })
              }
              value={draft.topicFilter?.mode ?? "include"}
            >
              <option value="include">تمرکز (فقط اخبار مرتبط با موضوعات)</option>
              <option value="exclude">حذف (کنار گذاشتن اخبار موضوعات زیر)</option>
            </select>
          </Field>
          <button
            className="rounded-lg border border-accent-line bg-accent-soft px-3 py-2 text-xs font-medium text-accent-ink hover:bg-accent-soft"
            onClick={() =>
              setDraft({
                ...draft,
                topicFilter: {
                  ...(draft.topicFilter ?? DEFAULT_TOPIC_FILTER),
                  enabled: true,
                  topics: [
                    ...(draft.topicFilter?.topics ?? []),
                    { id: crypto.randomUUID(), label: "", enabled: true, keywords: [] },
                  ],
                },
              })
            }
            type="button"
          >
            + افزودن موضوع سفارشی
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted">افزودن سریع موضوعات پیشنهادی:</span>
          {ALL_TOPIC_PRESETS.map((preset) => (
            <button
              className="rounded-full border border-line bg-surface-2 px-3 py-1 text-[11px] font-medium text-muted transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
              key={preset.label}
              onClick={() =>
                setDraft({
                  ...draft,
                  topicFilter: {
                    ...(draft.topicFilter ?? DEFAULT_TOPIC_FILTER),
                    enabled: true,
                    topics: [
                      ...(draft.topicFilter?.topics ?? []),
                      { id: crypto.randomUUID(), label: preset.label, enabled: true, keywords: [...preset.keywords] },
                    ],
                  },
                })
              }
              type="button"
            >
              + {preset.label}
            </button>
          ))}
        </div>

        <div className="mt-4 rounded-xl border border-danger-line/70 bg-danger-soft/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-xs font-bold text-danger-ink" htmlFor="blocked-keywords">
              کلیدواژه‌های ممنوع (این خبرها هرگز ارسال نمی‌شوند)
            </label>
            <span className="text-[11px] text-danger-ink">در هر دو حالت فیلتر اعمال می‌شود</span>
          </div>
          <KeywordListEditor
            className="mt-2 w-full resize-y rounded-lg border border-danger-line bg-surface px-3 py-2 text-sm focus:border-danger focus:outline-none"
            id="blocked-keywords"
            onValuesChange={(blockedKeywords) =>
              setDraft({
                ...draft,
                topicFilter: {
                  ...(draft.topicFilter ?? DEFAULT_TOPIC_FILTER),
                  blockedKeywords,
                },
              })
            }
            placeholder="مثلاً: ورزش، فوتبال، سرگرمی، حوادث"
            rows={2}
            values={draft.topicFilter?.blockedKeywords ?? []}
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-danger-ink">افزودن سریع:</span>
            {BLOCKED_KEYWORD_PRESETS.map((keyword) => (
              <button
                className="rounded-full border border-danger-line bg-surface px-2.5 py-1 text-[11px] font-medium text-danger-ink transition-colors hover:bg-danger-soft"
                key={keyword}
                onClick={() => {
                  const current = draft.topicFilter?.blockedKeywords ?? [];
                  if (current.includes(keyword)) return;
                  setDraft({
                    ...draft,
                    topicFilter: {
                      ...(draft.topicFilter ?? DEFAULT_TOPIC_FILTER),
                      blockedKeywords: [...current, keyword],
                    },
                  });
                }}
                type="button"
              >
                + {keyword}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-5 text-danger-ink">
            خبری که یکی از این کلمات را در عنوان یا متن داشته باشد، پیش از تحلیل هوش مصنوعی کنار گذاشته می‌شود
            (وضعیت «خارج از موضوع») و هیچ‌وقت ارسال نمی‌شود — حتی اگر موضوع دیگری را هم پوشش دهد.
          </p>
          <p className="mt-2 rounded-lg border border-danger-line bg-danger-soft/60 px-3 py-2 text-[11px] leading-5 text-danger-ink">
            <b>کلیدواژه‌های ممنوع پایه</b> (حتی با فیلتر موضوعی خاموش):{" "}
            این فهرست حتی با خاموش بودن فیلتر موضوعی اعمال می‌شود. اکنون قابل ویرایش است؛ خالی کردن آن یعنی حذف محدودیت‌های پیش‌فرض.
          </p>
        </div>

        <div className="mt-4 space-y-3">
          <label className="mt-3 block text-sm font-bold">فهرست ممنوع پایه (قابل کنترل)</label>
          <KeywordListEditor
            className="mt-2 w-full rounded-lg border border-line p-3 text-sm"
            rows={3}
            values={draft.topicFilter?.baselineBlockedKeywords ?? [...BASELINE_BLOCKED_KEYWORDS]}
            onValuesChange={baselineBlockedKeywords => setDraft({ ...draft, topicFilter: { ...(draft.topicFilter ?? DEFAULT_TOPIC_FILTER), baselineBlockedKeywords } })}
          />
          <button type="button" className="my-2 text-xs text-muted" onClick={() => setDraft({ ...draft, topicFilter: { ...(draft.topicFilter ?? DEFAULT_TOPIC_FILTER), baselineBlockedKeywords: [...BASELINE_BLOCKED_KEYWORDS] } })}>بازنشانی فهرست پایه به پیش‌فرض</button>
          {(draft.topicFilter?.topics ?? []).length === 0 ? (
            <p className="rounded-xl border border-dashed border-line bg-surface-2/70 px-4 py-6 text-center text-sm text-faint">
              هنوز موضوعی تعریف نشده است. تا زمانی که موضوعی با کلیدواژه نداشته باشید، فیلتری اعمال نمی‌شود.
            </p>
          ) : (
            (draft.topicFilter?.topics ?? []).map((topic, index) => (
              <AiConfigTopicRow
                key={topic.id || index}
                onChange={(next) => {
                  const topics = [...(draft.topicFilter?.topics ?? [])];
                  topics[index] = next;
                  setDraft({ ...draft, topicFilter: { ...(draft.topicFilter ?? DEFAULT_TOPIC_FILTER), topics } });
                }}
                onRemove={() => {
                  const topics = (draft.topicFilter?.topics ?? []).filter((_, i) => i !== index);
                  setDraft({ ...draft, topicFilter: { ...(draft.topicFilter ?? DEFAULT_TOPIC_FILTER), topics } });
                }}
                value={topic}
              />
            ))
          )}
        </div>
      </section>

      {/* E2. Auto-send policy (Agent / Bale delivery conditions) */}
      <section className="rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-ink">سیاست ارسال خودکار (Agent / بله)</h2>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-ink-soft">
            <input
              checked={draft.autoSendPolicy?.useCustom ?? false}
              className="h-4 w-4 accent-blue-600"
              onChange={(event) =>
                setDraft({
                  ...draft,
                  autoSendPolicy: { ...(draft.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY), useCustom: event.target.checked },
                })
              }
              type="checkbox"
            />
            استفاده از تنظیمات این بخش (به‌جای متغیرهای محیطی)
          </label>
        </div>
        <p className="mt-1 text-sm text-muted">
          شرایط ارسال خودکار تحلیل‌شده‌ها به مقصد بله/Local. تا وقتی گزینه بالا فعال نیست، رفتار تاریخی سامانه (متغیرهای
          محیطی <code className="rounded bg-surface-3 px-1">AUTO_SEND_*</code>) حفظ می‌شود. با فعال‌سازی، مقادیر زیر روی
          نسخه پیکربندی ذخیره و قابل ردیابی می‌شوند.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="ارسال خودکار">
            <select
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm disabled:bg-surface-2 disabled:text-faint"
              disabled={!draft.autoSendPolicy?.useCustom}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  autoSendPolicy: {
                    ...(draft.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY),
                    enabled: event.target.value === "true",
                  },
                })
              }
              value={String(draft.autoSendPolicy?.enabled ?? true)}
            >
              <option value="true">روشن</option>
              <option value="false">خاموش</option>
            </select>
          </Field>
          <Field label="مقصد ارسال">
            <select
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm disabled:bg-surface-2 disabled:text-faint"
              disabled={!draft.autoSendPolicy?.useCustom}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  autoSendPolicy: {
                    ...(draft.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY),
                    destination: event.target.value as AiAutoSendPolicy["destination"],
                  },
                })
              }
              value={draft.autoSendPolicy?.destination ?? "local"}
            >
              <option value="local">Local</option>
              <option value="bale">بله (Bale)</option>
              <option value="both">Local و بله</option>
            </select>
          </Field>
          <Field label="حداقل اهمیت (۰-۱۰۰)">
            <input
              className="w-full rounded-lg border border-line px-3 py-2 text-sm disabled:bg-surface-2 disabled:text-faint"
              disabled={!draft.autoSendPolicy?.useCustom}
              max={100}
              min={0}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  autoSendPolicy: {
                    ...(draft.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY),
                    minImportance: Number(event.target.value),
                  },
                })
              }
              type="number"
              value={draft.autoSendPolicy?.minImportance ?? 50}
            />
          </Field>
          <Field label="حداقل مرتبط بودن (۰-۱۰۰)">
            <input
              className="w-full rounded-lg border border-line px-3 py-2 text-sm disabled:bg-surface-2 disabled:text-faint"
              disabled={!draft.autoSendPolicy?.useCustom}
              max={100}
              min={0}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  autoSendPolicy: {
                    ...(draft.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY),
                    minRelevance: Number(event.target.value),
                  },
                })
              }
              type="number"
              value={draft.autoSendPolicy?.minRelevance ?? 50}
            />
          </Field>
          <Field label="حداقل تازگی (۰-۱۰۰)">
            <input
              className="w-full rounded-lg border border-line px-3 py-2 text-sm disabled:bg-surface-2 disabled:text-faint"
              disabled={!draft.autoSendPolicy?.useCustom}
              max={100}
              min={0}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  autoSendPolicy: {
                    ...(draft.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY),
                    minNovelty: Number(event.target.value),
                  },
                })
              }
              type="number"
              value={draft.autoSendPolicy?.minNovelty ?? 0}
            />
          </Field>
          <Field label="سقف اخبار هر نوبت (۱-۱۰۰)">
            <input
              className="w-full rounded-lg border border-line px-3 py-2 text-sm disabled:bg-surface-2 disabled:text-faint"
              disabled={!draft.autoSendPolicy?.useCustom}
              max={100}
              min={1}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  autoSendPolicy: {
                    ...(draft.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY),
                    maxItemsPerPass: Number(event.target.value),
                  },
                })
              }
              type="number"
              value={draft.autoSendPolicy?.maxItemsPerPass ?? 20}
            />
          </Field>
          <Field label="دسته‌های مجاز (جدا با ویرگول؛ خالی = همه)">
            <KeywordListEditor
              className="w-full rounded-lg border border-line px-3 py-2 text-sm disabled:bg-surface-2 disabled:text-faint"
              disabled={!draft.autoSendPolicy?.useCustom}
              onValuesChange={(categories) =>
                setDraft({
                  ...draft,
                  autoSendPolicy: {
                    ...(draft.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY),
                    categories,
                  },
                })
              }
              rows={1}
              placeholder="مثال: اقتصاد، بازار"
              values={draft.autoSendPolicy?.categories ?? []}
            />
          </Field>
          <Field label="الزام پیشنهاد AI (shouldSend)">
            <select
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm disabled:bg-surface-2 disabled:text-faint"
              disabled={!draft.autoSendPolicy?.useCustom}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  autoSendPolicy: {
                    ...(draft.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY),
                    requireAiRecommendation: event.target.value === "true",
                  },
                })
              }
              value={String(draft.autoSendPolicy?.requireAiRecommendation ?? false)}
            >
              <option value="false">خیر</option>
              <option value="true">بله</option>
            </select>
          </Field>
        </div>
      </section>

      {/* F. Output Schema */}
      <section className="rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6">
        <h2 className="text-base font-bold text-ink">ساختار خروجی (Output Schema)</h2>
        <p className="mt-1 text-sm text-muted">فیلدهای مورد انتظار در پاسخ JSON هوش مصنوعی. فقط فیلدهایی که هم اینجا و هم در ویژگی‌های تحلیل فعال‌اند، مصرف و ذخیره می‌شوند. تغییرات پس از ذخیره و فعال‌سازی، روی تحلیل‌های بعدی اعمال می‌شوند.</p>
        <div className="mt-4 space-y-2">
          {draft.outputSchema.map((field, index) => (
            <AiConfigOutputFieldRow
              key={field.name}
              locked={LOCKED_FEATURES.includes(field.name)}
              onChange={(next) => {
                const updated = [...draft.outputSchema];
                updated[index] = next;
                setDraft({ ...draft, outputSchema: updated });
              }}
              value={field}
            />
          ))}
        </div>
      </section>

      {/* G. Publishing Template (Milestone 8) */}
      <section className="rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-ink">قالب انتشار (Publishing Template)</h2>
          <button
            className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2"
            onClick={() => setDraft({ ...draft, publishingTemplate: DEFAULT_PUBLISHING_TEMPLATE })}
            type="button"
          >
            بازنشانی قالب پیش‌فرض
          </button>
        </div>
        <p className="mt-1 text-sm text-muted">
          ظاهری که خبر تحلیل‌شده با آن ارسال می‌شود. این متن روی همان نسخه پیکربندی ذخیره می‌شود؛ تغییر آن
          خلاصه، امتیازها یا تحلیل خبر را دست نمی‌کند و هیچ ارسال خودکاری انجام نمی‌دهد.
          قالب فعال برای پیام‌های جدید استفاده می‌شود؛ پیام‌های از قبل ساخته‌شده و بولتن تجمیعی تغییر نمی‌کنند.
          پیش‌نمایش قالب با پاسخ واقعی مدل در بخش تست پیکربندی نمایش داده می‌شود.
        </p>
        <textarea
          className="mt-3 w-full resize-y rounded-xl border border-line px-3 py-2.5 font-mono text-xs leading-6 text-ink-soft focus:border-accent focus:outline-none"
          dir="rtl"
          onChange={(event) => setDraft({ ...draft, publishingTemplate: event.target.value })}
          rows={10}
          value={draft.publishingTemplate}
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted">متغیرها:</span>
          {PUBLISHING_TEMPLATE_VARS.map((name) => (
            <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] text-muted" key={name}>
              {`{${name}}`}
            </code>
          ))}
        </div>
        {unknownTemplateVars.length > 0 ? (
          <p className="mt-2 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-xs text-warn-ink">
            متغیر ناشناخته: {unknownTemplateVars.map((name) => `{${name}}`).join("، ")} — این‌ها در پیام نهایی باقی
            می‌مانند و مقدارگیری نمی‌شوند.
          </p>
        ) : null}
        <p className="mt-2 text-[11px] text-faint">
          خالی گذاشتن این فیلد یعنی استفاده از چیدمان داخلی قبلی (سازگاری با پیکربندی‌های پیشین).
        </p>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-5 space-y-3">
        <h2 className="font-bold">کنترل‌های تکمیلی تحلیل</h2>
        <label className="block text-sm">ارزیابی آزمایشی (داخل همان درخواست؛ توکن بیشتر، بدون اثر مستقیم بر ارسال)
          <select className="mx-2 rounded border border-line p-2" value={draft.decisionRules.shadowEvaluationEnabled === undefined ? "env" : String(draft.decisionRules.shadowEvaluationEnabled)} onChange={event => setDraft({ ...draft, decisionRules: { ...draft.decisionRules, shadowEvaluationEnabled: event.target.value === "env" ? undefined : event.target.value === "true" } })}>
            <option value="env">پیروی از تنظیم محیط سرور</option><option value="true">روشن</option><option value="false">خاموش</option>
          </select>
        </label>
        <label className="block text-sm"><input type="checkbox" checked={draft.decisionRules.graderEnabled !== false} onChange={event => setDraft({ ...draft, decisionRules: { ...draft.decisionRules, graderEnabled: event.target.checked } })} /> داور دوم برای امتیازهای مرزی (یک درخواست اضافه)</label>
        <div className="flex gap-3">
          {(["graderMin", "graderMax"] as const).map(key => <label key={key} className="text-sm">{key === "graderMin" ? "حداقل امتیاز داوری" : "حداکثر امتیاز داوری"}<input type="number" min={0} max={100} className="mx-2 w-20 rounded border border-line p-2" value={draft.decisionRules[key] ?? (key === "graderMin" ? 55 : 70)} onChange={event => setDraft({ ...draft, decisionRules: { ...draft.decisionRules, [key]: Number(event.target.value) } })} /></label>)}
        </div>
        <div className="flex flex-wrap gap-3">
          {([{key: "shadowMinImportance", label: "حداقل اهمیت آزمایشی", fallback: 60, max: 100}, {key: "freshHours", label: "بازه خبر تازه (ساعت)", fallback: 24, max: 8760}, {key: "recentHours", label: "بازه خبر اخیر (ساعت)", fallback: 72, max: 8760}] as const).map(item => <label key={item.key} className="text-sm">{item.label}<input type="number" min={item.key === "shadowMinImportance" ? 0 : 1} max={item.max} className="mx-2 w-20 rounded border border-line p-2" value={draft.decisionRules[item.key] ?? item.fallback} onChange={event => setDraft({ ...draft, decisionRules: { ...draft.decisionRules, [item.key]: Number(event.target.value) } })} /></label>)}
        </div>
        <p className="text-xs text-muted">بازه‌های زمانی و حداقل اهمیت بالا فقط پیشنهاد ارزیابی آزمایشی را تغییر می‌دهند؛ شرط ارسال واقعی نیستند. وزن اهمیت فعلاً ثابت است: شدت ۵۰٪، گستردگی ۳۰٪، فوریت ۲۰٪.</p>
        <p className="text-xs text-muted">تست، نیاز به داور دوم را نمایش می‌دهد اما درخواست داور را اجرا نمی‌کند. نتیجهٔ ارزیابی آزمایشی نیز در پیش‌نمایش دیده می‌شود.</p>
      </section>

      <BulletinConfigPanel value={draft.decisionRules.bulletin} onChange={bulletin => setDraft({ ...draft, decisionRules: { ...draft.decisionRules, bulletin } })} />

      {/* Test Configuration */}
      <AiConfigTestPanel adminKey={adminKey} draftConfig={draft} />

      {/* Version History */}
      <AiConfigVersionHistory
        activating={activatingId}
        loading={versionsLoading}
        onActivate={handleActivateVersion}
        versions={versions}
      />

      {/* Validation feedback + action buttons */}
      <section className="sticky bottom-4 rounded-2xl border border-line bg-surface/95 p-4 shadow-lg backdrop-blur sm:p-5">
        {saveErrors.length > 0 ? (
          <ul className="mb-3 space-y-1 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">
            {saveErrors.map((error, index) => (
              <li key={index}>• {error}</li>
            ))}
          </ul>
        ) : null}
        {saveSuccess ? (
          <p className="mb-3 rounded-xl border border-ok-line bg-ok-soft p-3 text-sm text-ok-ink">{saveSuccess}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            className="rounded-xl bg-accent px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-accent-line"
            disabled={saving !== null}
            onClick={() => handleSave(true)}
            type="button"
          >
            {saving === "activate" ? "در حال ذخیره..." : "ذخیره و فعال‌سازی"}
          </button>
          <button
            className="rounded-xl border border-accent-line bg-accent-soft px-5 py-2.5 text-sm font-bold text-accent-ink transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60"
            disabled={saving !== null}
            onClick={() => handleSave(false)}
            type="button"
          >
            {saving === "draft" ? "در حال ذخیره..." : "ذخیره به‌عنوان پیش‌نویس"}
          </button>
          <button
            className="rounded-xl border border-line px-5 py-2.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2"
            disabled={saving !== null}
            onClick={handleResetToDefault}
            type="button"
          >
            بازنشانی به پیش‌فرض
          </button>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
