/**
 * Telegram mirror — SERVER-SIDE ONLY.
 *
 * Telegram is not a selectable destination: every message that goes to Bale is
 * copied here, so the channel, the digest and the admin "approve & send" flow
 * all stay a single code path with one policy. The mirror is deliberately
 * *independent*:
 *
 *   - a Telegram failure never changes the Bale verdict (a "sent" row always
 *     means Bale itself confirmed it);
 *   - it never blocks the auto-send queue (see `sendNewsDelivery`, which only
 *     reports the Telegram outcome to a human-initiated send);
 *   - it is idempotent: one `sent` row per (news, `telegram`) in the same
 *     `deliveries` ledger the other destinations use, so a later retry after a
 *     Telegram outage backfills exactly the missing messages.
 *
 * No token is read or returned here — see src/lib/telegram/client.ts.
 */

import { db } from "@/db";
import { deliveries } from "@/db/schema";
import { recordOutboxEntry } from "@/lib/bale/outbox";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  extractPrimaryUrl,
  getTelegramConfigStatus,
  getTelegramDeliveryMode,
  isTelegramConfigured,
  isTelegramMirrorEnabled,
  sendTelegramMessageWithChunks,
} from "@/lib/telegram/client";
import type { ProviderOutcome } from "./types";

export type TelegramMirrorStatus = "sent" | "failed" | "skipped" | "already_sent" | "dry_run";

export type TelegramMirrorOutcome = {
  attempted: boolean;
  ok: boolean;
  status: TelegramMirrorStatus;
  /** Why nothing was attempted (`not_configured`) — safe to show in the UI. */
  reason: string | null;
  messageId: string | null;
  errorMessage: string | null;
};

/**
 * Circuit breaker. A blocked or misconfigured Telegram host must not turn every
 * auto-send into a 15-second stall: after a couple of unreachable attempts the
 * mirror goes quiet for a while and the queue keeps publishing to Bale.
 */
const BREAKER_THRESHOLD = 2;
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
let consecutiveUnreachable = 0;
let breakerOpenUntil = 0;

function breakerOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

function noteAttempt(kind: string | null, ok: boolean): void {
  if (ok) {
    consecutiveUnreachable = 0;
    breakerOpenUntil = 0;
    return;
  }
  if (kind === "network_error" || kind === "timeout" || kind === "invalid_response") {
    consecutiveUnreachable += 1;
    if (consecutiveUnreachable >= BREAKER_THRESHOLD) {
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      console.error(
        `[telegram-mirror] Telegram unreachable ${consecutiveUnreachable}x; pausing the mirror for ${Math.round(
          BREAKER_COOLDOWN_MS / 60000,
        )} minutes.`,
      );
    }
  }
}

/** Exposed for the diagnostics route and tests. */
export function telegramMirrorHealth(): { paused: boolean; resumeInMs: number } {
  return { paused: breakerOpen(), resumeInMs: Math.max(0, breakerOpenUntil - Date.now()) };
}

const SKIPPED: Omit<TelegramMirrorOutcome, "reason"> = {
  attempted: false,
  ok: false,
  status: "skipped",
  messageId: null,
  errorMessage: null,
};

function skipped(reason: string): TelegramMirrorOutcome {
  return { ...SKIPPED, reason };
}

/** True when this news item already has a confirmed Telegram delivery. */
async function alreadyDelivered(newsId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(and(eq(deliveries.newsId, newsId), eq(deliveries.destination, "telegram"), eq(deliveries.status, "sent")))
      .limit(1);
    return Boolean(row);
  } catch {
    // A ledger read failure must not suppress the send; the provider is the
    // single source of truth and the operator sees any duplicate in the outbox.
    return false;
  }
}

async function recordLedgerRow(params: {
  newsId: string;
  status: "sent" | "failed";
  message: string;
  errorMessage: string | null;
  messageId: string | null;
  trigger: "manual" | "auto";
}): Promise<void> {
  try {
    await db.insert(deliveries).values({
      newsId: params.newsId,
      destination: "telegram",
      status: params.status,
      triggeredBy: params.trigger,
      message: params.message,
      errorMessage: params.errorMessage,
      providerMessageId: params.messageId,
      sentAt: params.status === "sent" ? new Date() : null,
      updatedAt: new Date(),
    });
  } catch (error) {
    // The message already reached Telegram; the ledger is best-effort.
    console.error("[telegram-mirror] ledger write failed:", String(error).slice(0, 160));
  }
}

export type MirrorTelegramArgs = {
  /** The exact Bale payload; it is converted to Telegram HTML on the way out. */
  text: string;
  /** News this message belongs to — enables dedup + the ledger row. */
  newsId?: string | null;
  trigger?: "manual" | "auto";
  /** Inline button target. Defaults to the first link found in the message. */
  buttonUrl?: string | null;
};

