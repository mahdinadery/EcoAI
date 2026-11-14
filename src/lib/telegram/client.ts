/**
 * Telegram Bot service — SERVER-SIDE ONLY.
 *
 * Never import this module from a client component. The bot token is read from
 * `process.env.TELEGRAM_BOT_TOKEN` inside the functions below (never at module
 * scope), so it can never be inlined into a client bundle, and it is redacted
 * from every error message that leaves this module.
 *
 * Telegram's Bot API is the API Bale's `tapi.bale.ai` is modeled on, so this
 * module deliberately mirrors `src/lib/bale/client.ts` (same envelope, same
 * redaction, same hard timeout) while adding the two things Telegram needs and
 * Bale does not: HTML escaping (Telegram's legacy Markdown is unforgiving) and
 * an inline keyboard button for the source link.
 */

const TELEGRAM_API_BASE_URL = "https://api.telegram.org/bot";

/** Hard timeout so a stalled Telegram request can never hang the Next.js server. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Official Bot API limit for `sendMessage` text length. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

export type TelegramErrorKind =
  | "missing_token"
  | "missing_chat_id"
  | "empty_message"
  | "timeout"
  | "network_error"
  | "http_error"
  | "invalid_response"
  | "api_rejected"
  | "unknown_error";

export type TelegramSendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; kind: TelegramErrorKind; message: string; detail?: string };

export type TelegramApiResult<T> =
  | { ok: true; result: T | null }
  | { ok: false; kind: TelegramErrorKind; message: string; detail?: string };

type TelegramApiEnvelope = {
  ok?: unknown;
  description?: unknown;
  result?: unknown;
  parameters?: unknown;
};

function failure(kind: TelegramErrorKind, message: string, detail?: string): TelegramSendResult {
  return { ok: false, kind, message, detail };
}

function apiFailure(kind: TelegramErrorKind, message: string, detail?: string): TelegramApiResult<never> {
  return { ok: false, kind, message, detail };
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toAsciiDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (ch) => String(ch.charCodeAt(0) - 0x0660));
}

/**
 * Normalizes the common `TELEGRAM_CHAT_ID` inputs into what the Bot API expects:
 * - Persian/Arabic digits -> ASCII (`۴۸۱۲` -> `4812`)
 * - wrapping quotes stripped (`"@my_channel"` -> `@my_channel`)
 * - `https://t.me/my_channel` (not `/join/+invite links) -> `@my_channel`
 * - bare handle (`my_channel`) -> `@my_channel`
 * - numeric ids kept as-is, including the `-100…` supergroup/channel form
 */
export function normalizeTelegramChatId(rawValue: string | undefined): string | undefined {
  if (!rawValue) return undefined;
  const cleaned = toAsciiDigits(rawValue)
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
  if (!cleaned) return undefined;

  // `https://t.me/123456789` — numeric username links carry the bare id.
  const tMeNumeric = cleaned.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/(?:c\/)?(\d{4,20})\/?$/i);
  if (tMeNumeric?.[1]) return tMeNumeric[1];

  const tMeHandle = cleaned.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/(?!join\/|share\/)([A-Za-z][A-Za-z0-9_]{2,63})\/?$/i);
  if (tMeHandle?.[1]) return `@${tMeHandle[1]}`;

  if (/^-?\d{4,20}$/.test(cleaned)) return cleaned;
  if (cleaned.startsWith("@")) return cleaned.replace(/\/+$/, "");
  if (/^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(cleaned)) return `@${cleaned}`;

  return cleaned;
}

/**
 * Ordered `chat_id` encodings to try.
 *
 * `t.me/<id>` links and Bot API answers disagree on the `-100` channel prefix,
 * so a numeric id is retried with and without it instead of failing outright.
 */
