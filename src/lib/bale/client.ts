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

export type DiscoveredBaleChat = {
  id: string;
  type: string;
  title: string | null;
  username: string | null;
};

type BaleApiEnvelope = {
  ok?: unknown;
  description?: unknown;
  result?: unknown;
};

// In-memory cache mapping raw/normalized `BALE_CHAT_ID` -> working `chat_id`
const resolvedChatIdOverrides = new Map<string, string>();
const resolvedUsernameChatIds = new Map<string, string>();

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

function toAsciiDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (ch) => String(ch.charCodeAt(0) - 0x0660));
}

/**
 * Normalizes common `BALE_CHAT_ID` input formats into what Bale's Bot API expects:
 * - Converts Persian/Arabic numerals (`۴۸۱۲...`) to ASCII (`4812...`)
 * - Strips wrapping quotes (`"@my_channel"` -> `@my_channel`)
 * - Extracts numeric IDs from `web.bale.ai` URLs (`https://web.bale.ai/chat?uid=4829104829` or `uid=44|4829104829`)
 * - Converts `https://ble.ir/my_channel` or `ble.ir/my_channel` (excluding `/join/...` invite links) to `@my_channel`
 * - Prepends `@` when an alphanumeric channel handle (`my_channel`) was entered without `@`
 */
export function normalizeBaleChatId(rawValue: string | undefined): string | undefined {
  if (!rawValue) return undefined;
  const cleaned = toAsciiDigits(rawValue)
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
  if (!cleaned) return undefined;

  // Extract peer ID from `web.bale.ai` URLs or `uid=...` snippets (including `44|4829104829` / `%7C4829104829`):
  const webUidMatch = cleaned.match(/(?:[?&]uid=|^uid=)(?:\d+(?:\||%7C))?(-?\d{5,20})\b/i);
  if (webUidMatch?.[1]) {
    return webUidMatch[1];
  }
  const pipePeerMatch = cleaned.match(/^\d+\|(-?\d{5,20})$/);
  if (pipePeerMatch?.[1]) {
    return pipePeerMatch[1];
  }

  // Strip `https://ble.ir/<handle>` when it is not a private `/join/...` invite link:
  const bleLinkMatch = cleaned.match(/^(?:https?:\/\/)?(?:www\.)?ble\.ir\/(?!join\/)([A-Za-z][A-Za-z0-9_]{2,63})\/?$/i);
  if (bleLinkMatch?.[1]) {
    return `@${bleLinkMatch[1]}`;
  }

  // Numeric chat_id (positive 10-digit Bale channel/group/user ID or `-100...`):
  if (/^-?\d+$/.test(cleaned)) {
    return cleaned;
  }

  // Already `@handle`:
  if (cleaned.startsWith("@")) {
    return cleaned.replace(/\/+$/, "");
  }

  // Bare handle without `@` (e.g. `ecoai_channel`):
  if (/^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(cleaned)) {
    return `@${cleaned}`;
  }

  return cleaned;
}

/**
 * Generates ordered candidate `chat_id` encodings for Bale Bot API (`tapi.bale.ai`).
 *
 * Why needed: `web.bale.ai` URLs display positive peer IDs (e.g. `4829104829` or `1234567890`),
 * whereas Telegram-compatible `tapi.bale.ai` endpoints expect `-100<peerId>` or `-<peerId>`
 * (or conversely positive `<peerId>` when a user manually prefixed `-100`).
 */
export function candidateBaleChatIds(normalized: string): string[] {
  const seen = new Set<string>();
  const push = (val: string) => {
    if (val && !seen.has(val)) seen.add(val);
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

/**
 * Pure parser extracting unique channels/groups/chats from a Bale `getUpdates` result array.
 */
export function extractDiscoveredBaleChats(updates: unknown): DiscoveredBaleChat[] {
  if (!Array.isArray(updates)) return [];
  const byId = new Map<string, DiscoveredBaleChat>();

  const candidateFields = [
    "channel_post",
    "edited_channel_post",
    "message",
    "edited_message",
    "my_chat_member",
    "chat_member",
  ] as const;

  for (const item of updates) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;

    const chatObjects: Array<Record<string, unknown>> = [];
    for (const field of candidateFields) {
      const sub = record[field];
      if (sub && typeof sub === "object") {
        const chat = (sub as Record<string, unknown>).chat;
        if (chat && typeof chat === "object") {
          chatObjects.push(chat as Record<string, unknown>);
        }
      }
    }
    const cb = record.callback_query;
    if (cb && typeof cb === "object") {
      const msg = (cb as Record<string, unknown>).message;
      if (msg && typeof msg === "object") {
        const chat = (msg as Record<string, unknown>).chat;
        if (chat && typeof chat === "object") {
          chatObjects.push(chat as Record<string, unknown>);
        }
      }
    }

    for (const chat of chatObjects) {
      const rawId = chat.id;
      const id =
        typeof rawId === "number" || typeof rawId === "string" ? String(rawId).trim() : "";
      if (!id) continue;

      const type = typeof chat.type === "string" ? chat.type : "unknown";
      const title =
        typeof chat.title === "string" && chat.title.trim()
          ? chat.title.trim()
          : typeof chat.first_name === "string" && chat.first_name.trim()
            ? chat.first_name.trim()
            : null;
      const username =
        typeof chat.username === "string" && chat.username.trim()
          ? chat.username.trim().replace(/^@/, "")
          : null;

      if (username) {
        resolvedUsernameChatIds.set(username.toLowerCase(), id);
      }

      byId.set(id, { id, type, title, username });
    }
  }

  return [...byId.values()];
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
  return Boolean(trimToUndefined(process.env.BALE_BOT_TOKEN) && normalizeBaleChatId(process.env.BALE_CHAT_ID));
}

/** Configuration diagnostics for the dashboard — never includes the token value. */
export function getBaleConfigStatus(): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!trimToUndefined(process.env.BALE_BOT_TOKEN)) missing.push("BALE_BOT_TOKEN");
  if (!normalizeBaleChatId(process.env.BALE_CHAT_ID)) missing.push("BALE_CHAT_ID");

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
 * Non-destructive read of recent bot updates (`getUpdates` without `offset` so
 * updates are never consumed) to discover channels/groups where the bot is active
 * and resolve `@username` -> numeric `chat_id` when Bale rejects `@username` with 404.
 */
