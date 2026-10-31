/**
 * Controlled publishing workflow (Milestone 8) — SERVER-SIDE ONLY.
 *
 * Sits on top of the EXISTING `deliveries` ledger and the EXISTING providers
 * (deliverToBale / deliverToLocal). No new "publishing" table, no second Bale
 * client, no automatic publishing: a candidate only leaves this module when an
 * authenticated admin calls sendDelivery().
 *
 *   READY_TO_SEND ─▶ pending_approval ─▶ approved ─▶ sending ─▶ sent
 *                        │                            └─▶ failed ─▶ retry
 *                        └─▶ cancelled (reject)
 *
 * Invariants enforced here:
 *  - one OPEN candidate per (news, destination) — backed by a partial unique index
 *  - send is claimed atomically, so two concurrent Send clicks cannot double-publish
 *  - editing content never touches the news row or the AI analysis row
 *  - "sent" is recorded ONLY when the provider itself confirmed success
 */

import { db } from "@/db";
import { aiAnalyses, deliveries, deliveryEvents, news } from "@/db/schema";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getActiveAiConfig } from "@/lib/ai/config-service";
import { deliverToBale } from "./bale";
import { deliverToLocal } from "./local";
import { renderPublishingMessage } from "./template";
import { loadMessageExtras } from "./index";
import type { DeliveryDestination } from "./types";
import { isOpenCandidate } from "./types";

export type DeliveryAction =
  | "created"
  | "approved"
  | "rejected"
  | "edited"
  | "override"
  | "send_started"
  | "sent"
  | "failed"
  | "retry"
  | "cancelled";

export type DeliveryMutationResult =
  | { ok: true; deliveryId: string; status: string; message?: string; detail?: null }
  | { ok: false; code: string; message: string; detail?: string | null };

const DESTINATIONS: DeliveryDestination[] = ["local", "bale"];

function isDeliveryDestination(value: unknown): value is DeliveryDestination {
  return typeof value === "string" && (DESTINATIONS as readonly string[]).includes(value);
}

async function logEvent(
  deliveryId: string,
  event: DeliveryAction,
  detail?: string | null,
  actor?: string | null,
): Promise<void> {
  try {
    await db.insert(deliveryEvents).values({ deliveryId, event, detail: detail?.slice(0, 800) ?? null, actor: actor ?? null });
  } catch (error) {
    // Audit is best-effort: it must never break a successful publish action.
    console.error("[publishing] event log failed:", String(error).slice(0, 140));
  }
}

async function latestSuccessAnalysisId(newsId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: aiAnalyses.id })
    .from(aiAnalyses)
    .where(and(eq(aiAnalyses.newsId, newsId), eq(aiAnalyses.status, "success")))
    .orderBy(desc(aiAnalyses.createdAt))
    .limit(1);
  return row?.id ?? null;
}

