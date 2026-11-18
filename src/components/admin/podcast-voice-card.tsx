"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * «صدای پادکست» — a probe + audition for reading the bulletin aloud with the **same
 * AI service that already writes it**, so the decision about the weekly podcast is
 * made from evidence instead of a guess about the provider.
 *
 * The GET is free: it only reports which speech route the configured key resolves
 * to. The button is the only thing that calls the provider, and it never writes to
 * the database or sends a message — the clip lives in a blob URL until the page is
 * closed. If the service has no speech endpoint the card says so plainly, with the
 * provider's own reason, and the podcast simply stays text-only.
 */

type Capability = {
  configured: boolean;
  supported: boolean;
  route: string;
  model: string;
  voice: string;
  format: string;
  endpoint: string;
  maxChars: number;
  note?: string;
  message?: string;
  suggestedModels?: string[];
  suggestedVoices?: string[];
};

type SampleResult = {
  ok: boolean;
  message?: string;
  /** Machine-readable class from `classifyTtsProviderError` (e.g. service_not_enabled). */
  code?: string | null;
  /** The provider's own sentence, stripped and redacted. */
  detail?: string | null;
  /** A fix link the provider itself supplied. */
  actionUrl?: string | null;
  chars?: number;
  bytes?: number;
  truncated?: boolean;
  format?: string;
  errorKind?: string;
};

const SAMPLE_TEXT =
  "سلام. این صدای پادکست هفتهٔ دستیار هوشمند اخبار است؛ همان متنی که برای کاناله خلاصه می‌شود، این بار خوانده می‌شود.";

function hostOf(endpoint: string): string {
  const match = /^https?:\/\/([^/]+)/i.exec(endpoint || "");
  return match ? match[1] : endpoint || "—";
}

