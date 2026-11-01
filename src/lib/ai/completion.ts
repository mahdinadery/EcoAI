/**
 * Low-level AI chat-completion transport — SERVER-SIDE ONLY.
 *
 * Extracted so both the production analysis pipeline (runAiAnalysis in
 * src/lib/ai/client.ts) and the admin "Test Configuration" panel
 * (src/app/api/admin/ai-config/test/route.ts) can obtain the *raw* AI response
 * text through the exact same network call, instead of duplicating fetch logic.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const GROQ_OPENAI_BASE_URL = "https://api.groq.com/openai/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";

const REQUEST_TIMEOUT_MS = 30_000;
const FALLBACK_COMPACT_MAX_TOKENS = 1_200;

const MAX_RETRIES = 2;
const RATE_LIMIT_BUFFER_MS = 1_000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 522, 524, 529]);

export type CompletionErrorKind =
  | "missing_key"
  | "timeout"
  | "network_error"
  | "http_error"
  | "api_error";

export type AiTokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type CompletionResult =
  | { ok: true; rawText: string; model: string; usage: AiTokenUsage | null }
  | {
      ok: false;
      kind: CompletionErrorKind;
      message: string;
      detail?: string | null;
    };

/**
 * Resolves the AI provider API key from `AI_API_KEY` or common provider-specific
 * aliases so minor Render/Docker naming differences do not break analysis.
 */
export function resolveAiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.AI_API_KEY?.trim() ||
    env.OPENAI_API_KEY?.trim() ||
    env.GEMINI_API_KEY?.trim() ||
    env.GROQ_API_KEY?.trim() ||
    env.OPENROUTER_API_KEY?.trim() ||
    ""
  );
}

/**
 * Infers the OpenAI-compatible base URL from well-known API key prefixes when
 * `AI_API_BASE_URL` / `AI_BASE_URL` was left blank in the host environment.
 */
export function inferBaseUrlFromApiKey(apiKey?: string | null): string | null {
  const key = apiKey?.trim() ?? "";
  if (!key) return null;
  if (key.startsWith("AIza")) return GEMINI_OPENAI_BASE_URL;
  if (key.startsWith("gsk_")) return GROQ_OPENAI_BASE_URL;
  if (key.startsWith("sk-or-")) return OPENROUTER_BASE_URL;
  return null;
}

/**
 * Normalizes common OpenAI-compatible provider base URLs so minor configuration
 * slips (trailing `/chat/completions`, missing `/v1` or `/openai`, or unset URL
 * with a recognizable Gemini/Groq/OpenRouter key) still route to the right endpoint.
 */
export function normalizeAiBaseUrl(rawBaseUrl?: string | null, apiKey?: string | null): string {
  const explicit = (rawBaseUrl?.trim() ?? "")
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "");

  const base = explicit || inferBaseUrlFromApiKey(apiKey) || DEFAULT_BASE_URL;

  if (/^https:\/\/generativelanguage\.googleapis\.com(?:\/v1beta)?$/i.test(base)) {
    return GEMINI_OPENAI_BASE_URL;
  }
  if (/^https:\/\/api\.groq\.com(?:\/openai)?$/i.test(base)) {
    return GROQ_OPENAI_BASE_URL;
  }
  if (/^https:\/\/openrouter\.ai(?:\/api)?$/i.test(base)) {
    return OPENROUTER_BASE_URL;
  }

  return base;
}

/**
 * Resolves the effective base URL from environment variables (`AI_API_BASE_URL`,
 * `AI_BASE_URL`, `OPENAI_BASE_URL`) with key-prefix fallback.
 */
export function resolveEffectiveBaseUrl(apiKey?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AI_API_BASE_URL?.trim() || env.AI_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || "";
  return normalizeAiBaseUrl(raw, apiKey);
}

function defaultModelForBaseUrl(baseUrl: string): string {
  if (/generativelanguage\.googleapis\.com/i.test(baseUrl)) return DEFAULT_GEMINI_MODEL;
  if (/api\.groq\.com/i.test(baseUrl)) return DEFAULT_GROQ_MODEL;
  if (/openrouter\.ai/i.test(baseUrl)) return DEFAULT_OPENROUTER_MODEL;
  return DEFAULT_MODEL;
}