/**
 * Copies one message to Telegram. Never throws: every problem is returned (and
 * recorded) so the caller's Bale result is untouched.
 */
export async function mirrorToTelegram(args: MirrorTelegramArgs): Promise<TelegramMirrorOutcome> {
  const text = args.text?.trim();
  if (!text) return skipped("empty_message");

  if (!isTelegramMirrorEnabled()) {
    const status = getTelegramConfigStatus();
    return skipped(status.configured ? "disabled" : `not_configured:${status.missing.join(",")}`);
  }

  const newsId = args.newsId ?? null;
  const trigger = args.trigger ?? "manual";

  if (breakerOpen()) return skipped("temporarily_disabled");

  if (newsId && (await alreadyDelivered(newsId))) {
    return { ...SKIPPED, reason: "already_sent", status: "already_sent" };
  }

  if (getTelegramDeliveryMode() === "dry-run") {
    recordOutboxEntry({
      text,
      status: "dry-run",
      channel: "تلگرام (آزمایشی — بدون شبکه)",
      trigger,
      messageId: `tg-dry-${Date.now()}`,
    });
    return { attempted: true, ok: true, status: "dry_run", reason: "dry_run", messageId: null, errorMessage: null };
  }

  const buttonUrl = args.buttonUrl !== undefined ? args.buttonUrl : extractPrimaryUrl(text);
  const result = await sendTelegramMessageWithChunks(text, { buttonUrl });
  noteAttempt(result.ok ? null : result.kind, result.ok);

  if (result.ok) {
    if (newsId) {
      await recordLedgerRow({
        newsId,
        status: "sent",
        message: text,
        errorMessage: null,
        messageId: result.messageId,
        trigger,
      });
    }
    recordOutboxEntry({
      text,
      status: "sent",
      channel: "تلگرام (Telegram Bot API)",
      trigger,
      messageId: result.messageId,
    });
    return { attempted: true, ok: true, status: "sent", reason: null, messageId: result.messageId, errorMessage: null };
  }

  const errorMessage = result.detail ? `${result.message} (${result.detail})` : result.message;
  if (newsId) {
    await recordLedgerRow({
      newsId,
      status: "failed",
      message: text,
      errorMessage,
      messageId: null,
      trigger,
    });
  }
  recordOutboxEntry({
    text,
    status: "failed",
    channel: "تلگرام (Telegram Bot API)",
    trigger,
    error: errorMessage,
  });
  return { attempted: true, ok: false, status: "failed", reason: result.kind, messageId: null, errorMessage };
}

/**
 * Raw Telegram provider (no ledger, no dedup) — the counterpart of
 * `deliverToBale`, used when an operator retries a failed Telegram row from
 * /admin/deliveries.
 */
export async function deliverToTelegram(text: string): Promise<ProviderOutcome> {
  const message = text.trim();
  if (!message) return { ok: false, providerMessageId: null, errorMessage: "متن پیام خالی است." };
  if (!isTelegramConfigured()) {
    return { ok: false, providerMessageId: null, errorMessage: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID تنظیم نشده است." };
  }

  const result = await sendTelegramMessageWithChunks(message, { buttonUrl: extractPrimaryUrl(message) });
  if (result.ok) {
    return { ok: true, providerMessageId: result.messageId, errorMessage: null };
  }
  return {
    ok: false,
    providerMessageId: null,
    errorMessage: result.detail ? `${result.message} (${result.detail})` : result.message,
  };
}

/** Newest Telegram delivery problems, for the dashboard/test card. */
export async function lastTelegramError(): Promise<{ createdAt: string; errorMessage: string } | null> {
  try {
    const [row] = await db
      .select({ createdAt: deliveries.createdAt, errorMessage: deliveries.errorMessage })
      .from(deliveries)
      .where(and(eq(deliveries.destination, "telegram"), eq(deliveries.status, "failed")))
      .orderBy(desc(deliveries.createdAt))
      .limit(1);
    if (!row) return null;
    return { createdAt: row.createdAt.toISOString(), errorMessage: row.errorMessage ?? "ارسال ناموفق بود." };
  } catch {
    return null;
  }
}

/** Counts used by the dashboard summary line (no query needed for `skipped`). */
export async function telegramDeliveryStats(): Promise<{ sent: number; failed: number }> {
  try {
    const [row] = await db
      .select({
        sent: sql<number>`count(*) filter (where ${deliveries.status} = 'sent')::int`,
        failed: sql<number>`count(*) filter (where ${deliveries.status} = 'failed')::int`,
      })
      .from(deliveries)
      .where(eq(deliveries.destination, "telegram"));
    return { sent: row?.sent ?? 0, failed: row?.failed ?? 0 };
  } catch {
    return { sent: 0, failed: 0 };
  }
}