export async function discoverBaleChatsFromUpdates(): Promise<DiscoveredBaleChat[]> {
  const res = await callBaleApi<unknown[]>("getUpdates", { limit: 100 });
  if (!res.ok || !Array.isArray(res.result)) return [];
  return extractDiscoveredBaleChats(res.result);
}

export async function resolveEffectiveBaleChatId(rawChatId?: string): Promise<string | undefined> {
  const normalized = normalizeBaleChatId(rawChatId ?? process.env.BALE_CHAT_ID);
  if (!normalized) return undefined;
  const cachedDirect = resolvedChatIdOverrides.get(normalized);
  if (cachedDirect) return cachedDirect;
  if (normalized.startsWith("@")) {
    const cached = resolvedUsernameChatIds.get(normalized.slice(1).toLowerCase());
    if (cached) return cached;
  }
  return normalized;
}

export function rememberResolvedBaleChatId(normalizedInput: string, workingChatId: string): void {
  if (normalizedInput && workingChatId) {
    resolvedChatIdOverrides.set(normalizedInput, workingChatId);
    if (normalizedInput.startsWith("@")) {
      resolvedUsernameChatIds.set(normalizedInput.slice(1).toLowerCase(), workingChatId);
    }
  }
}

export function matchDiscoveredChat(
  normalized: string,
  discovered: readonly DiscoveredBaleChat[],
): DiscoveredBaleChat | undefined {
  if (discovered.length === 0) return undefined;
  if (normalized.startsWith("@")) {
    const handle = normalized.slice(1).toLowerCase();
    const byHandle = discovered.find((c) => c.username?.toLowerCase() === handle);
    if (byHandle) return byHandle;
    const channels = discovered.filter((c) => c.type === "channel");
    if (channels.length === 1) return channels[0];
    return undefined;
  }
  const candidates = new Set(candidateBaleChatIds(normalized));
  return discovered.find((c) => candidates.has(c.id));
}

function isChatNotFoundError(res: BaleApiResult<unknown>): boolean {
  if (res.ok) return false;
  return /404|no such group or user|chat not found/i.test(`${res.message} ${res.detail ?? ""}`);
}

/**
 * Sends a text message to the configured Bale chat.
 *
 * Flow: env credentials -> `https://tapi.bale.ai/bot<token>/sendMessage` -> parsed
 * Telegram-compatible envelope -> safe success/error result.
 * On `404 (no such group or user)`, automatically probes Bale's numeric prefix
 * variants (`N`, `-100N`, `-N`), lowercase `@handle`, and `getUpdates` discovery.
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

  const normalizedInput = normalizeBaleChatId(process.env.BALE_CHAT_ID);
  const initialChatId = await resolveEffectiveBaleChatId();
  if (!normalizedInput || !initialChatId) {
    return failure("missing_chat_id", "BALE_CHAT_ID is not configured.");
  }

  const sendOnce = async (targetChatId: string) => {
    const body: Record<string, unknown> = { chat_id: targetChatId, text: message };
    if (options.parseMode) body.parse_mode = options.parseMode;

    let res = await callBaleApi<{ message_id?: unknown }>("sendMessage", body);

    // Hyperlinks must never cost a delivery: if Bale rejects the parse_mode
    // (unbalanced markup in an operator's free-text template), retry as plain.
    if (!res.ok && options.parseMode && (res.kind === "api_rejected" || res.kind === "http_error") && !isChatNotFoundError(res)) {
      res = await callBaleApi<{ message_id?: unknown }>("sendMessage", {
        chat_id: targetChatId,
        text: message,
      });
    }
    return res;
  };

  const candidates = candidateBaleChatIds(initialChatId);
  let response = await sendOnce(candidates[0]);

  if (!response.ok && isChatNotFoundError(response)) {
    for (let i = 1; i < candidates.length; i++) {
      const alt = await sendOnce(candidates[i]);
      if (alt.ok) {
        rememberResolvedBaleChatId(normalizedInput, candidates[i]);
        response = alt;
        break;
      }
      if (!isChatNotFoundError(alt)) {
        response = alt;
        break;
      }
    }
  }

  // If all direct/prefix candidates returned 404, try discovering the chat from `getUpdates`:
  if (!response.ok && isChatNotFoundError(response)) {
    const discovered = await discoverBaleChatsFromUpdates();
    const match = matchDiscoveredChat(normalizedInput, discovered);
    if (match && !candidates.includes(match.id)) {
      const viaDiscovery = await sendOnce(match.id);
      if (viaDiscovery.ok) {
        rememberResolvedBaleChatId(normalizedInput, match.id);
        response = viaDiscovery;
      }
    }
  }

  if (!response.ok) {
    return failure(response.kind, response.message, response.detail);
  }

  const rawMessageId = response.result?.message_id;
  const messageId = typeof rawMessageId === "number" || typeof rawMessageId === "string" ? String(rawMessageId) : null;

  return { ok: true, messageId };
}