export function candidateTelegramChatIds(normalized: string): string[] {
  const seen = new Set<string>();
  const push = (value: string) => {
    if (value && !seen.has(value)) seen.add(value);
  };

  push(normalized);
  if (/^\d+$/.test(normalized)) {
    push(`-100${normalized}`);
    push(`-${normalized}`);
  } else if (/^-100(\d+)$/.test(normalized)) {
    const stem = normalized.slice(4);
    push(stem);
    push(`-${stem}`);
  } else if (/^-(\d+)$/.test(normalized)) {
    const stem = normalized.slice(1);
    push(`-100${stem}`);
    push(stem);
  } else if (normalized.startsWith("@")) {
    push(normalized.toLowerCase());
  }
  return [...seen];
}

/* ────────────────────────── message formatting ────────────────────────── */

/**
 * The publishing template is written for Bale's `parse_mode: Markdown`
 * (`buildNewsMessage` escapes markup with backslashes). Telegram renders the
 * same message most reliably as HTML, so the text is converted rather than
 * duplicated: one template, one canonical message, two renderings.
 */
const MD_LINK = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g;
/** Same pattern without `/g`, so capture groups survive (`String.match` drops them globally). */
const MD_LINK_FIRST = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/;

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));
}

/** Removes the backslash escaping the Markdown builder inserts. */
function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\_*[\]`])/g, "$1");
}

function segmentToHtml(segment: string): string {
  return segment
    .split(/(\*\*[^*\n]+\*\*)/g)
    .map((part) => {
      if (/^\*\*[^*\n]+\*\*$/.test(part)) return `<b>${escapeHtml(unescapeMarkdown(part.slice(2, -2)))}</b>`;
      return escapeHtml(unescapeMarkdown(part));
    })
    .join("");
}

/** Markdown links + bold -> Telegram HTML; everything else is escaped. */
export function markdownMessageToHtml(text: string): string {
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(MD_LINK)) {
    const index = match.index ?? 0;
    out += segmentToHtml(text.slice(cursor, index));
    const url = match[2] ?? "";
    const label = (match[1] ?? "").trim() || url;
    out += `<a href="${escapeHtml(url)}">${escapeHtml(unescapeMarkdown(label))}</a>`;
    cursor = index + match[0].length;
  }
  out += segmentToHtml(text.slice(cursor));
  return out;
}

/** Reverse of `markdownMessageToHtml`, used when Telegram rejects the markup. */
export function stripHtmlForPlainFallback(html: string): string {
  return html
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_all, href: string, label: string) =>
      label.trim() && label.trim() !== href.trim() ? `${label} (${href})` : href,
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** First http(s) link in the message — used for the "read the full story" button. */
export function extractPrimaryUrl(text: string): string | null {
  const link = text.match(MD_LINK_FIRST);
  if (link?.[2]) return link[2];
  const bare = text.match(/https?:\/\/\S+/);
  if (!bare?.[0]) return null;
  return bare[0].replace(/[),.;،]+$/, "");
}

/**
 * Paragraph-aware chunking inside Telegram's 4096-character limit — the same
 * rule set as `splitBaleMessage` (src/lib/delivery/bulletin.ts), re-declared
 * here so this module keeps ZERO runtime imports and the Node test runner can
 * import it directly (see the note in src/lib/delivery/message.ts).
 */
export function splitTelegramMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const chunks: string[] = [];
  let current = "";
  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const paragraph of clean.split(/\n{2,}/)) {
    const block = paragraph.trim();
    if (!block) continue;
    if (block.length > limit) {
      pushCurrent();
      for (let i = 0; i < block.length; i += limit) chunks.push(block.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      pushCurrent();
      current = block;
    }
  }
  pushCurrent();

  return chunks;
}

/* ───────────────────────────── configuration ───────────────────────────── */

/** True when both required environment variables are present and non-empty. */
export function isTelegramConfigured(): boolean {
  return Boolean(
    trimToUndefined(process.env.TELEGRAM_BOT_TOKEN) && normalizeTelegramChatId(process.env.TELEGRAM_CHAT_ID),
  );
}

/** Master switch: the mirror is on as soon as the bot is configured. */
export function isTelegramMirrorEnabled(): boolean {
  const raw = (process.env.TELEGRAM_MIRROR_ENABLED ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off", "خاموش"].includes(raw)) return false;
  return isTelegramConfigured();
}

export function getTelegramDeliveryMode(): "live" | "dry-run" {
  const raw = (process.env.TELEGRAM_DELIVERY_MODE ?? "").trim().toLowerCase();
  return raw === "dry-run" || raw === "dryrun" ? "dry-run" : "live";
}

/** Configuration diagnostics for the dashboard — never includes the token value. */
export function getTelegramConfigStatus(): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!trimToUndefined(process.env.TELEGRAM_BOT_TOKEN)) missing.push("TELEGRAM_BOT_TOKEN");
  if (!normalizeTelegramChatId(process.env.TELEGRAM_CHAT_ID)) missing.push("TELEGRAM_CHAT_ID");
  return { configured: missing.length === 0, missing };
}

/** Removes the bot token (and Telegram-style tokens) from any outbound text. */
function redactSecrets(value: string): string {
  const token = trimToUndefined(process.env.TELEGRAM_BOT_TOKEN);
  let output = value;
  if (token) output = output.split(token).join("[REDACTED]");
  return output.replace(/\b\d{6,}:[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

/**
 * Calls any Telegram Bot API method and normalizes the response envelope.
 * The token never leaves this module: callers get the parsed `result` or a
 * safe, redacted error. Every request is bounded by a hard timeout.
 */
export async function callTelegramApi<T>(
  method: string,
  body: Record<string, unknown> = {},
): Promise<TelegramApiResult<T>> {
  const token = trimToUndefined(process.env.TELEGRAM_BOT_TOKEN);
  if (!token) return apiFailure("missing_token", "TELEGRAM_BOT_TOKEN is not configured.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API_BASE_URL}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (isAbortError(error)) {
      return apiFailure("timeout", `Telegram request timed out after ${REQUEST_TIMEOUT_MS}ms.`);
    }
    return apiFailure(
      "network_error",
      "Could not reach the Telegram Bot API.",
      redactSecrets(error instanceof Error ? error.message : String(error)),
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: TelegramApiEnvelope;
  try {
    payload = (await response.json()) as TelegramApiEnvelope;
  } catch {
    return apiFailure("invalid_response", "Telegram returned a response that is not valid JSON.", `HTTP ${response.status}`);
  }

  if (!response.ok || payload.ok !== true) {
    const description = typeof payload.description === "string" ? redactSecrets(payload.description) : undefined;
    if (!response.ok) {
      return apiFailure("http_error", `Telegram Bot API returned HTTP ${response.status}.`, description);
    }
    return apiFailure("api_rejected", "Telegram Bot API rejected the request.", description);
  }

  return { ok: true, result: (payload.result ?? null) as T | null };
}

/** `retry_after` seconds from a Telegram 429, when present and small enough to honor. */
function retryAfterSeconds(description: string | undefined, capSeconds = 8): number | null {
  if (!description) return null;
  const match = description.match(/retry after (\d{1,3})/i);
  if (!match?.[1]) return null;
  const seconds = Number.parseInt(match[1], 10);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > capSeconds) return null;
  return seconds;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when Telegram says the chat does not exist / the bot is not a member. */
export function isChatNotFoundError(res: TelegramApiResult<unknown> | TelegramSendResult): boolean {
  if (res.ok) return false;
  return /chat not found|have no rights|is not a member|kicked|400 bad request: chat not found/i.test(
    `${res.message} ${res.detail ?? ""}`,
  );
}

export type TelegramSendOptions = {
  /** Send as HTML (default). `null` forces a plain-text message. */
  parseMode?: "HTML" | null;
  /** Opens the inline button under the message (source link). */
  buttonUrl?: string | null;
  buttonLabel?: string;
};

export const DEFAULT_BUTTON_LABEL = "متن کامل خبر 🔗";

/**
 * Sends one text message to the configured Telegram chat, optionally with an
 * inline keyboard button under it.
 *
 * Resilience mirrors the Bale client, because a markup problem must never cost
 * a delivery: an HTML rejection retries the same chunk as plain text, an
 * unknown `chat_id` encoding is retried with the other candidate forms, and a
 * Telegram 429 with a short `retry_after` is awaited once.
 */
export async function sendTelegramMessage(
  text: string,
  options: TelegramSendOptions = {},
): Promise<TelegramSendResult> {
  const message = text.trim();
  if (!message) return failure("empty_message", "Message text is empty.");
  if (!trimToUndefined(process.env.TELEGRAM_BOT_TOKEN)) {
    return failure("missing_token", "TELEGRAM_BOT_TOKEN is not configured.");
  }
  const chatId = normalizeTelegramChatId(process.env.TELEGRAM_CHAT_ID);
  if (!chatId) return failure("missing_chat_id", "TELEGRAM_CHAT_ID is not configured.");

  const parseMode = options.parseMode === undefined ? ("HTML" as const) : options.parseMode;
  const replyMarkup =
    options.buttonUrl?.trim()
      ? { inline_keyboard: [[{ text: (options.buttonLabel ?? DEFAULT_BUTTON_LABEL).trim(), url: options.buttonUrl.trim() }]] }
      : null;

  const sendOnce = async (targetChatId: string): Promise<TelegramApiResult<{ message_id?: unknown }>> => {
    const base: Record<string, unknown> = {
      chat_id: targetChatId,
      text: message,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    };
    let res = await callTelegramApi<{ message_id?: unknown }>(
      "sendMessage",
      parseMode ? { ...base, parse_mode: parseMode } : base,
    );

    if (!res.ok && res.kind === "http_error" && /429/.test(res.detail ?? res.message)) {
      const wait = retryAfterSeconds(res.detail ?? res.message);
      if (wait) {
        await sleep(wait * 1000);
        res = await callTelegramApi<{ message_id?: unknown }>(
          "sendMessage",
          parseMode ? { ...base, parse_mode: parseMode } : base,
        );
      }
    }

    // Unbalanced markup (or a markup Telegram refuses) must not lose the news.
    if (!res.ok && parseMode && !isChatNotFoundError(res)) {
      res = await callTelegramApi<{ message_id?: unknown }>("sendMessage", base);
    }
    return res;
  };

  const candidates = candidateTelegramChatIds(chatId);
  let response = await sendOnce(candidates[0]!);

  if (!response.ok && isChatNotFoundError(response)) {
    for (let i = 1; i < candidates.length; i += 1) {
      const alt = await sendOnce(candidates[i]!);
      if (alt.ok) {
        response = alt;
        break;
      }
      if (!isChatNotFoundError(alt)) {
        response = alt;
        break;
      }
    }
  }

  if (!response.ok) {
    return failure(
      response.kind,
      response.message,
      response.detail ?? "chat_id: try adding the bot as an admin of the channel, then re-check TELEGRAM_CHAT_ID.",
    );
  }

  const rawId = response.result?.message_id;
  return { ok: true, messageId: typeof rawId === "number" || typeof rawId === "string" ? String(rawId) : null };
}

/**
 * Sends the full message as one or more chunks (Telegram rejects > 4096 chars,
 * exactly like Bale). Only a real API confirmation returns `ok`.
 */
export async function sendTelegramMessageWithChunks(
  text: string,
  options: { buttonUrl?: string | null; buttonLabel?: string } = {},
): Promise<TelegramSendResult> {
  const chunks = splitTelegramMessage(markdownMessageToHtml(text.trim()));
  if (chunks.length === 0) return failure("empty_message", "Message text is empty.");

  let lastMessageId: string | null = null;
  for (let i = 0; i < chunks.length; i += 1) {
    // The button belongs under the first chunk only (a digest repeats nothing).
    const result = await sendTelegramMessage(chunks[i]!, {
      buttonUrl: i === 0 ? (options.buttonUrl ?? null) : null,
      buttonLabel: options.buttonLabel,
    });
    if (!result.ok) return result;
    lastMessageId = result.messageId ?? lastMessageId;
  }

  return { ok: true, messageId: lastMessageId };
}

/** Non-destructive `getMe` probe used by the dashboard test card. */
export async function probeTelegramBot(): Promise<TelegramApiResult<{ username?: string; can_send_messages?: boolean }>> {
  return callTelegramApi<{ username?: string; can_send_messages?: boolean }>("getMe", {});
}
