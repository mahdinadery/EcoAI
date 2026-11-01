/**
 * Low-level AI chat-completion transport — SERVER-SIDE ONLY.
 *
 * Extracted so both the production analysis pipeline (runAiAnalysis in
 * src/lib/ai/client.ts) and the admin "Test Configuration" panel
 * (src/app/api/admin/ai-config/test/route.ts) can obtain the *raw* AI response
 * text through the exact same network call, instead of duplicating fetch logic.
 */

import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const VERTEX_EXPRESS_BASE_URL = "https://aiplatform.googleapis.com/v1beta1/publishers/google/models";
const VERTEX_EXPRESS_V1_BASE_URL = "https://aiplatform.googleapis.com/v1/publishers/google/models";
const GROQ_OPENAI_BASE_URL = "https://api.groq.com/openai/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const AVALAI_BASE_URL = "https://api.avalai.ir/v1";
const XAI_BASE_URL = "https://api.x.ai/v1";

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const FAST_FALLBACK_GEMINI_MODEL = "gemini-2.0-flash";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
const DEFAULT_XAI_MODEL = "grok-3-mini";

const GEMINI_FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-3-flash-preview",
] as const;

const GROQ_FALLBACK_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
] as const;

const CONNECT_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 45_000;
const FAST_FALLBACK_TIMEOUT_MS = 25_000;
const FALLBACK_COMPACT_MAX_TOKENS = 1_200;

const MAX_RETRIES = 2;
const MAX_MODEL_FALLBACK_HOPS = 4;
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
    env.VERTEX_API_KEY?.trim() ||
    env.GROQ_API_KEY?.trim() ||
    env.OPENROUTER_API_KEY?.trim() ||
    ""
  );
}

/**
 * Infers the provider base URL from well-known API key prefixes when
 * `AI_API_BASE_URL` / `AI_BASE_URL` was left blank in the host environment.
 */
export function inferBaseUrlFromApiKey(apiKey?: string | null): string | null {
  const key = apiKey?.trim() ?? "";
  if (!key) return null;
  if (key.startsWith("AIza")) return GEMINI_OPENAI_BASE_URL;
  if (key.startsWith("AQ.")) return VERTEX_EXPRESS_BASE_URL;
  if (key.startsWith("gsk_")) return GROQ_OPENAI_BASE_URL;
  if (key.startsWith("sk-or-")) return OPENROUTER_BASE_URL;
  if (key.startsWith("aa-")) return AVALAI_BASE_URL;
  if (key.startsWith("xai-")) return XAI_BASE_URL;
  return null;
}

function isVertexExpressBaseUrl(url: string): boolean {
  return /^https:\/\/aiplatform\.googleapis\.com\/v1(?:beta1)?\/publishers\/google\/models$/i.test(url);
}

/**
 * Normalizes common OpenAI-compatible & Google Vertex Express base URLs so minor
 * configuration slips (trailing `/chat/completions`, missing `/v1` or `/openai`,
 * or `AQ.` Vertex Express keys pointed at `generativelanguage.googleapis.com`)
 * route cleanly to the working endpoint.
 */
export function normalizeAiBaseUrl(rawBaseUrl?: string | null, apiKey?: string | null): string {
  const key = apiKey?.trim() ?? "";
  const explicit = (rawBaseUrl?.trim() ?? "")
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "");

  // `AQ.` keys are Google Cloud Vertex AI Express Mode API keys: they use
  // `aiplatform.googleapis.com` rather than `generativelanguage.googleapis.com`
  // (where unbilled / EEA projects get `HTTP 429 limit: 0`).
  if (key.startsWith("AQ.") && (!explicit || /generativelanguage\.googleapis\.com/i.test(explicit))) {
    return VERTEX_EXPRESS_BASE_URL;
  }

  const base = explicit || inferBaseUrlFromApiKey(key) || DEFAULT_BASE_URL;

  if (/^https:\/\/generativelanguage\.googleapis\.com(?:\/v1beta)?$/i.test(base)) {
    return GEMINI_OPENAI_BASE_URL;
  }
  if (/^https:\/\/aiplatform\.googleapis\.com(?:\/v1(?:beta1)?)?(?:\/publishers\/google(?:\/models)?)?$/i.test(base)) {
    return VERTEX_EXPRESS_BASE_URL;
  }
  if (/^https:\/\/api\.groq\.com(?:\/openai)?$/i.test(base)) {
    return GROQ_OPENAI_BASE_URL;
  }
  if (/^https:\/\/openrouter\.ai(?:\/api)?$/i.test(base)) {
    return OPENROUTER_BASE_URL;
  }
  if (/^https:\/\/api\.avalai\.ir$/i.test(base)) {
    return AVALAI_BASE_URL;
  }

  return base;
}

