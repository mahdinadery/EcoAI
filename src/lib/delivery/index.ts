/**
 * Delivery service (Milestone 5) — SERVER-SIDE ONLY.
 *
 * Analyzed News -> Delivery Service -> Local | Bale
 *
 * This is the ONLY place that knows about both providers, so the send flow is not
 * duplicated. Destinations are attempted independently: one failing never blocks
 * the other. A provider is only ever reported as "sent" when that provider itself
 * confirmed success — no fabricated deliveries.
 */

import { db } from "@/db";
import { deliveries, news, type NewsRow } from "@/db/schema";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { deliverToBale } from "./bale";
import { deliverToLocal } from "./local";
import { mirrorToTelegram, type TelegramMirrorOutcome } from "./telegram";
import { buildNewsMessage, type MessageExtras } from "./message";
import { renderPublishingMessage } from "./template";
import { getActiveAiConfig } from "@/lib/ai/config-service";
import type {
  DeliveryDestination,
  DeliverySendResult,
  DeliveryStatus,
  DeliveryTarget,
  DestinationResult,
  ProviderOutcome,
} from "./types";

const PROVIDERS: Record<DeliveryDestination, (text: string) => Promise<ProviderOutcome>> = {
  local: deliverToLocal,
  bale: deliverToBale,
};

const DESTINATIONS: DeliveryDestination[] = ["local", "bale"];

export const ALREADY_SENT_MESSAGE = "این خبر قبلاً به این مقصد ارسال شده است.";

function isAnalyzed(article: NewsRow): boolean {
  return Boolean(article.analyzedAt && article.summary?.trim());
}

async function findSuccessfulDelivery(newsId: string, destination: DeliveryDestination): Promise<boolean> {
  const [existing] = await db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.newsId, newsId),
        eq(deliveries.destination, destination),
        eq(deliveries.status, "sent"),
      ),
    )
    .limit(1);

  return Boolean(existing);
}

export type SendTrigger = "manual" | "auto";

export type SendOptions = {
  /** Who initiated the send — recorded for auditing only. */
  trigger?: SendTrigger;
};

async function persistAttempt(params: {
  newsId: string;
  destination: DeliveryDestination;
  status: DeliveryStatus;
  message: string;
  errorMessage: string | null;
  trigger: SendTrigger;
  providerMessageId: string | null;
}): Promise<void> {
  await db.insert(deliveries).values({
    newsId: params.newsId,
    destination: params.destination,
    status: params.status,
    triggeredBy: params.trigger,
    message: params.message,
    errorMessage: params.errorMessage,
    providerMessageId: params.providerMessageId,
    sentAt: params.status === "sent" ? new Date() : null,
  });
}

async function deliverToOne(
  article: NewsRow,
  destination: DeliveryDestination,
  message: string,
  trigger: SendTrigger,
): Promise<{ result: DestinationResult; telegram: TelegramMirrorOutcome | null }> {
  // Telegram mirrors Bale only; it is never a selectable destination of its own.
  const mirror = async () =>
    destination === "bale"
      ? await mirrorToTelegram({
          text: message,
          newsId: article.id,
          trigger,
          buttonUrl: article.url?.trim() || null,
        })
      : null;

  // Duplicate protection: a confirmed prior delivery to this destination blocks a
  // second one. Failed attempts stay retryable on purpose.
  if (await findSuccessfulDelivery(article.id, destination)) {
    // Bale already has this article. A missing Telegram copy is still backfilled
    // here, so a Telegram outage can never permanently drop the news.
    return {
      result: { destination, status: "already_sent", ok: false, errorMessage: ALREADY_SENT_MESSAGE },
      telegram: await mirror(),
    };
  }

  if (trigger === "auto" && destination === "bale") {
    const [last] = await db.select({ status: deliveries.status, error: deliveries.errorMessage })
      .from(deliveries).where(and(eq(deliveries.newsId, article.id), eq(deliveries.destination, destination)))
      .orderBy(desc(deliveries.createdAt), desc(deliveries.id)).limit(1);
    // A timeout or malformed response can occur after Bale accepted the
    // message. Re-sending automatically could duplicate it; require review.
    // A plain "could not reach" network error means the request never left,
    // so it stays retryable.
    if (last?.status === "failed" && /timed out|timeout|not valid json/i.test(last.error ?? "")) {
      return {
        result: { destination, status: "failed", ok: false, errorMessage: "نتیجهٔ ارسال قبلی نامشخص است؛ پیش از تلاش مجدد کانال بله را بررسی کنید." },
        telegram: null,
      };
    }
  }

  let outcome: ProviderOutcome;
  try {
    outcome = await PROVIDERS[destination](message);
  } catch (error) {
    // A provider throwing must not abort the sibling destination.
    const detail = error instanceof Error ? error.message : String(error);
    outcome = { ok: false, providerMessageId: null, errorMessage: detail.slice(0, 200) };
  }

  const status: DeliveryStatus = outcome.ok ? "sent" : "failed";

  try {
    await persistAttempt({
      newsId: article.id,
      destination,
      status,
      message,
      errorMessage: outcome.errorMessage,
      trigger,
      providerMessageId: outcome.providerMessageId,
    });
    if (outcome.ok && destination === "bale") {
      await db
        .update(news)
        .set({ status: "SENT", updatedAt: new Date() })
        .where(eq(news.id, article.id));
    }
  } catch (error) {
    // Persistence problems are reported, but never rewrite the provider's verdict.
    const detail = error instanceof Error ? error.message : String(error);
    return {
      result: {
        destination,
        status,
        ok: outcome.ok,
        errorMessage: `${outcome.errorMessage ?? "Delivery recorded, but the log insert failed."} | log: ${detail.slice(0, 120)}`,
      },
      telegram: null,
    };
  }

  // Mirrored after the Bale attempt so the Telegram result can never rewrite the
  // Bale verdict — and a Telegram failure never lands in `results` (the
  // auto-send queue must not break on it).
  return {
    result: { destination, status, ok: outcome.ok, errorMessage: outcome.errorMessage },
    telegram: await mirror(),
  };
}