export function resolveEffectiveModel(
  configModel: string | undefined,
  options?: { baseUrl?: string; apiKey?: string | null; env?: NodeJS.ProcessEnv },
): string {
  const env = options?.env ?? process.env;
  const explicit = configModel?.trim() || env.AI_API_MODEL?.trim() || env.AI_MODEL?.trim();
  if (explicit) return explicit;

  const baseUrl = options?.baseUrl ?? resolveEffectiveBaseUrl(options?.apiKey ?? resolveAiApiKey(env), env);
  return defaultModelForBaseUrl(baseUrl);
}

/**
 * Extracts a concise human-readable error message from OpenAI, Google Gemini
 * (`[{ error: { message } }]`), OpenRouter (`{ error: { message, metadata } }`),
 * or plain-text upstream error payloads.
 */
export function extractProviderErrorReason(rawBody: string): string | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const root = Array.isArray(parsed) ? parsed[0] : parsed;
    if (root && typeof root === "object") {
      const record = root as Record<string, unknown>;
      const errObj =
        record.error && typeof record.error === "object"
          ? (record.error as Record<string, unknown>)
          : record;
      const msg = typeof errObj.message === "string" ? errObj.message.trim() : "";
      const metaRaw =
        errObj.metadata &&
        typeof errObj.metadata &&
        typeof (errObj.metadata as Record<string, unknown>).raw === "string"
          ? ((errObj.metadata as Record<string, unknown>).raw as string).trim()
          : "";
      const combined = msg && metaRaw && !msg.includes(metaRaw) ? `${msg} (${metaRaw})` : msg || metaRaw;
      if (combined) return combined.replace(/\s+/g, " ").slice(0, 280);
    }
  } catch {
    // Non-JSON error body (e.g. Cloudflare / HTML 503 gateway page)
  }

  if (/^<!doctype html|^<html/i.test(trimmed)) {
    const titleMatch = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch?.[1]) {
      return titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 160);
    }
    return "Upstream gateway returned an HTML error page.";
  }

  return trimmed.replace(/\s+/g, " ").slice(0, 280);
}

/**
 * Extracts normalized token counts from an OpenAI-compatible `usage` object.
 * Returns null when the provider omitted usage metrics.
 */
export function extractTokenUsage(usagePayload: unknown): AiTokenUsage | null {
  if (!usagePayload || typeof usagePayload !== "object") return null;
  const raw = usagePayload as Record<string, unknown>;

  const promptRaw = Number(raw.prompt_tokens ?? raw.promptTokens);
  const completionRaw = Number(raw.completion_tokens ?? raw.completionTokens);
  const totalRaw = Number(raw.total_tokens ?? raw.totalTokens);

  const hasPrompt = Number.isFinite(promptRaw) && promptRaw >= 0;
  const hasCompletion = Number.isFinite(completionRaw) && completionRaw >= 0;
  const hasTotal = Number.isFinite(totalRaw) && totalRaw >= 0;

  if (!hasPrompt && !hasCompletion && !hasTotal) return null;

  const promptTokens = hasPrompt ? Math.round(promptRaw) : 0;
  const completionTokens = hasCompletion ? Math.round(completionRaw) : 0;
  const totalTokens = hasTotal ? Math.round(totalRaw) : promptTokens + completionTokens;

  return { promptTokens, completionTokens, totalTokens };
}

/** Sums two token-usage snapshots (e.g. primary analysis + borderline grader). */
export function mergeTokenUsage(
  first: AiTokenUsage | null | undefined,
  second: AiTokenUsage | null | undefined,
): AiTokenUsage | null {
  if (!first && !second) return null;
  if (!first) return second ?? null;
  if (!second) return first;
  return {
    promptTokens: first.promptTokens + second.promptTokens,
    completionTokens: first.completionTokens + second.completionTokens,
    totalTokens: first.totalTokens + second.totalTokens,
  };
}

function sanitizeSecrets(text: string, apiKey?: string): string {
  const key = apiKey?.trim() || resolveAiApiKey();
  if (!key) return text;
  return text.split(key).join("[REDACTED_API_KEY]");
}

