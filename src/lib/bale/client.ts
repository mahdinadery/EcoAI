/**
 * Bale Bot service — SERVER-SIDE ONLY.
 *
 * Never import this module from a client component. The bot token is read from
 * `process.env.BALE_BOT_TOKEN` inside the functions below (never at module scope),
 * so it can never be inlined into a client bundle, and it is redacted from every
 * error message that leaves this module.
 */

const BALE_API_BASE_URL = "https://tapi.bale.ai/bot";

/** Hard timeout so a stalled Bale request can never hang the Next.js server. */
const REQUEST_TIMEOUT_MS = 15_000;

export type BaleErrorKind =
  | "missing_token"
  | "missing_chat_id"
  | "empty_message"
  | "timeout"
  | "network_error"
  | "http_error"
  | "invalid_response"
  | "api_rejected"
  | "unknown_error";

export type BaleSendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; kind: BaleErrorKind; message: string; detail?: string };

/** Safe result of any Telegram-compatible Bale Bot API method. */
export type BaleApiResult<T> =
  | { ok: true; result: T | null }
  | { ok: false; kind: BaleErrorKind; message: string; detail?: string };

type BaleApiEnvelope = {
  ok?: unknown;
  description?: unknown;
  result?: unknown;
};

function failure(kind: BaleErrorKind, message: string, detail?: string): BaleSendResult {
  return { ok: false, kind, message, detail };
}

function apiFailure(kind: BaleErrorKind, message: string, detail?: string): BaleApiResult<never> {
  return { ok: false, kind, message, detail };
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Removes the bot token from any text before it is returned, logged, or rendered.
 * Also redacts Telegram/Bale style tokens (`123456789:AA...`) found in upstream
 * error strings or URLs.
 */
function redactSecrets(value: string): string {
  const token = trimToUndefined(process.env.BALE_BOT_TOKEN);
  let output = value;

  if (token) {
    output = output.split(token).join("[REDACTED]");
  }

  return output.replace(/\b\d{6,}:[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

/** True when both required environment variables are present and non-empty. */
export function isBaleConfigured(): boolean {
  return Boolean(trimToUndefined(process.env.BALE_BOT_TOKEN) && trimToUndefined(process.env.BALE_CHAT_ID));
}

/** Configuration diagnostics for the dashboard — never includes the token value. */
export function getBaleConfigStatus(): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!trimToUndefined(process.env.BALE_BOT_TOKEN)) missing.push("BALE_BOT_TOKEN");
  if (!trimToUndefined(process.env.BALE_CHAT_ID)) missing.push("BALE_CHAT_ID");

  return { configured: missing.length === 0, missing };
}

/**
 * Calls any Bale Bot API method and normalizes the Telegram-compatible envelope.
 *
 * The token never leaves this module: callers only receive the parsed `result`
 * or a safe, redacted error. Every request is bounded by a hard timeout.
 */
export async function callBaleApi<T>(
  method: string,
  body: Record<string, unknown> = {},
): Promise<BaleApiResult<T>> {
  const token = trimToUndefined(process.env.BALE_BOT_TOKEN);
  if (!token) {
    return apiFailure("missing_token", "BALE_BOT_TOKEN is not configured.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${BALE_API_BASE_URL}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (isAbortError(error)) {
      return apiFailure("timeout", `Bale request timed out after ${REQUEST_TIMEOUT_MS}ms.`);
    }
    return apiFailure(
      "network_error",
      "Could not reach the Bale Bot API.",
      redactSecrets(error instanceof Error ? error.message : String(error)),
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: BaleApiEnvelope;
  try {
    payload = (await response.json()) as BaleApiEnvelope;
  } catch {
    return apiFailure(
      "invalid_response",
      "Bale returned a response that is not valid JSON.",
      `HTTP ${response.status}`,
    );
  }

  if (!response.ok) {
    return apiFailure(
      "http_error",
      `Bale Bot API returned HTTP ${response.status}.`,
      typeof payload.description === "string" ? redactSecrets(payload.description) : undefined,
    );
  }

  if (payload.ok !== true) {
    return apiFailure(
      "api_rejected",
      "Bale Bot API rejected the request.",
      typeof payload.description === "string" ? redactSecrets(payload.description) : undefined,
    );
  }

  return { ok: true, result: (payload.result ?? null) as T | null };
}

/**
 * Sends a text message to the configured Bale chat.
 *
 * Flow: env credentials -> `https://tapi.bale.ai/bot<token>/sendMessage` -> parsed
 * Telegram-compatible envelope -> safe success/error result.
 */
export async function sendBaleMessage(
  text: string,
  options: { parseMode?: "Markdown" | "HTML" | null } = {},
): Promise<BaleSendResult> {
  const message = text.trim();
  if (!message) {
    return failure("empty_message", "Message text is empty.");
  }

  if (!trimToUndefined(process.env.BALE_BOT_TOKEN)) {
    return failure("missing_token", "BALE_BOT_TOKEN is not configured.");
  }

  const chatId = trimToUndefined(process.env.BALE_CHAT_ID);
  if (!chatId) {
    return failure("missing_chat_id", "BALE_CHAT_ID is not configured.");
  }

  const body: Record<string, unknown> = { chat_id: chatId, text: message };
  if (options.parseMode) body.parse_mode = options.parseMode;

  let response = await callBaleApi<{ message_id?: unknown }>("sendMessage", body);

  // Hyperlinks must never cost a delivery: if Bale rejects the parse_mode
  // (unbalanced markup in an operator's free-text template), retry as plain.
  if (!response.ok && options.parseMode && (response.kind === "api_rejected" || response.kind === "http_error")) {
    response = await callBaleApi<{ message_id?: unknown }>("sendMessage", {
      chat_id: chatId,
      text: message,
    });
  }

  if (!response.ok) {
    return failure(response.kind, response.message, response.detail);
  }

  const rawMessageId = response.result?.message_id;
  const messageId = typeof rawMessageId === "number" || typeof rawMessageId === "string" ? String(rawMessageId) : null;

  return { ok: true, messageId };
}