/**
 * Sends one analyzed article to the selected destination(s) and records the result.
 * Never throws: every failure is returned as a structured, safe payload.
 */

/**
 * Phase 3 extras for one message: other sources carrying the same event (the
 * article's own source is excluded), and titles of previously delivered
 * related stories (same similarity key or a shared entity tag, within 14 days).
 * Best-effort — a lookup failure yields empty extras, never a blocked send.
 */
export async function loadMessageExtras(article: NewsRow): Promise<MessageExtras> {
  const extras: MessageExtras = {};
  try {
    const windowStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const entityTags = article.entityTags ?? [];
    if (entityTags.length > 0) {
      const delivered = await db
        .select({ title: news.title, translatedTitle: news.translatedTitle })
        .from(news)
        .innerJoin(deliveries, eq(deliveries.newsId, news.id))
        .where(
          and(
            eq(deliveries.status, "sent"),
            gte(deliveries.sentAt, windowStart),
            sql`${news.id} <> ${article.id}`,
            sql`jsonb_exists_any(${news.entityTags}, ${entityTags}::text[])`,
          ),
        )
        .orderBy(desc(deliveries.sentAt))
        .limit(2);
      if (delivered.length > 0) {
        extras.relatedTitles = delivered.map((row) => row.translatedTitle?.trim() || row.title);
      }
    }
  } catch (error) {
    console.error("[message-extras] lookup failed:", String(error).slice(0, 160));
  }
  return extras;
}

export async function sendNewsDelivery(
  newsId: string,
  target: DeliveryTarget,
  options: SendOptions = {},
): Promise<DeliverySendResult> {
  let article: NewsRow | undefined;

  try {
    const [row] = await db.select().from(news).where(eq(news.id, newsId)).limit(1);
    article = row;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "db_error", message: "خواندن خبر از پایگاه داده ناموفق بود.", detail: detail.slice(0, 200) };
  }

  if (!article) {
    return { ok: false, code: "not_found", message: "خبر مورد نظر پیدا نشد." };
  }

  // Delivery is gated on analysis existing — but analysis never triggers delivery.
  if (!isAnalyzed(article)) {
    return {
      ok: false,
      code: "not_analyzed",
      message: "این خبر هنوز تحلیل نشده است. ابتدا «تحلیل با AI» را اجرا کنید.",
    };
  }

  const extras = await loadMessageExtras(article);
  // The active publishing template («قالب انتشار») shapes EVERY send — the
  // auto path used to ignore it and always rendered the built-in layout. An
  // empty template falls back to the built-in layout (with Phase-3 extras).
  let message: string;
  try {
    const config = await getActiveAiConfig();
    message = renderPublishingMessage(config.publishingTemplate, article, extras);
  } catch {
    message = buildNewsMessage(article, extras);
  }
  const destinations = target === "both" ? DESTINATIONS : [target];

  // Independent per-destination attempts.
  const trigger: SendTrigger = options.trigger ?? "manual";
  const attempts = await Promise.all(
    destinations.map((destination) => deliverToOne(article!, destination, message, trigger)),
  );

  return {
    ok: true,
    message,
    results: attempts.map((attempt) => attempt.result),
    // Reported to humans (dashboard / news list) but kept out of `results`, so
    // an automatic pass never treats a Telegram problem as a failed delivery.
    telegram: attempts.map((attempt) => attempt.telegram).find((entry) => entry?.attempted) ?? null,
  };
}

export type BulletinSendResult = {
  ok: boolean;
  results: DestinationResult[];
  /** Per-news delivery rows written (newsId x destination on success). */
  recordedFor: string[];
  /** Independent Telegram mirror of the same digest (never affects `ok`). */
  telegram?: TelegramMirrorOutcome | null;
};

/**
 * Sends ONE digest text to the selected destination(s) and records a delivery
 * row per covered news item (so later single sends / bulletins skip them).
 *
 * A bulletin is a single provider message: one failing provider never blocks
 * the sibling, exactly like per-item sends. Never throws.
 */
