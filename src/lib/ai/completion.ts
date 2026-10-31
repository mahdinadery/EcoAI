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
const REQUEST_TIMEOUT_MS = 30_000;

const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BUFFER_MS = 1_000;

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

function extractRateLimitWaitMs(detail: string): number | null {
  // Groq commonly returns:
  // "Please try again in 7.86s."
  const secondsMatch = detail.match(/try again in\s+([\d.]+)s/i);

  if (secondsMatch) {
    const seconds = Number(secondsMatch[1]);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  // Fallback if the provider does not expose a retry-after duration.
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callAiChatCompletion(params: {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  temperature: number;
  maxTokens: number;
}): Promise<CompletionResult> {
  const apiKey = process.env.AI_API_KEY?.trim();

  if (!apiKey) {
    return {
      ok: false,
      kind: "missing_key",
      message: "کلید API برای هوش مصنوعی (AI_API_KEY) تنظیم نشده است.",
      detail: null,
    };
  }

  const baseUrl = (
    process.env.AI_API_BASE_URL?.trim() || DEFAULT_BASE_URL
  ).replace(/\/+$/, "");

  const model = resolveEffectiveModel(params.model);

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
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
          response_format: {
            type: "json_object",
          },
          temperature: params.temperature,
          max_tokens: params.maxTokens,
        }),
        signal: controller.signal,
        cache: "no-store",
      });

      clearTimeout(timer);

      if (!response.ok) {
        const rawErr = await response.text().catch(() => "");
        const safeDetail = sanitizeSecrets(rawErr);

        // Only retry rate-limit errors.
        if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
          const providerWaitMs = extractRateLimitWaitMs(safeDetail);

          const waitMs =
            (providerWaitMs ?? 8_000) + RATE_LIMIT_BUFFER_MS;

          console.warn(
            `[ai] Rate limit reached. Retrying in ${waitMs}ms ` +
              `(attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}).`,
          );

          await sleep(waitMs);
          continue;
        }

        return {
          ok: false,
          kind: "http_error",
          message: `سرویس هوش مصنوعی خطای HTTP ${response.status} بازگرداند.`,
          detail: safeDetail,
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
