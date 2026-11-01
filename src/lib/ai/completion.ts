/**
 * Low-level AI chat-completion transport — SERVER-SIDE ONLY.
 *
 * Extracted so both the production analysis pipeline (runAiAnalysis in
 * src/lib/ai/client.ts) and the admin "Test Configuration" panel
 * (src/app/api/admin/ai-config/test/route.ts) can obtain the *raw* AI response
 * text through the exact same network call, instead of duplicating fetch logic.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 45_000;

const MAX_RETRIES = 3;
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
 * Normalizes common OpenAI-compatible provider base URLs so minor configuration
 * slips (trailing `/chat/completions`, missing `/v1` or `/openai`) still route
 * to the right chat-completions endpoint.
 */
export function normalizeAiBaseUrl(rawBaseUrl?: string | null): string {
  const cleaned = (rawBaseUrl?.trim() || DEFAULT_BASE_URL)
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "");

  if (/^https:\/\/generativelanguage\.googleapis\.com(?:\/v1beta)?$/i.test(cleaned)) {
    return "https://generativelanguage.googleapis.com/v1beta/openai";
  }
  if (/^https:\/\/api\.groq\.com(?:\/openai)?$/i.test(cleaned)) {
    return "https://api.groq.com/openai/v1";
  }
  if (/^https:\/\/openrouter\.ai(?:\/api)?$/i.test(cleaned)) {
    return "https://openrouter.ai/api/v1";
  }

  return cleaned;
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
        typeof errObj.metadata === "object" &&
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

function sanitizeSecrets(text: string): string {
  const key = process.env.AI_API_KEY?.trim();
  if (!key) return text;

  return text.split(key).join("[REDACTED_API_KEY]");
}

export function resolveEffectiveModel(configModel: string | undefined): string {
  return (
    configModel?.trim() ||
    process.env.AI_API_MODEL?.trim() ||
    process.env.AI_MODEL?.trim() ||
    DEFAULT_MODEL
  );
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
  return /response_format|json_object|structured output|no endpoints found/i.test(detail);
}

function describeHttpStatusFa(status: number, model: string): string {
  if (status === 503 || status === 529) {
    return `سرویس هوش مصنوعی موقتاً در دسترس نیست یا مدل «${model}» شلوغ است (HTTP ${status}).`;
  }
  if (status === 429) {
    return `سقف تعداد درخواست سرویس هوش مصنوعی برای مدل «${model}» پر شده است (HTTP 429).`;
  }
  if (status === 401 || status === 403) {
    return `کلید دسترسی یا مجوز سرویس هوش مصنوعی پذیرفته نشد (HTTP ${status}).`;
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
  },
): Promise<CompletionResult> {
  const apiKey = process.env.AI_API_KEY?.trim();

  if (!apiKey) {
    return {
      ok: false,
      kind: "missing_key",
      message: "کلید API برای هوش مصنوعی (AI_API_KEY) تنظیم نشده است.",
      detail: null,
    };
  }

  const baseUrl = normalizeAiBaseUrl(process.env.AI_API_BASE_URL);
  const model = resolveEffectiveModel(params.model);
  const fetchFn = options?.fetchImpl ?? fetch;
  const retryBaseMs = options?.retryBaseDelayMs ?? 2_000;

  let useJsonObjectFormat = true;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

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
            content: params.userPrompt,
          },
        ],
        temperature: params.temperature,
        max_tokens: params.maxTokens,
      };
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
        const safeDetail = sanitizeSecrets(rawErr);
        const conciseReason = extractProviderErrorReason(safeDetail);

        // Fallback once if the upstream model rejects `response_format: { type: "json_object" }`.
        if (useJsonObjectFormat && shouldDropJsonObjectFormat(response.status, safeDetail) && attempt < MAX_RETRIES) {
          useJsonObjectFormat = false;
          console.warn(`[ai] Model "${model}" rejected json_object response_format (HTTP ${response.status}); retrying without it.`);
          continue;
        }

        // Retry rate-limit (429) and transient server/overload statuses (500/502/503/504/529).
        if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          const providerWaitMs = extractRetryWaitMs(safeDetail, response.headers.get("retry-after"));
          const fallbackBackoffMs =
            response.status === 429 ? 8_000 : retryBaseMs * Math.pow(2, attempt);
          const waitMs = (providerWaitMs ?? fallbackBackoffMs) + (response.status === 429 ? RATE_LIMIT_BUFFER_MS : 0);

          console.warn(
            `[ai] Upstream HTTP ${response.status} for model "${model}". Retrying in ${waitMs}ms ` +
              `(attempt ${attempt + 1}/${MAX_RETRIES}).`,
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
          message: "پاسخ خالی از سرویس هوش مصنوعی دریافت شد.",
          detail: null,
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
          ? `زمان درخواست هوش مصنوعی به پایان رسید (${REQUEST_TIMEOUT_MS}ms).`
          : "خطای ارتباط با سرور هوش مصنوعی.",
        detail:
          error instanceof Error
            ? sanitizeSecrets(error.message)
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