function extractRetryWaitMs(detail: string, retryAfterHeader: string | null): number | null {
  if (retryAfterHeader) {
    const headerSeconds = Number(retryAfterHeader.trim());
    if (Number.isFinite(headerSeconds) && headerSeconds >= 0 && headerSeconds <= 60) {
      return Math.ceil(headerSeconds * 1000);
    }
  }

  // Groq / Gemini commonly return: "Please try again in 7.86s." or "retryDelay: 5s"
  const secondsMatch = detail.match(/(?:try again in|retry(?:Delay)?["\s:=]+)\s*([\d.]+)\s*s/i);
  if (secondsMatch) {
    const seconds = Number(secondsMatch[1]);
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 60) {
      return Math.ceil(seconds * 1000);
    }
  }

  return null;
}

function shouldDropJsonObjectFormat(status: number, detail: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422 && status !== 503) return false;
  return /response_format|json_object|json mode|structured output|no endpoints found/i.test(detail);
}

function shouldSwitchToMaxCompletionTokens(status: number, detail: string): boolean {
  return status === 400 && /max_completion_tokens|max_tokens.*not supported/i.test(detail);
}

function shouldDropTemperature(status: number, detail: string): boolean {
  return status === 400 && /temperature.*(?:not supported|only the default|must be 1)/i.test(detail);
}

function shouldShrinkTokenBudget(status: number, detail: string): boolean {
  if (status === 413) return true;
  if (status === 402 && /max_tokens|fewer max_tokens|afford/i.test(detail)) return true;
  if (status === 400 && /max_tokens.*(?:exceed|maximum|limit|context)/i.test(detail)) return true;
  if (status === 429 && /request too large|tokens per minute|tpm/i.test(detail)) return true;
  return false;
}

function describeHttpStatusFa(status: number, model: string): string {
  if (status === 503 || status === 529) {
    return `سرویس هوش مصنوعی موقتاً در دسترس نیست یا مدل «${model}» شلوغ است (HTTP ${status}).`;
  }
  if (status === 429) {
    return `سقف تعداد درخواست یا توکن سرویس هوش مصنوعی برای مدل «${model}» پر شده است (HTTP 429).`;
  }
  if (status === 401 || status === 403) {
    return `کلید دسترسی یا مجوز سرویس هوش مصنوعی پذیرفته نشد (HTTP ${status}).`;
  }
  if (status === 402) {
    return `اعتبار حساب سرویس هوش مصنوعی کافی نیست (HTTP 402).`;
  }
  if (status === 404) {
    return `مدل «${model}» یا آدرس سرویس هوش مصنوعی یافت نشد (HTTP 404).`;
  }
  return `سرویس هوش مصنوعی خطای HTTP ${status} بازگرداند (مدل: ${model}).`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callAiChatCompletion(
  params: {
    systemPrompt: string;
    userPrompt: string;
    model?: string;
    temperature: number;
    maxTokens: number;
  },
  options?: {
    fetchImpl?: typeof fetch;
    retryBaseDelayMs?: number;
    timeoutMs?: number;
    maxRetries?: number;
  },
): Promise<CompletionResult> {
  const apiKey = resolveAiApiKey();

  if (!apiKey) {
    return {
      ok: false,
      kind: "missing_key",
      message: "کلید API برای هوش مصنوعی (AI_API_KEY) در تنظیمات سرور ثبت نشده است.",
      detail: "در بخش Environment سرویس Render متغیر AI_API_KEY را مقداردهی کنید.",
    };
  }

  const baseUrl = resolveEffectiveBaseUrl(apiKey);
  const model = resolveEffectiveModel(params.model, { baseUrl, apiKey });
  const fetchFn = options?.fetchImpl ?? fetch;
  const retryBaseMs = options?.retryBaseDelayMs ?? 2_000;
  const requestTimeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? MAX_RETRIES;

  let useJsonObjectFormat = true;
  let useMaxCompletionTokens = false;
  let includeTemperature = true;
  let effectiveMaxTokens = params.maxTokens;
  let effectiveUserPrompt = params.userPrompt;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);

    try {
      const requestBody: Record<string, unknown> = {
        model,
        messages: [
          {
            role: "system",
            content: params.systemPrompt,
          },
          {
            role: "user",
            content: effectiveUserPrompt,
          },
        ],
      };

      if (includeTemperature) {
        requestBody.temperature = params.temperature;
      }
      if (useMaxCompletionTokens) {
        requestBody.max_completion_tokens = effectiveMaxTokens;
      } else {
        requestBody.max_tokens = effectiveMaxTokens;
      }
      if (useJsonObjectFormat) {
        requestBody.response_format = { type: "json_object" };
      }

      const response = await fetchFn(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        cache: "no-store",
      });

      clearTimeout(timer);

      if (!response.ok) {
        const rawErr = await response.text().catch(() => "");
        const safeDetail = sanitizeSecrets(rawErr, apiKey);
        const conciseReason = extractProviderErrorReason(safeDetail);

        // 1) Reasoning-model compatibility: switch max_tokens -> max_completion_tokens / drop custom temperature
        if (!useMaxCompletionTokens && shouldSwitchToMaxCompletionTokens(response.status, safeDetail) && attempt < maxRetries) {
          useMaxCompletionTokens = true;
          if (shouldDropTemperature(response.status, safeDetail)) includeTemperature = false;
          continue;
        }
        if (includeTemperature && shouldDropTemperature(response.status, safeDetail) && attempt < maxRetries) {
          includeTemperature = false;
          continue;
        }

        // 2) Fallback once if the upstream model rejects `response_format: { type: "json_object" }`
        if (useJsonObjectFormat && shouldDropJsonObjectFormat(response.status, safeDetail) && attempt < maxRetries) {
          useJsonObjectFormat = false;
          console.warn(`[ai] Model "${model}" rejected json_object response_format (HTTP ${response.status}); retrying without it.`);
          continue;
        }

        // 3) Free-tier TPM / OpenRouter credit cap fallback: shrink max_tokens and trim long article body
        if (
          effectiveMaxTokens > FALLBACK_COMPACT_MAX_TOKENS &&
          shouldShrinkTokenBudget(response.status, safeDetail) &&
          attempt < maxRetries
        ) {
          effectiveMaxTokens = FALLBACK_COMPACT_MAX_TOKENS;
          if (effectiveUserPrompt.length > 4_000) {
            effectiveUserPrompt = `${effectiveUserPrompt.slice(0, 4_000)}\n[...]`;
          }
          console.warn(`[ai] Shrinking max_tokens to ${FALLBACK_COMPACT_MAX_TOKENS} after HTTP ${response.status} for model "${model}".`);
          continue;
        }

        // 4) Retry rate-limit (429) and transient server/overload statuses (500/502/503/504/529)
        if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt < maxRetries) {
          const providerWaitMs = extractRetryWaitMs(safeDetail, response.headers.get("retry-after"));
          const fallbackBackoffMs =
            response.status === 429 ? 8_000 : retryBaseMs * Math.pow(2, attempt);
          const waitMs = (providerWaitMs ?? fallbackBackoffMs) + (response.status === 429 ? RATE_LIMIT_BUFFER_MS : 0);

          console.warn(
            `[ai] Upstream HTTP ${response.status} for model "${model}". Retrying in ${waitMs}ms ` +
              `(attempt ${attempt + 1}/${maxRetries}).`,
          );

          await sleep(waitMs);
          continue;
        }

        return {
          ok: false,
          kind: "http_error",
          message: describeHttpStatusFa(response.status, model),
          detail: conciseReason ?? (safeDetail || null),
        };
      }

      const payload = await response.json();
      const rawContent = payload?.choices?.[0]?.message?.content;

      if (typeof rawContent !== "string" || !rawContent.trim()) {
        return {
          ok: false,
          kind: "api_error",
          message: `پاسخ خالی از مدل «${model}» دریافت شد.`,
          detail: payload?.choices?.[0]?.finish_reason
            ? `finish_reason: ${String(payload.choices[0].finish_reason)}`
            : null,
        };
      }

      return {
        ok: true,
        rawText: rawContent,
        model,
        usage: extractTokenUsage(payload?.usage),
      };
    } catch (error) {
      clearTimeout(timer);

      const aborted =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");

      if (!aborted && attempt < 1) {
        await sleep(retryBaseMs);
        continue;
      }

      return {
        ok: false,
        kind: aborted ? "timeout" : "network_error",
        message: aborted
          ? `زمان درخواست هوش مصنوعی به پایان رسید (${requestTimeoutMs}ms).`
          : `خطای شبکه در اتصال به سرویس هوش مصنوعی (${baseUrl}).`,
        detail:
          error instanceof Error
            ? sanitizeSecrets(error.message, apiKey)
            : null,
      };
    }
  }

  return {
    ok: false,
    kind: "http_error",
    message: "تلاش‌های مجدد برای سرویس هوش مصنوعی به پایان رسید.",
    detail: null,
  };
}