export function PodcastVoiceCard({ adminKey }: { adminKey: string }) {
  const [capability, setCapability] = useState<Capability | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState(SAMPLE_TEXT);
  const [model, setModel] = useState("");
  const [voice, setVoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<SampleResult | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  // The page already gated access and hands the key down as a prop; it travels in a
  // header so the probe never reads the URL (same convention as the AI console).
  const headers = useMemo<Record<string, string>>(() => {
    const value: Record<string, string> = {};
    if (adminKey) value["x-admin-key"] = adminKey;
    return value;
  }, [adminKey]);
  /**
   * State is set only inside `.then`/`.catch` on purpose (same shape as the AI
   * console's `loadActive`): a `setState` in the body of an effect — or of a function
   * the effect calls synchronously — is a cascading render, and `loading` already
   * starts true so nothing has to be set before the request resolves.
   */
  const loadCapability = useCallback(() => {
    return fetch("/api/ai/tts", { headers, cache: "no-store" })
      .then(async (response) => ({
        status: response.status,
        ok: response.ok,
        data: (await response.json().catch(() => null)) as (Capability & { success?: boolean }) | null,
      }))
      .then(({ status, ok, data }) => {
        setCapability(data ?? null);
        setError(
          !ok || data?.success === false ? String(data?.message ?? `خطا (${status})`) : null,
        );
      })
      .catch(() => {
        setError("ارتباط با /api/ai/tts برقرار نشد.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [headers]);

  useEffect(() => {
    void loadCapability();
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [loadCapability]);

  const audition = async () => {
    setBusy(true);
    setError(null);
    setMeta(null);
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setAudioUrl(null);
    try {
      const response = await fetch("/api/ai/tts?format=audio", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ text, ...(model ? { model } : {}), ...(voice ? { voice } : {}) }),
        cache: "no-store",
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("audio/")) {
        // Any non-audio reply is the JSON error envelope: show the provider's own
        // reason (already redacted server-side), never a generic "something failed".
        const data = (await response.json().catch(() => null)) as SampleResult | null;
        // `meta` carries the classified failure, which is what renders the fix link.
        setMeta(data);
        setError(
          String(
            data?.message ??
              (response.ok
                ? "پاسخ سرویس فایل صوتی نبود؛ مسیر صوتی این درگاه کار نمی‌کند."
                : `خطا (${response.status})`),
          ),
        );
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setAudioUrl(url);
      setMeta({ ok: true, bytes: blob.size, format: contentType.includes("wav") ? "wav" : "mp3" });
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "خطای نامشخص");
    } finally {
      setBusy(false);
    }
  };

  const supported = Boolean(capability?.supported);
  const heading = loading
    ? "در حال بررسی سرویس فعلی…"
    : supported
      ? "سرویس فعلی می‌تواند پادکست را بخواند"
      : capability?.configured
        ? "سرویس فعلی endpoint صوتی ندارد"
        : "کلید هوش مصنوعی تنظیم نشده است";

  return (
    <section className="rounded-2xl border border-line bg-surface p-5 space-y-3" id="podcast-voice">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-bold">صدای پادکست (با همان سرویس هوش مصنوعی)</h2>
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold ${
            loading
              ? "bg-surface-2 text-muted"
              : supported
                ? "bg-ok-soft text-ok-ink"
                : "bg-warn-soft text-warn-ink"
          }`}
        >
          {loading ? "…" : supported ? "پشتیبانی‌شده" : capability?.configured ? "بدون مسیر صوتی" : "پیکربندی‌نشده"}
        </span>
        <button
          className="rounded-lg border border-line px-3 py-1 text-xs hover:bg-surface-2"
          onClick={() => {
            setLoading(true);
            void loadCapability();
          }}
          type="button"
        >
          بازخوانی
        </button>
      </div>

      <p className="text-sm leading-6 text-muted">
        {heading}
        {capability?.note ? <span className="text-ink"> — {capability.note}</span> : null}
      </p>

      {capability ? (
        <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl bg-surface-2 p-3">
            <div className="text-muted">مسیر</div>
            <div className="font-mono">{capability.route}</div>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <div className="text-muted">مدل صوتی (AI_TTS_MODEL)</div>
            <div className="font-mono break-all">{capability.model}</div>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <div className="text-muted">صدا (AI_TTS_VOICE)</div>
            <div className="font-mono">{capability.voice}</div>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <div className="text-muted">میزبان / فرمت</div>
            <div className="font-mono break-all">
              {hostOf(capability.endpoint)} · {capability.format} · تا {capability.maxChars} نویسه
            </div>
          </div>
        </div>
      ) : null}

      {supported ? (
        <div className="space-y-2 rounded-xl border border-line p-3">
          <label className="block text-sm">
            متن نمونه
            <textarea
              className="mt-1 w-full rounded-lg border border-line p-2 text-sm"
              dir="rtl"
              onChange={event => setText(event.target.value)}
              rows={3}
              value={text}
            />
          </label>
          <div className="flex flex-wrap gap-2 text-sm">
            <label className="flex-1 min-w-[220px]">
              مدل (اختیاری)
              <input
                className="mt-1 w-full rounded-lg border border-line p-2 font-mono text-xs"
                list="tts-models"
                onChange={event => setModel(event.target.value)}
                placeholder={capability?.model ?? ""}
                value={model}
              />
              <datalist id="tts-models">
                {(capability?.suggestedModels ?? []).map(item => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </label>
            <label className="flex-1 min-w-[220px]">
              صدا (اختیاری)
              <input
                className="mt-1 w-full rounded-lg border border-line p-2 font-mono text-xs"
                list="tts-voices"
                onChange={event => setVoice(event.target.value)}
                placeholder={capability?.voice ?? ""}
                value={voice}
              />
              <datalist id="tts-voices">
                {(capability?.suggestedVoices ?? []).map(item => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </label>
            <div className="flex items-end">
              <button
                className="rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
                disabled={busy || !text.trim()}
                onClick={() => void audition()}
                type="button"
              >
                {busy ? "در حال ساخت صوت…" : "تست و پخش نمونه"}
              </button>
            </div>
          </div>
          {audioUrl ? (
            <div className="space-y-1">
              <audio controls src={audioUrl} />
              {meta?.bytes ? (
                <p className="text-xs text-muted">
                  {meta.format?.toUpperCase()} · {meta.bytes.toLocaleString("fa-IR")} بایت — فقط در همین مرورگر نگه
                  داشته می‌شود؛ چیزی ذخیره یا ارسال نمی‌شود.
                  {meta.truncated ? " متن نمونه به سقف نویسه‌ها بریده شد (AI_TTS_MAX_CHARS)." : ""}
                </p>
              ) : null}
              <a className="text-xs text-brand underline" download={`ecoai-podcast-sample.${meta?.format ?? "mp3"}`} href={audioUrl}>
                دانلود فایل نمونه
              </a>
            </div>
          ) : null}
          {error || meta?.code ? (
            <div className="space-y-2 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">
              <p className="leading-6">{error ?? meta?.message}</p>
              {meta?.actionUrl ? (
                <a
                  className="inline-block break-all rounded-lg border border-danger-line bg-surface px-3 py-1.5 text-xs underline"
                  href={meta.actionUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  پیوند اصلاحی خودِ سرویس (کنسول Google)
                </a>
              ) : null}
              {meta?.detail ? (
                <p className="text-xs leading-5 text-muted" dir="ltr">
                  {meta.detail}
                </p>
              ) : null}
              <p className="text-xs leading-5 text-muted">
                دلیل و راه‌حل از پاسخ خودِ سرویس استخراج شده است؛ اگر تحلیل هم همین
                ساعت‌ها خطا داشته، هر دو از یک اختلال رنج می‌برند و اول آن یکی را درست کنید.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-xs leading-5 text-muted">
          برای فعال‌سازی کافی است کلید یک سرویس دارای مسیر صوتی (OpenAI یا Google) را در{" "}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">AI_API_KEY</code> /{" "}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">AI_API_BASE_URL</code> بگذارید؛ تحلیل و
          پادکست هر دو همان را می‌خوانند و نیازی به متغیر جدید نیست.
          {error ? ` (${error})` : ""}
        </p>
      )}
    </section>
  );
}