async function findOpenCandidate(newsId: string, destination: DeliveryDestination) {
  const [row] = await db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.newsId, newsId),
        eq(deliveries.destination, destination),
        sql`${deliveries.status} IN ('pending_approval', 'approved')`,
      ),
    )
    .orderBy(desc(deliveries.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Creates (or reuses) the delivery candidate for one analyzed news item.
 * Idempotent: an existing open candidate is returned untouched, and a lost
 * insert race re-reads the winner instead of duplicating.
 */
export async function ensureDeliveryCandidate(
  newsId: string,
  destinationInput: unknown,
  actor?: string | null,
): Promise<DeliveryMutationResult> {
  const destination = isDeliveryDestination(destinationInput) ? destinationInput : null;
  if (!destination) {
    return { ok: false, code: "invalid_destination", message: "مقصد ارسال معتبر نیست (local یا bale)." };
  }

  const [article] = await db.select().from(news).where(eq(news.id, newsId)).limit(1);
  if (!article) {
    return { ok: false, code: "not_found", message: "خبر مورد نظر پیدا نشد." };
  }

  // Publishing requires an analysis; AI and delivery stay separate services.
  if (!article.analyzedAt || !article.summary?.trim()) {
    return {
      ok: false,
      code: "not_analyzed",
      message: "این خبر هنوز تحلیل موفق ندارد؛ ابتدا آن را تحلیل کنید.",
    };
  }

  const existing = await findOpenCandidate(newsId, destination);
  if (existing) {
    return { ok: true, deliveryId: existing.id, status: existing.status, message: "برای این خبر و مقصد، نامزد فعال از قبل وجود داشت." };
  }

  // Informational only (never blocks): tells the admin this destination already
  // received the article, so the send step will need an explicit re-publish.
  const [alreadySent] = await db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(and(eq(deliveries.newsId, newsId), eq(deliveries.destination, destination), eq(deliveries.status, "sent")))
    .limit(1);

  const config = await getActiveAiConfig();
  const extras = await loadMessageExtras(article);
  const message = renderPublishingMessage(config.publishingTemplate, article, extras);
  const analysisId = await latestSuccessAnalysisId(newsId);

  try {
    const [created] = await db
      .insert(deliveries)
      .values({
        newsId,
        destination,
        status: "pending_approval",
        triggeredBy: "manual",
        message,
        aiAnalysisId: analysisId,
        updatedAt: new Date(),
      })
      .returning();

    await logEvent(created.id, "created", `نسخه پیکربندی ${config.version} برای قالب استفاده شد`, actor);

    return {
      ok: true,
      deliveryId: created.id,
      status: created.status,
      message: alreadySent
        ? "نامزد ساخته شد — توجه: این خبر قبلاً به همین مقصد ارسال شده و مرحله ارسال به «ارسال مجدد (اجباری)» نیاز دارد."
        : undefined,
    };
  } catch (error) {
    // Unique-violation path: a concurrent request won the race — reuse its row.
    const raced = await findOpenCandidate(newsId, destination);
    if (raced) {
      return { ok: true, deliveryId: raced.id, status: raced.status, message: "نامزد هم‌زمان ساخته شد؛ همان رکورد استفاده شد." };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "db_error", message: "ساخت نامزد ارسال ناموفق بود.", detail: detail.slice(0, 200) };
  }
}

async function requireDelivery(id: string) {
  const [row] = await db.select().from(deliveries).where(eq(deliveries.id, id)).limit(1);
  return row ?? null;
}

/** Approve a candidate. `force=true` is the explicit AI override path. */
export async function approveDelivery(
  id: string,
  options: { actor?: string | null; force?: boolean; reason?: string | null } = {},
): Promise<DeliveryMutationResult> {
  const delivery = await requireDelivery(id);
  if (!delivery) return { ok: false, code: "not_found", message: "رکورد ارسال پیدا نشد." };

  if (!isOpenCandidate(delivery.status)) {
    return {
      ok: false,
      code: "invalid_status",
      message: `فقط نامزد باز قابل تأیید است (وضعیت فعلی: ${delivery.status}).`,
    };
  }

  let article: typeof news.$inferSelect | null = null;
  if (!options.force) {
    const [row] = await db.select({ shouldSend: news.shouldSend }).from(news).where(eq(news.id, delivery.newsId)).limit(1);
    article = row ? ({ shouldSend: row.shouldSend } as typeof news.$inferSelect) : null;

    if (row && row.shouldSend !== true) {
      return {
        ok: false,
        code: "needs_override",
        message: "هوش مصنوعی ارسال این خبر را توصیه نکرده است. برای تأیید دستی، از گزینه «تأیید برخلاف نظر AI» استفاده کنید و دلیل را وارد کنید.",
      };
    }
  }

  // An override must be explained and recorded — the AI row is never edited.
  if (options.force) {
    const reason = options.reason?.trim();
    if (!reason) {
      return { ok: false, code: "override_reason_required", message: "برای تأیید برخلاف نظر هوش مصنوعی، ذکر دلیل الزامی است." };
    }
  }

  const now = new Date();
  const [updated] = await db
    .update(deliveries)
    .set({
      status: "approved",
      approvedAt: now,
      approvedBy: options.actor ?? "admin",
      overrideRequested: Boolean(options.force),
      overrideReason: options.force ? (options.reason ?? "").slice(0, 800) : delivery.overrideReason,
      errorMessage: null,
      updatedAt: now,
    })
    .where(eq(deliveries.id, id))
    .returning();

  if (!updated) return { ok: false, code: "update_failed", message: "تأیید ناموفق بود." };

  if (options.force) {
    await logEvent(id, "override", `دلیل: ${(options.reason ?? "").slice(0, 400)}`, options.actor);
  }
  await logEvent(id, "approved", undefined, options.actor);

  return { ok: true, deliveryId: id, status: "approved" };
}

/** Reject a candidate (kept in history, never deleted). */
export async function rejectDelivery(id: string, reason: string | undefined, actor?: string | null): Promise<DeliveryMutationResult> {
  const delivery = await requireDelivery(id);
  if (!delivery) return { ok: false, code: "not_found", message: "رکورد ارسال پیدا نشد." };
  if (!isOpenCandidate(delivery.status)) {
    return { ok: false, code: "invalid_status", message: `این رکورد دیگر نامزد باز نیست (${delivery.status}).` };
  }

  await db
    .update(deliveries)
    .set({ status: "cancelled", errorMessage: reason?.trim() ? `رد شد: ${reason.trim()}`.slice(0, 500) : delivery.errorMessage, updatedAt: new Date() })
    .where(eq(deliveries.id, id));

  await logEvent(id, "rejected", reason ?? null, actor);
  return { ok: true, deliveryId: id, status: "cancelled" };
}

/**
 * Edit the final publishing artifact. Deliberately narrow: only an OPEN, not-yet
 * sent candidate can be edited, and only `deliveries.message` changes — the news
 * row and the AI analysis row are untouched by construction.
 */
export async function editDeliveryMessage(id: string, nextMessage: string, actor?: string | null): Promise<DeliveryMutationResult> {
  const delivery = await requireDelivery(id);
  if (!delivery) return { ok: false, code: "not_found", message: "رکورد ارسال پیدا نشد." };

  if (!isOpenCandidate(delivery.status)) {
    return { ok: false, code: "invalid_status", message: "پس از ارسال، متن پیام قابل تغییر نیست (تاریخچه حفظ می‌شود)." };
  }

  const message = nextMessage.trim();
  if (!message) return { ok: false, code: "empty_message", message: "متن پیام نمی‌تواند خالی باشد." };
  if (message.length > 4000) return { ok: false, code: "too_long", message: "حداکثر طول پیام ۴۰۰۰ کاراکتر است." };

  await db.update(deliveries).set({ message, updatedAt: new Date() }).where(eq(deliveries.id, id));
  await logEvent(id, "edited", `طول پیام: ${message.length}`, actor);

  return { ok: true, deliveryId: id, status: delivery.status };
}

/**
 * Send an APPROVED candidate to its provider.
 *
 * Idempotency: the row is claimed with an atomic status transition, so parallel
 * requests race for the claim and exactly one of them ever reaches the provider.
 * A row that already has a provider message id or sentAt is refused outright.
 */
export async function sendDelivery(
  id: string,
  actor?: string | null,
  options: { force?: boolean } = {},
): Promise<DeliveryMutationResult> {
  const delivery = await requireDelivery(id);
  if (!delivery) return { ok: false, code: "not_found", message: "رکورد ارسال پیدا نشد." };

  if (delivery.sentAt || delivery.providerMessageId) {
    return { ok: true, deliveryId: id, status: "sent", message: "این رکورد قبلاً با موفقیت ارسال شده بود (ارسال تکراری انجام نشد)." };
  }

  // Cross-row idempotency: a previous SUCCESSFUL delivery to the same
  // (news, destination) — e.g. one written by the auto-delivery pass — also
  // blocks a second publish, so an article is never silently duplicated in the
  // channel. Re-publishing stays possible only via an explicit forced call.
  if (!options.force) {
    const [prior] = await db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.newsId, delivery.newsId),
          eq(deliveries.destination, delivery.destination),
          eq(deliveries.status, "sent"),
          sql`${deliveries.id} <> ${id}`,
        ),
      )
      .limit(1);

    if (prior) {
      return {
        ok: false,
        code: "already_delivered",
        message:
          "این خبر قبلاً به همین مقصد ارسال شده است. در صورت نیاز به انتشار دوباره، از «ارسال مجدد (اجباری)» استفاده کنید تا این انتخاب در تاریخچه ثبت شود.",
        detail: prior.id,
      };
    }
  }

  if (delivery.status !== "approved") {
    return {
      ok: false,
      code: "not_approved",
      message: `فقط رکورد «تأییدشده» قابل ارسال است (وضعیت فعلی: ${delivery.status}).`,
    };
  }

  if (!delivery.message?.trim()) {
    return { ok: false, code: "empty_message", message: "متن پیام این رکورد خالی است؛ ابتدا آن را ویرایش کنید." };
  }

  if (!isDeliveryDestination(delivery.destination)) {
    return { ok: false, code: "invalid_destination", message: "مقصد این رکورد نامعتبر است." };
  }

  // Atomic claim: approved -> sending. Losers see 0 rows and stop.
  const [claimed] = await db
    .update(deliveries)
    .set({ status: "sending", updatedAt: new Date() })
    .where(and(eq(deliveries.id, id), eq(deliveries.status, "approved"), isNull(deliveries.sentAt), isNull(deliveries.providerMessageId)))
    .returning({ id: deliveries.id });

  if (!claimed) {
    return { ok: false, code: "in_flight", message: "این رکورد هم‌زمان در حال ارسال است یا قبلاً ارسال شده است." };
  }

  await logEvent(
    id,
    "send_started",
    options.force ? `مقصد: ${delivery.destination} — ارسال مجدد اجباری (خبر قبلاً به این مقصد رفته بود)` : `مقصد: ${delivery.destination}`,
    actor,
  );

  const text = delivery.message;
  let outcome: { ok: boolean; providerMessageId: string | null; errorMessage: string | null };
  try {
    outcome = delivery.destination === "bale" ? await deliverToBale(text) : await deliverToLocal(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outcome = { ok: false, providerMessageId: null, errorMessage: detail.slice(0, 200) };
  }

  const now = new Date();

  if (outcome.ok) {
    await db
      .update(deliveries)
      .set({
        status: "sent",
        sentAt: now,
        providerMessageId: outcome.providerMessageId,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(deliveries.id, id));

    await logEvent(id, "sent", `شناسه پیام: ${outcome.providerMessageId ?? "—"}`, actor);

    // News lifecycle: the article is now delivered.
    try {
      await db.update(news).set({ status: "SENT", updatedAt: now }).where(eq(news.id, delivery.newsId));
    } catch {
      // bookkeeping only
    }

    return { ok: true, deliveryId: id, status: "sent", message: outcome.providerMessageId ? `ارسال شد (messageId: ${outcome.providerMessageId})` : "ارسال شد." };
  }

  await db
    .update(deliveries)
    .set({
      status: "failed",
      errorMessage: (outcome.errorMessage ?? "ارسال ناموفق بود.").slice(0, 900),
      retryCount: sql`${deliveries.retryCount} + 1`,
      updatedAt: now,
    })
    .where(eq(deliveries.id, id));

  await logEvent(id, "failed", outcome.errorMessage ?? null, actor);

  return { ok: false, code: "send_failed", message: "ارسال ناموفق بود.", detail: outcome.errorMessage ?? null };
}

/**
 * Retry a FAILED send: reuses the stored content, re-arms the row as approved,
 * then sends. Refuses anything already sent.
 */
export async function retryDelivery(id: string, actor?: string | null): Promise<DeliveryMutationResult> {
  const delivery = await requireDelivery(id);
  if (!delivery) return { ok: false, code: "not_found", message: "رکورد ارسال پیدا نشد." };

  if (delivery.sentAt || delivery.providerMessageId) {
    return { ok: true, deliveryId: id, status: "sent", message: "این رکورد با موفقیت ارسال شده است؛ نیازی به تلاش مجدد نیست." };
  }

  if (delivery.status !== "failed") {
    return { ok: false, code: "invalid_status", message: `فقط رکورد ناموفق قابل تلاش مجدد است (وضعیت فعلی: ${delivery.status}).` };
  }

  await db
    .update(deliveries)
    .set({ status: "approved", approvedAt: delivery.approvedAt ?? new Date(), errorMessage: null, updatedAt: new Date() })
    .where(eq(deliveries.id, id));

  await logEvent(id, "retry", `تلاش شماره ${(delivery.retryCount ?? 0) + 1}`, actor);

  return sendDelivery(id, actor);
}

/** Cancel an open candidate (kept as history). */
export async function cancelDelivery(id: string, actor?: string | null): Promise<DeliveryMutationResult> {
  const delivery = await requireDelivery(id);
  if (!delivery) return { ok: false, code: "not_found", message: "رکورد ارسال پیدا نشد." };
  if (!isOpenCandidate(delivery.status)) {
    return { ok: false, code: "invalid_status", message: "این رکورد دیگر قابل لغو نیست." };
  }
  await db.update(deliveries).set({ status: "cancelled", updatedAt: new Date() }).where(eq(deliveries.id, id));
  await logEvent(id, "cancelled", undefined, actor);
  return { ok: true, deliveryId: id, status: "cancelled" };
}

/* ────────────────────────── admin reads ────────────────────────── */

export type AdminDeliveryFilters = {
  status?: string;
  destination?: string;
  q?: string;
  page?: number;
  pageSize?: number;
};

export async function listAdminDeliveries(filters: AdminDeliveryFilters) {
  const conditions = [];
  if (filters.status) conditions.push(eq(deliveries.status, filters.status));
  if (filters.destination) conditions.push(eq(deliveries.destination, filters.destination));
  if (filters.q?.trim()) conditions.push(ilikeAny(filters.q.trim()));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(Math.max(filters.pageSize ?? 20, 5), 100);

  const rows = await db
    .select({
      id: deliveries.id,
      newsId: deliveries.newsId,
      destination: deliveries.destination,
      status: deliveries.status,
      triggeredBy: deliveries.triggeredBy,
      createdAt: deliveries.createdAt,
      approvedAt: deliveries.approvedAt,
      sentAt: deliveries.sentAt,
      retryCount: deliveries.retryCount,
      overrideRequested: deliveries.overrideRequested,
      overrideReason: deliveries.overrideReason,
      errorMessage: deliveries.errorMessage,
      providerMessageId: deliveries.providerMessageId,
      newsTitle: news.title,
      newsSource: news.source,
      newsUrl: news.url,
      shouldSend: news.shouldSend,
      importanceScore: news.importanceScore,
      relevanceScore: news.relevanceScore,
      noveltyScore: news.noveltyScore,
      newsStatus: news.status,
      publishedAt: news.publishedAt,
    })
    .from(deliveries)
    .innerJoin(news, eq(deliveries.newsId, news.id))
    .where(where)
    .orderBy(desc(deliveries.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [[countRow], stats] = await Promise.all([
    db.select({ total: sql<number>`count(*)::int` }).from(deliveries).where(where),
    getDeliveryStats(),
  ]);

  return {
    rows: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      errorMessage: row.errorMessage ?? null,
    })),
    total: countRow?.total ?? 0,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil((countRow?.total ?? 0) / pageSize)),
    stats,
  };
}