export async function sendBulletinDelivery(params: {
  text: string;
  newsIds: string[];
  target: DeliveryTarget;
  trigger: SendTrigger;
  /**
   * false for "both"-mode recaps: the covered items already have delivery rows
   * from their per-item sends — the digest is a wrap-up, not a second delivery.
   */
  recordRows?: boolean;
  /** A representative item used to log failures even for recap-only bulletins. */
  diagnosticNewsId?: string;
}): Promise<BulletinSendResult> {
  const { text, newsIds, target, trigger } = params;
  const recordRows = params.recordRows ?? true;
  const destinations = target === "both" ? DESTINATIONS : [target];

  const results: DestinationResult[] = [];
  const recordedFor: string[] = [];
  let telegram: TelegramMirrorOutcome | null = null;

  for (const destination of destinations) {
    let outcome: ProviderOutcome;
    try {
      // The Bale provider splits long digests into sub-limit chunks itself;
      // rows below are recorded only after every chunk succeeds.
      outcome = await PROVIDERS[destination](text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome = { ok: false, providerMessageId: null, errorMessage: detail.slice(0, 200) };
    }

    if (destination === "bale") {
      // One digest message, no per-item ledger row: the digest covers many news
      // items, and the outbox already keeps a record of the Telegram copy.
      telegram = await mirrorToTelegram({ text, newsId: null, trigger, buttonUrl: null });
    }

    const status: DeliveryStatus = outcome.ok ? "sent" : "failed";
    results.push({
      destination,
      status,
      ok: outcome.ok,
      errorMessage: outcome.errorMessage,
    });

    // Record failures as well, including recap-only messages, so the outbox
    // exposes the provider's actual error. One row avoids duplicate retries.
    const ids = outcome.ok ? (recordRows ? newsIds : []) : [params.diagnosticNewsId ?? newsIds[0]].filter((id): id is string => Boolean(id));
    for (const newsId of ids) {
      try {
        await persistAttempt({
          newsId,
          destination,
          status,
          message: text,
          errorMessage: outcome.errorMessage,
          trigger,
          providerMessageId: outcome.providerMessageId,
        });
        if (outcome.ok) recordedFor.push(newsId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("[bulletin] delivery log failed:", detail.slice(0, 160));
      }
    }
  }

  // Local success is not confirmation that Bale received the bulletin — and a
  // Telegram mirror result never changes it.
  return {
    ok: results.length > 0 && results.every((result) => result.ok),
    results,
    recordedFor,
    telegram,
  };
}

export type DeliveryState = {
  local: "sent" | "failed" | null;
  bale: "sent" | "failed" | null;
  /** Mirrored Bale copy (see src/lib/delivery/telegram.ts). */
  telegram: "sent" | "failed" | null;
  lastSentAt: string | null;
};

/**
 * Delivery status per news id, for the Dashboard/news list. "sent" always wins
 * over "failed" so a later retry can mark an article as delivered.
 */
export async function getDeliveryStates(newsIds: string[]): Promise<Record<string, DeliveryState>> {
  const states: Record<string, DeliveryState> = {};
  if (newsIds.length === 0) return states;

  for (const id of newsIds) {
    states[id] = { local: null, bale: null, telegram: null, lastSentAt: null };
  }

  type DeliveryStateRow = {
    newsId: string;
    destination: string;
    status: string;
    sentAt: Date | null;
  };

  let rows: DeliveryStateRow[];
  try {
    rows = await db
      .select({
        newsId: deliveries.newsId,
        destination: deliveries.destination,
        status: deliveries.status,
        sentAt: deliveries.sentAt,
      })
      .from(deliveries)
      .where(inArray(deliveries.newsId, newsIds))
      .orderBy(desc(deliveries.createdAt))
      .limit(1000);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[delivery] could not read delivery states:", detail.slice(0, 160));
    return states;
  }

  // Rows are newest-first: the first write for a destination wins, and a later
  // successful retry upgrades a previous failure.
  const resolved: Record<string, Record<string, { status: string; sentAt: Date | null }>> = {};

  for (const row of rows) {
    if (row.status !== "sent" && row.status !== "failed") continue;
    resolved[row.newsId] ??= {};
    const bucket = resolved[row.newsId];
    if (!bucket[row.destination] || row.status === "sent") {
      bucket[row.destination] = { status: row.status, sentAt: row.sentAt };
    }
  }

  for (const [newsId, bucket] of Object.entries(resolved)) {
    const state = states[newsId];
    if (!state) continue;
    if (bucket.local) state.local = bucket.local.status as "sent" | "failed";
    if (bucket.bale) state.bale = bucket.bale.status as "sent" | "failed";
    if (bucket.telegram) state.telegram = bucket.telegram.status as "sent" | "failed";

    const times = [bucket.local?.sentAt, bucket.bale?.sentAt, bucket.telegram?.sentAt].filter(Boolean) as Date[];
    if (times.length > 0) {
      state.lastSentAt = times.sort((a, b) => b.getTime() - a.getTime())[0].toISOString();
    }
  }

  return states;
}