/**
 * Resolves the effective base URL from environment variables (`AI_API_BASE_URL`,
 * `AI_BASE_URL`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`) with key-prefix fallback.
 */
export function resolveEffectiveBaseUrl(apiKey?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.AI_API_BASE_URL?.trim() ||
    env.AI_BASE_URL?.trim() ||
    env.OPENAI_BASE_URL?.trim() ||
    env.OPENAI_API_BASE?.trim() ||
    "";
  return normalizeAiBaseUrl(raw, apiKey);
}

/**
 * Optional outbound HTTP/HTTPS proxy for AI calls (`AI_PROXY_URL`, `HTTPS_PROXY`,
 * `HTTP_PROXY`) — needed when the host network blocks direct access to global AI providers.
 */
export function resolveAiProxyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.AI_PROXY_URL?.trim() || env.HTTPS_PROXY?.trim() || env.HTTP_PROXY?.trim() || "";
  return raw || null;
}

/**
 * Normalizes common Gemini model slug typos / retired 1.5 aliases (e.g.
 * `gemini-3.0-flash` -> `gemini-3-flash-preview`, `gemini-1.5-flash` -> `gemini-2.5-flash`).
 */
export function normalizeGoogleModelId(rawModel: string): string {
  const cleaned = rawModel
    .trim()
    .replace(/^(?:publishers\/google\/)?models\//i, "");
  const lower = cleaned.toLowerCase();

  if (lower === "gemini-3.0-flash" || lower === "gemini-3-flash" || lower === "gemini-3.0-flash-latest") {
    return "gemini-3-flash-preview";
  }
  if (lower === "gemini-3.0-pro" || lower === "gemini-3-pro" || lower === "gemini-3.0-pro-latest") {
    return "gemini-3-pro-preview";
  }
  if (lower === "gemini-2.5-flash-latest") return "gemini-2.5-flash";
  if (lower === "gemini-2.0-flash-latest") return "gemini-2.0-flash";
  if (lower === "gemini-1.5-flash" || lower === "gemini-1.5-flash-latest" || lower === "gemini-1.5-flash-8b") {
    return "gemini-2.5-flash";
  }
  if (lower === "gemini-1.5-pro" || lower === "gemini-1.5-pro-latest") {
    return "gemini-2.5-pro";
  }
  return cleaned;
}

function isGoogleProvider(baseUrl: string, apiKey?: string | null): boolean {
  const key = apiKey?.trim() ?? "";
  return (
    /generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com/i.test(baseUrl) ||
    key.startsWith("AIza") ||
    key.startsWith("AQ.")
  );
}

function defaultModelForBaseUrl(baseUrl: string): string {
  if (/generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com/i.test(baseUrl)) return DEFAULT_GEMINI_MODEL;
  if (/api\.groq\.com/i.test(baseUrl)) return DEFAULT_GROQ_MODEL;
  if (/openrouter\.ai/i.test(baseUrl)) return DEFAULT_OPENROUTER_MODEL;
  if (/api\.x\.ai/i.test(baseUrl)) return DEFAULT_XAI_MODEL;
  return DEFAULT_MODEL;
}

export function resolveEffectiveModel(
  configModel: string | undefined,
  options?: { baseUrl?: string; apiKey?: string | null; env?: NodeJS.ProcessEnv },
): string {
  const env = options?.env ?? process.env;
  const apiKey = options?.apiKey ?? resolveAiApiKey(env);
  const baseUrl = options?.baseUrl ?? resolveEffectiveBaseUrl(apiKey, env);
  const explicit = configModel?.trim() || env.AI_API_MODEL?.trim() || env.AI_MODEL?.trim();
  if (explicit) {
    return isGoogleProvider(baseUrl, apiKey) ? normalizeGoogleModelId(explicit) : explicit;
  }

  return defaultModelForBaseUrl(baseUrl);
}

/**
 * Extracts a concise human-readable error message from OpenAI, Google Gemini / Vertex
 * (`[{ error: { message } }]` or `{ error: { message } }`), OpenRouter, or HTML gateways.
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
      if (combined) return combined.replace(/\s+/g, " ").slice(0, 520);
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

  return trimmed.replace(/\s+/g, " ").slice(0, 520);
}

/**
 * Extracts normalized token counts from an OpenAI-compatible `usage` or Google
 * `usageMetadata` object. Returns null when the provider omitted usage metrics.
 */
export function extractTokenUsage(usagePayload: unknown): AiTokenUsage | null {
  if (!usagePayload || typeof usagePayload !== "object") return null;
  const raw = usagePayload as Record<string, unknown>;

  const promptRaw = Number(raw.prompt_tokens ?? raw.promptTokens ?? raw.promptTokenCount);
  const completionRaw = Number(
    raw.completion_tokens ?? raw.completionTokens ?? raw.candidatesTokenCount,
  );
  const totalRaw = Number(raw.total_tokens ?? raw.totalTokens ?? raw.totalTokenCount);

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

function sanitizeSecrets(text: string, apiKey?: string, proxyUrl?: string | null): string {
  const key = apiKey?.trim() || resolveAiApiKey();
  let safe = key ? text.split(key).join("[REDACTED_API_KEY]") : text;
  if (key) {
    const encoded = encodeURIComponent(key);
    if (encoded !== key) {
      safe = safe.split(encoded).join("[REDACTED_API_KEY]");
    }
  }
  if (proxyUrl) {
    try {
      const parsed = new URL(proxyUrl);
      if (parsed.password) {
        safe = safe.split(parsed.password).join("[REDACTED_PROXY]");
      }
    } catch {
      // ignore unparseable proxy URL
    }
  }
  return safe;
}

function extractRetryWaitMs(detail: string, retryAfterHeader: string | null): number | null {
  if (retryAfterHeader) {
    const headerSeconds = Number(retryAfterHeader.trim());
    if (Number.isFinite(headerSeconds) && headerSeconds >= 0 && headerSeconds <= 60) {
      return Math.ceil(headerSeconds * 1000);
    }
  }

  // Groq / Gemini commonly return: "Please try again in 7.86s." or "retryDelay: 5s"
  const secondsMatch = detail.match(/(?:try again in|Please retry in|retry(?:Delay)?["\s:=]+)\s*([\d.]+)\s*s/i);
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

function shouldDropReasoningEffort(status: number, detail: string): boolean {
  return (status === 400 || status === 422) && /reasoning_effort|thinking|extra inputs|unknown field|unrecognized/i.test(detail);
}

function defaultReasoningEffortForModel(model: string): "low" | null {
  if (/^gemini-2\.5-/i.test(model)) return "low";
  if (/^(?:o1|o3|o4|gpt-5)(?:[-/]|$)/i.test(model)) return "low";
  return null;
}

let sharedDirectDispatcher: Dispatcher | null = null;
const sharedProxyDispatchers = new Map<string, Dispatcher>();

function getAiDispatcher(proxyUrl: string | null): Dispatcher | undefined {
  if (proxyUrl) {
    let cached = sharedProxyDispatchers.get(proxyUrl);
    if (!cached) {
      try {
        cached = new ProxyAgent({
          uri: proxyUrl,
          requestTls: { timeout: CONNECT_TIMEOUT_MS },
          proxyTls: { timeout: CONNECT_TIMEOUT_MS },
        });
        sharedProxyDispatchers.set(proxyUrl, cached);
      } catch {
        return undefined;
      }
    }
    return cached;
  }

  if (!sharedDirectDispatcher) {
    sharedDirectDispatcher = new Agent({
      connect: { timeout: CONNECT_TIMEOUT_MS },
    });
  }
  return sharedDirectDispatcher;
}

function isConnectOrDnsFailure(error: unknown): { matched: boolean; code: string | null } {
  const cause = (error as { cause?: { code?: string; name?: string; message?: string } })?.cause;
  const code = cause?.code ?? cause?.name ?? null;
  const combined = `${code ?? ""} ${cause?.message ?? ""} ${(error as Error)?.message ?? ""}`;
  if (
    /UND_ERR_CONNECT_TIMEOUT|ConnectTimeoutError|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|CERT_|ERR_TLS/i.test(
      combined,
    )
  ) {
    return { matched: true, code };
  }
  return { matched: false, code };
}

function shouldShrinkTokenBudget(status: number, detail: string): boolean {
  if (status === 413) return true;
  if (status === 402 && /max_tokens|fewer max_tokens|afford/i.test(detail)) return true;
  if (status === 400 && /max_tokens.*(?:exceed|maximum|limit|context)/i.test(detail)) return true;
  if (status === 429 && /request too large|tokens per minute|\btpm\b/i.test(detail)) return true;
  return false;
}

/**
 * True when HTTP 429 represents an account/project/model quota ceiling (`limit: 0`,
 * billing disabled, or daily RPD exhausted) rather than a brief RPM burst.
 * Sleeping 8–60s on the exact same model cannot fix this; switching models or
 * surfacing the error immediately avoids 30s+ stalls.
 */
function isHardQuotaExhausted(status: number, detail: string): boolean {
  if (status !== 429) return false;
  return /exceeded your current quota|check your plan and billing|limit:\s*0\b|requests per day|tokens per day|per_day|PerDay/i.test(
    detail,
  );
}

function shouldTryFallbackModel(status: number, detail: string): boolean {
  if (status === 404 || status === 429) return true;
  if (status === 400 && /model.*(?:not found|not supported|decommissioned|does not exist|invalid)/i.test(detail)) {
    return true;
  }
  return false;
}

function candidateModelsForProvider(baseUrl: string, initialModel: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (m: string) => {
    const clean = m.trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  };

  push(initialModel);
  if (/generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com/i.test(baseUrl)) {
    for (const m of GEMINI_FALLBACK_MODELS) push(m);
  } else if (/api\.groq\.com/i.test(baseUrl)) {
    for (const m of GROQ_FALLBACK_MODELS) push(m);
  }
  return out;
}

function describeHttpStatusFa(status: number, model: string, detail?: string | null, apiKey?: string): string {
  if (status === 503 || status === 529) {
    return `سرویس هوش مصنوعی موقتاً در دسترس نیست یا مدل «${model}» شلوغ است (HTTP ${status}).`;
  }
  if (status === 429) {
    if (detail && isHardQuotaExhausted(429, detail)) {
      const isVertexKey = Boolean(apiKey?.trim().startsWith("AQ."));
      return isVertexKey
        ? `سهمیهٔ رایگان پروژهٔ Google Cloud برای این کلید (${model}) صفر یا تمام شده است (HTTP 429 Quota=0). یک کلید رایگان Groq (gsk_...) از console.groq.com یا کلید فعال Google AI Studio در AI_API_KEY قرار دهید.`
        : `سهمیهٔ فعلی حساب/پروژه برای مدل «${model}» صفر یا تمام شده است (HTTP 429 — بدون Billing یا سقف روزانه پر شده). اگر سرور در اروپا (Frankfurt) است، کلید رایگان Groq (gsk_...) یا کلید دارای سهمیه فعال جایگزین کنید.`;
    }
    return `سقف تعداد درخواست یا توکن سرویس هوش مصنوعی برای مدل «${model}» پر شده است (HTTP 429).`;
  }
  if (status === 401 || status === 403) {
    return `کلید دسترسی یا مجوز سرویس هوش مصنوعی پذیرفته نشد (HTTP ${status} — مدل: ${model}).`;
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

async function performHttpPost(params: {
  url: string;
  headers: Record<string, string>;
  bodyJson: string;
  signal: AbortSignal;
  customFetch: typeof fetch | null;
  proxyUrl: string | null;
}): Promise<Response> {
  if (params.customFetch) {
    return params.customFetch(params.url, {
      method: "POST",
      headers: params.headers,
      body: params.bodyJson,
      signal: params.signal,
      cache: "no-store",
    });
  }
  return (await undiciFetch(params.url, {
    method: "POST",
    headers: params.headers,
    body: params.bodyJson,
    signal: params.signal,
    dispatcher: getAiDispatcher(params.proxyUrl),
  })) as unknown as Response;
}

/**
 * Native Google Cloud Vertex AI Express Mode (`AQ.` API key) `:generateContent`
 * transport with automatic model fallback (`gemini-2.5-flash`, `gemini-2.5-flash-lite`,
 * `gemini-2.0-flash`, `gemini-3-flash-preview`).
 */
async function callVertexExpressGenerateContent(
  params: {
    apiKey: string;
    initialModel: string;
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    maxTokens: number;
    jsonMode: boolean;
  },
  options: {
    customFetch: typeof fetch | null;
    proxyUrl: string | null;
    requestTimeoutMs: number;
  },
): Promise<CompletionResult> {
  const candidates = candidateModelsForProvider(VERTEX_EXPRESS_BASE_URL, params.initialModel);
  let lastStatus = 0;
  let lastModel = params.initialModel;
  let lastSafeDetail: string | null = null;
  let lastConciseReason: string | null = null;

  for (const model of candidates) {
    lastModel = model;
    let useThinkingBudget = /^gemini-2\.5-flash$/i.test(model);
    let baseEndpoint = VERTEX_EXPRESS_BASE_URL;

    for (let subAttempt = 0; subAttempt < 2; subAttempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);

      try {
        const generationConfig: Record<string, unknown> = {
          maxOutputTokens: params.maxTokens,
          temperature: params.temperature,
        };
        if (params.jsonMode) {
          generationConfig.responseMimeType = "application/json";
        }
        if (useThinkingBudget) {
          generationConfig.thinkingConfig = { thinkingBudget: 256 };
        }

        const requestBody: Record<string, unknown> = {
          contents: [
            {
              role: "user",
              parts: [{ text: params.userPrompt }],
            },
          ],
          generationConfig,
        };
        if (params.systemPrompt.trim()) {
          requestBody.systemInstruction = {
            parts: [{ text: params.systemPrompt }],
          };
        }

        const targetUrl = `${baseEndpoint}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(params.apiKey)}`;
        const response = await performHttpPost({
          url: targetUrl,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": params.apiKey,
          },
          bodyJson: JSON.stringify(requestBody),
          signal: controller.signal,
          customFetch: options.customFetch,
          proxyUrl: options.proxyUrl,
        });

        clearTimeout(timer);

        if (!response.ok) {
          const rawErr = await response.text().catch(() => "");
          const safeDetail = sanitizeSecrets(rawErr, params.apiKey, options.proxyUrl);
          const conciseReason = extractProviderErrorReason(safeDetail);

          lastStatus = response.status;
          lastSafeDetail = safeDetail;
          lastConciseReason = conciseReason;

          if (response.status === 400 && useThinkingBudget && /thinking/i.test(safeDetail)) {
            useThinkingBudget = false;
            continue;
          }
          if (response.status === 404 && baseEndpoint === VERTEX_EXPRESS_BASE_URL && !/preview/i.test(model)) {
            baseEndpoint = VERTEX_EXPRESS_V1_BASE_URL;
            continue;
          }
          // Try next candidate model on 404 / 429 / unsupported-model 400:
          if (shouldTryFallbackModel(response.status, safeDetail)) {
            break;
          }
          // Auth / permission errors (401/403) apply to the whole key/endpoint — stop cycling models.
          return {
            ok: false,
            kind: "http_error",
            message: describeHttpStatusFa(response.status, model, safeDetail, params.apiKey),
            detail: conciseReason ?? (safeDetail || null),
          };
        }

        const payload = (await response.json()) as {
          candidates?: Array<{
            finishReason?: string;
            content?: { parts?: Array<{ text?: string; thought?: boolean }> };
          }>;
          usageMetadata?: unknown;
        };

        const parts = payload?.candidates?.[0]?.content?.parts ?? [];
        const nonThoughtParts = parts.filter(
          (part) => part && typeof part.text === "string" && part.thought !== true,
        );
        const chosenParts = nonThoughtParts.length > 0 ? nonThoughtParts : parts;
        const rawContent = chosenParts
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .join("")
          .trim();

        if (!rawContent) {
          return {
            ok: false,
            kind: "api_error",
            message: `پاسخ خالی از مدل «${model}» (Vertex AI) دریافت شد.`,
            detail: payload?.candidates?.[0]?.finishReason
              ? `finishReason: ${payload.candidates[0].finishReason}`
              : null,
          };
        }

        return {
          ok: true,
          rawText: rawContent,
          model,
          usage: extractTokenUsage(payload?.usageMetadata),
        };
      } catch (error) {
        clearTimeout(timer);
        const connectFail = isConnectOrDnsFailure(error);
        if (connectFail.matched) {
          const rawErrMsg =
            error instanceof Error ? sanitizeSecrets(error.message, params.apiKey, options.proxyUrl) : "";
          return {
            ok: false,
            kind: "network_error",
            message: `اتصال شبکه/TLS به Vertex AI («${baseEndpoint}») برقرار نشد.`,
            detail: [connectFail.code, rawErrMsg].filter(Boolean).join(" — ") || null,
          };
        }

        const aborted =
          error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
        if (aborted && model !== FAST_FALLBACK_GEMINI_MODEL) {
          // Try a faster flash model in the candidate list
          break;
        }
        return {
          ok: false,
          kind: aborted ? "timeout" : "network_error",
          message: aborted
            ? `زمان درخواست هوش مصنوعی به پایان رسید (${options.requestTimeoutMs}ms — مدل «${model}» در Vertex AI).`
            : `خطای شبکه در اتصال به Vertex AI (${model}).`,
          detail:
            error instanceof Error ? sanitizeSecrets(error.message, params.apiKey, options.proxyUrl) : null,
        };
      }
    }
  }

  return {
    ok: false,
    kind: "http_error",
    message: describeHttpStatusFa(lastStatus || 429, lastModel, lastSafeDetail, params.apiKey),
    detail: lastConciseReason ?? lastSafeDetail,
  };
}

export async function callAiChatCompletion(
  params: {
    systemPrompt: string;
    userPrompt: string;
    model?: string;
    temperature: number;
    maxTokens: number;
    /** Set false for plain-text helpers (grader, bulletin intro). Default: true. */
    jsonMode?: boolean;
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

  let baseUrl = resolveEffectiveBaseUrl(apiKey);
  const proxyUrl = resolveAiProxyUrl();
  let currentModel = resolveEffectiveModel(params.model, { baseUrl, apiKey });
  const customFetch = options?.fetchImpl ?? null;
  const retryBaseMs = options?.retryBaseDelayMs ?? 2_000;
  const requestTimeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? MAX_RETRIES;
  const jsonMode = params.jsonMode !== false;

  // Native Vertex AI Express path for `AQ.` keys or `aiplatform.googleapis.com` URLs:
  if (isVertexExpressBaseUrl(baseUrl)) {
    const vertexResult = await callVertexExpressGenerateContent(
      {
        apiKey,
        initialModel: currentModel,
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        jsonMode,
      },
      { customFetch, proxyUrl, requestTimeoutMs },
    );
    if (vertexResult.ok || vertexResult.kind === "network_error" || vertexResult.kind === "timeout") {
      return vertexResult;
    }
    // Secondary fallback: if an `AQ.` key was rejected on aiplatform.googleapis.com,
    // also probe generativelanguage.googleapis.com once before failing.
    baseUrl = GEMINI_OPENAI_BASE_URL;
  }

  const fallbackPool = candidateModelsForProvider(baseUrl, currentModel);
  let fallbackIndex = 0;
  let modelFallbacksUsed = 0;

  let useJsonObjectFormat = jsonMode;
  let useMaxCompletionTokens = false;
  let includeTemperature = true;
  let reasoningEffort = defaultReasoningEffortForModel(currentModel);
  let effectiveMaxTokens = params.maxTokens;
  let effectiveUserPrompt = params.userPrompt;
  let didTimeoutFallback = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptTimeoutMs = didTimeoutFallback
      ? Math.min(requestTimeoutMs, FAST_FALLBACK_TIMEOUT_MS)
      : requestTimeoutMs;
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, attemptTimeoutMs);

    try {
      const requestBody: Record<string, unknown> = {
        model: currentModel,
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
      if (reasoningEffort) {
        requestBody.reasoning_effort = reasoningEffort;
      }
      if (useJsonObjectFormat) {
        requestBody.response_format = { type: "json_object" };
      }

      const response = await performHttpPost({
        url: `${baseUrl}/chat/completions`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        bodyJson: JSON.stringify(requestBody),
        signal: controller.signal,
        customFetch,
        proxyUrl,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const rawErr = await response.text().catch(() => "");
        const safeDetail = sanitizeSecrets(rawErr, apiKey, proxyUrl);
        const conciseReason = extractProviderErrorReason(safeDetail);

        // 0) Drop `reasoning_effort` if the OpenAI-compatible gateway does not recognize it
        if (reasoningEffort && shouldDropReasoningEffort(response.status, safeDetail) && attempt < maxRetries) {
          reasoningEffort = null;
          continue;
        }

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
          console.warn(`[ai] Model "${currentModel}" rejected json_object response_format (HTTP ${response.status}); retrying without it.`);
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
          console.warn(`[ai] Shrinking max_tokens to ${FALLBACK_COMPACT_MAX_TOKENS} after HTTP ${response.status} for model "${currentModel}".`);
          continue;
        }

        // 4) Per-model quota (`429`) or missing/decommissioned model (`404`/`400`):
        //    immediately rotate to the next provider fallback model without sleeping.
        if (
          shouldTryFallbackModel(response.status, safeDetail) &&
          fallbackIndex + 1 < fallbackPool.length &&
          modelFallbacksUsed < MAX_MODEL_FALLBACK_HOPS
        ) {
          fallbackIndex += 1;
          modelFallbacksUsed += 1;
          const prevModel = currentModel;
          currentModel = fallbackPool[fallbackIndex];
          reasoningEffort = defaultReasoningEffortForModel(currentModel);
          console.warn(
            `[ai] Switching model "${prevModel}" -> "${currentModel}" after HTTP ${response.status}.`,
          );
          attempt -= 1; // Do not consume transient retry budget on model rotation
          continue;
        }

        // 5) Hard quota ceiling (`limit: 0` / billing disabled / daily RPD exhausted):
        //    never sleep 8–60s when no fallback models remain.
        if (isHardQuotaExhausted(response.status, safeDetail)) {
          return {
            ok: false,
            kind: "http_error",
            message: describeHttpStatusFa(response.status, currentModel, safeDetail, apiKey),
            detail: conciseReason ?? (safeDetail || null),
          };
        }

        // 6) Retry transient rate-limit (RPM 429) and server/overload statuses (500/502/503/504/529)
        if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt < maxRetries) {
          const providerWaitMs = extractRetryWaitMs(safeDetail, response.headers.get("retry-after"));
          const fallbackBackoffMs =
            response.status === 429 ? 8_000 : retryBaseMs * Math.pow(2, attempt);
          const waitMs = Math.min(
            15_000,
            (providerWaitMs ?? fallbackBackoffMs) + (response.status === 429 ? RATE_LIMIT_BUFFER_MS : 0),
          );

          console.warn(
            `[ai] Upstream HTTP ${response.status} for model "${currentModel}". Retrying in ${waitMs}ms ` +
              `(attempt ${attempt + 1}/${maxRetries}).`,
          );

          await sleep(waitMs);
          continue;
        }

        return {
          ok: false,
          kind: "http_error",
          message: describeHttpStatusFa(response.status, currentModel, safeDetail, apiKey),
          detail: conciseReason ?? (safeDetail || null),
        };
      }

      const payload = await response.json();
      const rawContent = payload?.choices?.[0]?.message?.content;

      if (typeof rawContent !== "string" || !rawContent.trim()) {
        return {
          ok: false,
          kind: "api_error",
          message: `پاسخ خالی از مدل «${currentModel}» دریافت شد.`,
          detail: payload?.choices?.[0]?.finish_reason
            ? `finish_reason: ${String(payload.choices[0].finish_reason)}`
            : null,
        };
      }

      return {
        ok: true,
        rawText: rawContent,
        model: currentModel,
        usage: extractTokenUsage(payload?.usage),
      };
    } catch (error) {
      clearTimeout(timer);

      const connectFail = isConnectOrDnsFailure(error);
      if (connectFail.matched) {
        const rawErrMsg = error instanceof Error ? sanitizeSecrets(error.message, apiKey, proxyUrl) : "";
        return {
          ok: false,
          kind: "network_error",
          message: `اتصال شبکه/TLS به «${baseUrl}» (مدل «${currentModel}») برقرار نشد؛ احتمال مسدود بودن IP سرور یا نادرست بودن آدرس وجود دارد (در صورت نیاز AI_API_BASE_URL یا AI_PROXY_URL تنظیم کنید).`,
          detail: [connectFail.code, rawErrMsg].filter(Boolean).join(" — ") || null,
        };
      }

      const aborted =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");

      // Fast compact retry once when TCP connected fine, so slow thinking models
      // (e.g. Gemini 2.5 Flash) recover on a lighter payload / non-thinking model.
      if (aborted && !didTimeoutFallback && attempt < maxRetries) {
        didTimeoutFallback = true;
        reasoningEffort = null;
        effectiveMaxTokens = Math.min(effectiveMaxTokens, FALLBACK_COMPACT_MAX_TOKENS);
        if (effectiveUserPrompt.length > 2_800) {
          effectiveUserPrompt = `${effectiveUserPrompt.slice(0, 2_800)}\n[...]`;
        }
        if (/generativelanguage\.googleapis\.com/i.test(baseUrl) && /^gemini-2\.5-/i.test(currentModel)) {
          currentModel = FAST_FALLBACK_GEMINI_MODEL;
        }
        console.warn(
          `[ai] Request timed out after ${attemptTimeoutMs}ms; retrying once with compact payload on model "${currentModel}".`,
        );
        continue;
      }

      if (!aborted && attempt < 1) {
        await sleep(retryBaseMs);
        continue;
      }

      return {
        ok: false,
        kind: aborted ? "timeout" : "network_error",
        message: aborted
          ? `زمان درخواست هوش مصنوعی به پایان رسید (${attemptTimeoutMs}ms — مدل «${currentModel}» در «${baseUrl}»).`
          : `خطای شبکه در اتصال به سرویس هوش مصنوعی (${currentModel} @ ${baseUrl}).`,
        detail:
          error instanceof Error
            ? sanitizeSecrets(error.message, apiKey, proxyUrl)
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
