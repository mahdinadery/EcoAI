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
): Promise<DestinationResult> {
  // Duplicate protection: a confirmed prior delivery to this destination blocks a
  // second one. Failed attempts stay retryable on purpose.
  if (await findSuccessfulDelivery(article.id, destination)) {
    return { destination, status: "already_sent", ok: false, errorMessage: ALREADY_SENT_MESSAGE };
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
  } catch (error) {
    // Persistence problems are reported, but never rewrite the provider's verdict.
    const detail = error instanceof Error ? error.message : String(error);
    return {
      destination,
      status,
      ok: outcome.ok,
      errorMessage: `${outcome.errorMessage ?? "Delivery recorded, but the log insert failed."} | log: ${detail.slice(0, 120)}`,
    };
  }

  return { destination, status, ok: outcome.ok, errorMessage: outcome.errorMessage };
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

    if (article.similarityKey) {
      const rows = await db
        .select({ source: news.source, url: news.url })
        .from(news)
        .where(
          and(
            eq(news.similarityKey, article.similarityKey),
            gte(news.createdAt, new Date(Date.now() - 72 * 60 * 60 * 1000)),
          ),
        )
        .limit(20);
      // One entry per outlet (first URL wins) — the message lists every source
      // of the chosen story with its link.
      const seen = new Set<string>([article.source]);
      const others: Array<{ source: string; url: string }> = [];
      for (const row of rows) {
        if (seen.has(row.source)) continue;
        seen.add(row.source);
        others.push({ source: row.source, url: row.url });
      }
      if (others.length > 0) extras.corroborationItems = others;
    }

    const entityTags = article.entityTags ?? [];
    if (article.similarityKey || entityTags.length > 0) {
      const delivered = await db
        .select({ title: news.title })
        .from(news)
        .innerJoin(deliveries, eq(deliveries.newsId, news.id))
        .where(
          and(
            eq(deliveries.status, "sent"),
            gte(deliveries.sentAt, windowStart),
            sql`${news.id} <> ${article.id}`,
            article.similarityKey
              ? sql`(${news.similarityKey} = ${article.similarityKey} OR jsonb_exists_any(${news.entityTags}, ${entityTags}::text[]))`
              : sql`jsonb_exists_any(${news.entityTags}, ${entityTags}::text[])`,
          ),
        )
        .orderBy(desc(deliveries.sentAt))
        .limit(2);
      if (delivered.length > 0) extras.relatedTitles = delivered.map((row) => row.title);
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
  const results = await Promise.all(
    destinations.map((destination) => deliverToOne(article!, destination, message, trigger)),
  );

  return { ok: true, message, results };
}

export type BulletinSendResult = {
  ok: boolean;
  results: DestinationResult[];
  /** Per-news delivery rows written (newsId x destination on success). */
  recordedFor: string[];
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
}): Promise<BulletinSendResult> {
  const { text, newsIds, target, trigger } = params;
  const recordRows = params.recordRows ?? true;
  const destinations = target === "both" ? DESTINATIONS : [target];

  const results: DestinationResult[] = [];
  const recordedFor: string[] = [];

  for (const destination of destinations) {
    let outcome: ProviderOutcome;
    try {
      outcome = await PROVIDERS[destination](text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome = { ok: false, providerMessageId: null, errorMessage: detail.slice(0, 200) };
    }

    const status: DeliveryStatus = outcome.ok ? "sent" : "failed";
    results.push({
      destination,
      status,
      ok: outcome.ok,
      errorMessage: outcome.errorMessage,
    });

    if (!outcome.ok || !recordRows) continue;

    for (const newsId of newsIds) {
      try {
        await persistAttempt({
          newsId,
          destination,
          status,
          message: text,
          errorMessage: null,
          trigger,
          providerMessageId: outcome.providerMessageId,
        });
        recordedFor.push(newsId);
      } catch (error) {
        // The digest DID go out — a log failure must not flip the verdict.
        const detail = error instanceof Error ? error.message : String(error);
        console.error("[bulletin] delivery log failed:", detail.slice(0, 160));
      }
    }
  }

  return { ok: results.some((result) => result.ok), results, recordedFor };
}

export type DeliveryState = {
  local: "sent" | "failed" | null;
  bale: "sent" | "failed" | null;
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
    states[id] = { local: null, bale: null, lastSentAt: null };
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

    const times = [bucket.local?.sentAt, bucket.bale?.sentAt].filter(Boolean) as Date[];
    if (times.length > 0) {
      state.lastSentAt = times.sort((a, b) => b.getTime() - a.getTime())[0].toISOString();
    }
  }

  return states;
}