function ilikeAny(term: string) {
  const pattern = `%${term.slice(0, 120)}%`;
  return or(ilikeNewsTitle(pattern), sql`${news.url} ILIKE ${pattern}`);
}

function ilikeNewsTitle(pattern: string) {
  return sql`${news.title} ILIKE ${pattern}`;
}

export async function getDeliveryStats() {
  const rows = await db
    .select({ status: deliveries.status, count: sql<number>`count(*)::int` })
    .from(deliveries)
    .groupBy(deliveries.status);

  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.status] = row.count;

  const [todayRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deliveries)
    .where(and(eq(deliveries.status, "sent"), sql`${deliveries.sentAt} >= date_trunc('day', now())`));

  return {
    pendingApproval: byStatus["pending_approval"] ?? 0,
    approved: byStatus["approved"] ?? 0,
    sending: byStatus["sending"] ?? 0,
    sent: byStatus["sent"] ?? 0,
    failed: byStatus["failed"] ?? 0,
    cancelled: byStatus["cancelled"] ?? 0,
    pendingLegacy: byStatus["pending"] ?? 0,
    sentToday: todayRow?.count ?? 0,
    byStatus,
  };
}

export async function getDeliveryDetail(id: string) {
  const [row] = await db
    .select({ delivery: deliveries, article: news })
    .from(deliveries)
    .innerJoin(news, eq(deliveries.newsId, news.id))
    .where(eq(deliveries.id, id))
    .limit(1);

  if (!row) return null;

  const [analysis] = row.delivery.aiAnalysisId
    ? await db.select().from(aiAnalyses).where(eq(aiAnalyses.id, row.delivery.aiAnalysisId)).limit(1)
    : [null];

  const events = await db
    .select()
    .from(deliveryEvents)
    .where(eq(deliveryEvents.deliveryId, id))
    .orderBy(desc(deliveryEvents.createdAt))
    .limit(50);

  return { delivery: row.delivery, article: row.article, analysis: analysis ?? null, events };
}

/** Delivery summary per news id (news list / news detail). */
export async function getDeliverySummaryForNews(newsIds: string[]): Promise<
  Record<string, { bale: string | null; local: string | null; openCandidate: boolean; lastStatus: string | null }>
> {
  const result: Record<string, { bale: string | null; local: string | null; openCandidate: boolean; lastStatus: string | null }> = {};
  for (const id of newsIds) result[id] = { bale: null, local: null, openCandidate: false, lastStatus: null };
  if (newsIds.length === 0) return result;

  const rows = await db
    .select({
      newsId: deliveries.newsId,
      destination: deliveries.destination,
      status: deliveries.status,
      createdAt: deliveries.createdAt,
    })
    .from(deliveries)
    .where(inArray(deliveries.newsId, newsIds))
    .orderBy(desc(deliveries.createdAt))
    .limit(2000);

  for (const row of rows) {
    const bucket = result[row.newsId];
    if (!bucket) continue;
    if (!bucket.lastStatus) bucket.lastStatus = row.status;

    const success = row.status === "sent";
    if (row.destination === "bale" && !bucket.bale) bucket.bale = success ? "sent" : row.status;
    if (row.destination === "local" && !bucket.local) bucket.local = success ? "sent" : row.status;
    if (success) {
      if (row.destination === "bale") bucket.bale = "sent";
      if (row.destination === "local") bucket.local = "sent";
    }
    if (isOpenCandidate(row.status)) bucket.openCandidate = true;
  }

  return result;
}
