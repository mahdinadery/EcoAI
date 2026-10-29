/**
 * Scheduled automatic publishing — the full pass (SERVER-SIDE ONLY).
 *
 *   fetch due feeds → analyze pending articles → send matching ones (Bale)
 *
 * Triggered by the external scheduler (`POST /api/agent/scheduler/tick`, called
 * by GitHub Actions every few minutes) only when a configured local time slot
 * is due, or manually from the dashboard. The pass is idempotent at the
 * delivery layer: `sendNewsDelivery` refuses to send an article twice to the
 * same destination, and `lastRunSlot` prevents the same slot from running again.
 */

import { db } from "@/db";
import { agentSchedules, deliveries, news, type NewsRow } from "@/db/schema";
import { getActiveAiConfig, readActiveOperationalSettings } from "@/lib/ai/config-service";
import { synthesizeBulletinBrief } from "@/lib/ai/bulletin-brief";
import { sendBulletinDelivery } from "@/lib/delivery";
import { buildBulletinMessage, resolveBulletinSettings, MAX_BULLETIN_ITEMS, pickBulletinItems } from "@/lib/delivery/bulletin";
import { diagnoseDbError } from "@/lib/admin/db-errors";
import { expandTargets } from "@/lib/delivery/types";
import {
  analyzeSequentially,
  applyTopicGate,
  recoverStaleProcessing,
  selectAnalysisBacklog,
} from "@/lib/news/analysis-queue";
import { collapseEventGroups } from "@/lib/news/corroboration";
import { deriveGapQueries, buildSearchUrl, MAX_GAP_QUERIES } from "@/lib/news/gap-search";
import { fetchFeed, type NormalizedNews } from "@/lib/news/rss";
import { ingestAllActiveSources, ingestSearchItems } from "@/lib/news/source-ingest";
import { and, asc, desc, eq, gte, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { runAutoDeliveryPass } from "./index";
import { evaluateArticle, type AutoSendRule } from "./rules";
import type {
  AgentRunSummary,
  AgentScheduleConfig,
  ScheduleAnalysisSummary,
  ScheduleBulletinSummary,
  ScheduleGapSummary,
  ScheduleIngestSummary,
  ScheduleSendSummary,
} from "./schedule";
import { markBulletinSent, markGapSearchRun } from "./schedule-store";

/** Root-cause-first, secret-free text (drizzle hides the real error in `cause`). */
function errorText(error: unknown): string {
  return diagnoseDbError(error).detail.slice(0, 300);
}

/** The schedule's own policy — independent from the post-analysis auto-send rule. */
export function scheduleToRule(config: AgentScheduleConfig): AutoSendRule {
  return {
    enabled: true,
    destination: config.destination,
    minImportance: config.minImportance,
    minRelevance: config.minRelevance,
    minNovelty: config.minNovelty,
    requireAiRecommendation: config.requireAiRecommendation,
    categories: null,
    maxItemsPerPass: config.maxSend,
  };
}

/**
 * Analyzed articles that were never successfully sent to this pass's
 * destination(s), newest first. Already-delivered articles are excluded at the
 * SQL level so the batch is not wasted re-checking them.
 *
 * Multi-source rule («یک خبر انتخاب شود»): same-event copies (shared
 * similarity key) collapse to ONE representative — the highest-importance
 * copy — and an event whose ANY copy was already delivered is skipped entirely
 * (the channel must never receive the same story twice).
 */
export async function selectSendCandidates(
  config: Pick<AgentScheduleConfig, "destination" | "maxSend">,
): Promise<string[]> {
  const targets = expandTargets(config.destination);

  const rows = await db
    .select({
      id: news.id,
      similarityKey: news.similarityKey,
      importanceScore: news.importanceScore,
      publishedAt: news.publishedAt,
    })
    .from(news)
    .where(
      and(
        isNotNull(news.analyzedAt),
        sql`coalesce(${news.summary}, '') <> ''`,
        sql`${news.status} NOT IN ('DUPLICATE', 'SKIPPED_OFFTOPIC')`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(deliveries)
            .where(
              and(
                eq(deliveries.newsId, news.id),
                eq(deliveries.status, "sent"),
                inArray(deliveries.destination, targets),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(sql`coalesce(${news.publishedAt}, ${news.createdAt})`))
    // Over-fetch: collapsing same-event copies frees slots for other events.
    .limit(Math.max(config.maxSend * 3, 30));

  // Event-level exclusion: if ANY same-key copy was already delivered to these
  // targets, the event is old news for this channel.
  const keys = [...new Set(rows.map((row) => (row.similarityKey ?? "").trim()).filter(Boolean))];
  const deliveredKeys = new Set<string>();
  if (keys.length > 0) {
    const sentRows = await db
      .select({ key: news.similarityKey })
      .from(news)
      .innerJoin(deliveries, eq(deliveries.newsId, news.id))
      .where(
        and(
          eq(deliveries.status, "sent"),
          inArray(deliveries.destination, targets),
          inArray(news.similarityKey, keys),
        ),
      )
      .limit(50);
    for (const row of sentRows) {
      if (row.key) deliveredKeys.add(row.key);
    }
  }

  const fresh = rows.filter((row) => {
    const key = (row.similarityKey ?? "").trim();
    return !key || !deliveredKeys.has(key);
  });

  // One representative per event (highest importance, newest on ties).
  const collapsed = collapseEventGroups(fresh);
  return collapsed.slice(0, config.maxSend).map((row) => row.id);
}

/**
 * Rule-matching, never-delivered articles ranked for the digest (top 5).
 * Same strict AND rule as per-item sends — a bulletin can never smuggle in an
 * article that would fail the single-message path.
 */
async function selectBulletinCandidates(config: AgentScheduleConfig): Promise<NewsRow[]> {
  const rule = scheduleToRule(config);
  // Rank the whole eligible daily pool, not the first 50 newest IDs.
  const rows = await db.select().from(news).where(and(
    isNotNull(news.analyzedAt),
    sql`coalesce(${news.publishedAt}, ${news.createdAt}) <= now()`,
    sql`(coalesce(${news.publishedAt}, ${news.createdAt}) AT TIME ZONE ${config.timezone})::date = (now() AT TIME ZONE ${config.timezone})::date`,
    sql`${news.status} NOT IN ('DUPLICATE', 'SKIPPED_OFFTOPIC')`,
    notExists(db.select({ one: sql`1` }).from(deliveries).where(and(
      eq(deliveries.newsId, news.id), eq(deliveries.status, "sent"), inArray(deliveries.destination, expandTargets(config.destination)),
    ))),
  ));
  const matching = rows.filter((row) => evaluateArticle(row, rule).matches);
  return pickBulletinItems(collapseEventGroups(matching), MAX_BULLETIN_ITEMS);
}

/** "both" mode: items already sent to the destination since the last bulletin. */
async function selectRecapItems(config: AgentScheduleConfig): Promise<NewsRow[]> {
  const targets = expandTargets(config.destination);
  const [row] = await db
    .select({ at: agentSchedules.lastBulletinAt })
    .from(agentSchedules)
    .orderBy(asc(agentSchedules.createdAt))
    .limit(1);
  // First recap ever => last day.
  const since = row?.at ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

  const sentRows = await db
    .select({ id: deliveries.newsId })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.status, "sent"),
        inArray(deliveries.destination, targets),
        gte(deliveries.sentAt, since),
      ),
    )
    .orderBy(desc(deliveries.sentAt))
    .limit(1000);

  const ids = [...new Set(sentRows.map((entry) => entry.id))];
  if (ids.length === 0) return [];
  const rows = await db.select().from(news).where(inArray(news.id, ids));
  // Same-event copies collapse to one digest entry.
  const qualifying = rows.filter(row => {
    const time = row.publishedAt ?? row.createdAt;
    return time.getTime() <= Date.now() && new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone }).format(time) === new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone }).format(new Date()) && evaluateArticle(row, scheduleToRule(config)).matches;
  });
  return pickBulletinItems(collapseEventGroups(qualifying), MAX_BULLETIN_ITEMS);
}

/** Builds the digest (AI intro + minimal columns) and sends it as ONE message. */
async function sendBulletin(
  config: AgentScheduleConfig,
  items: NewsRow[],
  options: { recordRows: boolean; recordIds?: string[]; trigger: "schedule" | "manual" },
): Promise<ScheduleBulletinSummary> {
  const aiConfig = await getActiveAiConfig();
  const bulletin = resolveBulletinSettings(aiConfig.decisionRules.bulletin);
  items = items.slice(0, bulletin.maxItems);
  // Batch lookup of other outlets carrying each corroborated item's event —
  // the digest lists them under the chosen story.
  const sourceNamesByKey = new Map<string, string[]>();
  const keys = [...new Set(items.map((item) => (item.similarityKey ?? "").trim()).filter(Boolean))];
  if (keys.length > 0) {
    try {
      const siblingRows = await db
        .select({ key: news.similarityKey, source: news.source })
        .from(news)
        .where(
          and(
            inArray(news.similarityKey, keys),
            gte(news.createdAt, new Date(Date.now() - 72 * 60 * 60 * 1000)),
          ),
        )
        .limit(40);
      for (const row of siblingRows) {
        if (!row.key) continue;
        const list = sourceNamesByKey.get(row.key) ?? [];
        if (!list.includes(row.source)) list.push(row.source);
        sourceNamesByKey.set(row.key, list);
      }
    } catch {
      // Best-effort: the badge alone still marks the item as corroborated.
    }
  }

  const intro = await synthesizeBulletinBrief(
    items.map((item) => ({
      title: item.title,
      oneLiner: item.summary,
      whyItMatters: item.whyItMatters,
      hashtags: item.hashtags,
    })),
    { model: aiConfig.model, enabled: bulletin.aiIntro, introPrompt: bulletin.introPrompt, maxTokens: bulletin.introMaxTokens },
  );

  const text = buildBulletinMessage({
    settings: bulletin,
    intro,
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      oneLiner: item.summary,
      whyItMatters: item.whyItMatters,
      hashtags: item.hashtags,
      url: item.url,
      importanceScore: item.importanceScore,
      publishedAt: item.publishedAt,
      corroborated: (item.corroborationCount ?? 0) >= 2,
      corroborationSources: ((sourceNamesByKey.get((item.similarityKey ?? "").trim()) ?? []) as string[]).filter(
        (source) => source !== item.source,
      ),
      entityTags: item.entityTags ?? [],
    })),
    generatedAt: new Date(),
    timezone: config.timezone,
  });

  const result = await sendBulletinDelivery({
    text,
    // Ledger rows only for the never-delivered subset (recap items already
    // carry their own rows from the per-item sends).
    newsIds: options.recordIds ? options.recordIds.filter(id => items.some(item => item.id === id)) : items.map((item) => item.id),
    target: config.destination,
    trigger: options.trigger === "schedule" ? "auto" : "manual",
    recordRows: options.recordRows,
  });

  if (!result.ok) {
    return { attempted: true, sent: false, itemCount: items.length, reason: "delivery_failed" };
  }

  await markBulletinSent();
  return { attempted: true, sent: true, itemCount: items.length, reason: null };
}

/**
 * Bulletin pass: pick qualifying items (or recap what was sent), fall back to a
 * coverage-gap search when the channel would otherwise be silent, then send one
 * digest message. `publishMode: "both"` uses the recap selection.
 */
async function runBulletinPhase(
  config: AgentScheduleConfig,
  trigger: "schedule" | "manual",
): Promise<{ summary: ScheduleBulletinSummary; gapSearch?: ScheduleGapSummary | null }> {
  if (config.publishMode === "both") {
    // "both": the digest wraps up what the singles already sent. When the
    // recap window is empty (nothing single-sent since the last digest), fall
    // back to never-delivered qualifying items so the digest still goes out —
    // silently skipping here is what made «بولتن» look broken in practice.
    const recaps = await selectRecapItems(config);
    const fresh = await selectBulletinCandidates(config);
    const combined = pickBulletinItems(collapseEventGroups([...recaps, ...fresh]), MAX_BULLETIN_ITEMS);
    if (combined.length > 0) {
      return { summary: await sendBulletin(config, combined, { recordRows: true, recordIds: fresh.map(item => item.id), trigger }) };
    }
    return { summary: { attempted: true, sent: false, itemCount: 0, reason: "nothing_new" } };
  }

  // "bulletin" mode — or a manual digest run from any mode.
  let items = await selectBulletinCandidates(config);
  let gapSearch: ScheduleGapSummary | null = null;

  if (items.length === 0 && config.gapSearchEnabled) {
    // Nothing qualifying: search the coverage gaps NOW so the digest is not
    // silently skipped (analyze only — delivery is the digest's job).
    gapSearch = await runGapSearchPhase(config, 0, false);
    if (gapSearch.ran) items = await selectBulletinCandidates(config);
  }

  if (items.length === 0) {
    // Recap fallback: the qualifying items may already have gone out as
    // singles (manual sends, entity bulletins, a mode switch). A digest of
    // what was sent is always better than a silently skipped slot.
    const recaps = await selectRecapItems(config);
    if (recaps.length > 0) {
      return {
        summary: await sendBulletin(config, recaps, { recordRows: false, trigger }),
        gapSearch,
      };
    }
    return {
      summary: { attempted: true, sent: false, itemCount: 0, reason: "no_qualifying_items" },
      gapSearch,
    };
  }

  return {
    summary: await sendBulletin(config, items, {
      recordRows: true,
      recordIds: items.map((item) => item.id),
      trigger,
    }),
    gapSearch,
  };
}

/** Gap-search runs at most this often (the operator's target cadence is ~30min). */
const GAP_SEARCH_COOLDOWN_MS = 3 * 60 * 60 * 1000;

/** Upper bound of gap items stored/analyzed per run. */
const GAP_SEARCH_MAX_ITEMS = 5;

/**
 * Coverage-gap search phase (roadmap Phase 1 #2). Runs ONLY when the pass sent
 * nothing, so it can never crowd out real coverage. Best-effort by design:
 * failures are summarized, never thrown at the pass.
 */
async function runGapSearchPhase(
  config: AgentScheduleConfig,
  alreadySent: number,
  /** false = ingest+analyze only (bulletin mode holds delivery for the digest). */
  deliver: boolean,
): Promise<ScheduleGapSummary> {
  const base: ScheduleGapSummary = {
    ran: false,
    reason: null,
    queries: [],
    found: 0,
    analyzed: 0,
    sent: 0,
  };

  if (alreadySent > 0) return { ...base, reason: "already_sent" };

  try {
    // Cooldown against the singleton row, so back-to-back manual runs don't
    // hammer the search provider.
    const [row] = await db
      .select({ at: agentSchedules.lastGapSearchAt })
      .from(agentSchedules)
      .orderBy(asc(agentSchedules.createdAt))
      .limit(1);
    const lastAt = row?.at ? new Date(row.at).getTime() : 0;
    if (lastAt > 0 && Date.now() - lastAt < GAP_SEARCH_COOLDOWN_MS) {
      return { ...base, reason: "cooldown" };
    }

    const settings = await readActiveOperationalSettings();
    const coverageKeywords =
      settings?.topicFilter?.topics
        ?.filter((topic) => topic.enabled)
        .flatMap((topic) => topic.keywords) ?? [];
    const queries = deriveGapQueries(coverageKeywords, config.gapSearchQueries, MAX_GAP_QUERIES);
    if (queries.length === 0) return { ...base, reason: "no_queries" };

    const template = process.env.NEWS_SEARCH_URL_TEMPLATE?.trim() || null;
    const collected: NormalizedNews[] = [];
    let successfulFetches = 0;

    for (const query of queries) {
      try {
        const result = await fetchFeed(buildSearchUrl(query, template));
        if (result.ok) {
          successfulFetches += 1;
          collected.push(...result.items);
        }
      } catch {
        // One broken provider response must not stop the other queries.
      }
    }

    if (successfulFetches === 0) {
      await markGapSearchRun();
      return { ...base, reason: "all_fetches_failed", queries };
    }

    const limited = collected.slice(0, GAP_SEARCH_MAX_ITEMS);
    const report = await ingestSearchItems(limited, "جست‌وجوی هدفمند");

    let analyzed = 0;
    let sent = 0;
    if (report.newArticleIds.length > 0) {
      // The topic gate already ran at store time; analyze only the fresh gap
      // items, then deliver with the SAME strict rule as the scheduled pass.
      const results = await analyzeSequentially(report.newArticleIds.slice(0, GAP_SEARCH_MAX_ITEMS));
      analyzed = results.filter((item) => item.ok).length;

      if (deliver) {
        const candidates = await selectSendCandidates(config);
        const gapCandidates = candidates.filter((id) => report.newArticleIds.includes(id));
        if (gapCandidates.length > 0) {
          const delivery = await runAutoDeliveryPass({
            newsIds: gapCandidates,
            rule: scheduleToRule(config),
          });
          sent = delivery.sent;
        }
      }
    }

    await markGapSearchRun();
    return {
      ran: true,
      reason: null,
      queries,
      found: report.itemsFound,
      analyzed,
      sent,
    };
  } catch (error) {
    return { ...base, reason: "all_fetches_failed", detail: errorText(error) };
  }
}

let activeRun = false;

/** True while a pass is running in this server instance (overlap guard). */
export function isScheduledRunInProgress(): boolean {
  return activeRun;
}

/** Fetch → analyze → send. Never throws; every failure lands in `errors`. */
export async function runScheduledPass(args: {
  config: AgentScheduleConfig;
  trigger: "schedule" | "manual";
  slotKey?: string | null;
  /** "bulletin" builds/sends the digest instead of per-item messages. */
  passKind?: "regular" | "bulletin";
}): Promise<AgentRunSummary> {
  activeRun = true;
  try {
    return await executeScheduledPass(args);
  } finally {
    activeRun = false;
  }
}

async function executeScheduledPass(args: {
  config: AgentScheduleConfig;
  trigger: "schedule" | "manual";
  slotKey?: string | null;
  passKind?: "regular" | "bulletin";
}): Promise<AgentRunSummary> {
  const startedAt = new Date();
  const errors: string[] = [];

  let ingest: ScheduleIngestSummary | null = null;
  let analysis: ScheduleAnalysisSummary | null = null;
  let send: ScheduleSendSummary | null = null;

  // 1) Fetch every active source (scheduled runs ignore per-source intervals:
  //    the digest must contain everything available right now).
  try {
    const result = await ingestAllActiveSources();
    if (result.ok) {
      ingest = {
        attempted: true,
        sources: result.bySource?.length ?? 1,
        created: result.stored,
        duplicates: result.duplicates,
        failed: 0,
      };
    } else {
      ingest = { attempted: true, sources: 0, created: 0, duplicates: 0, failed: 1, detail: result.message };
      errors.push(`دریافت اخبار: ${result.message}`);
    }
  } catch (error) {
    const detail = errorText(error);
    ingest = { attempted: true, sources: 0, created: 0, duplicates: 0, failed: 1, detail };
    errors.push(`دریافت اخبار: ${detail}`);
  }

  // 2) Analyze the pending backlog (oldest first, bounded per run).
  try {
    await recoverStaleProcessing();

    const selected = await selectAnalysisBacklog(args.config.maxAnalyze);
    const gated = await applyTopicGate(selected);
    const results = await analyzeSequentially(gated.pass);

    const failedAnalyses = results.filter((item) => !item.ok);

    analysis = {
      selected: selected.length,
      analyzed: results.filter((item) => item.ok).length,
      failed: failedAnalyses.length,
      skippedOfftopic: gated.skipped.length,
    };

    // Without this, a missing AI key only shows up as "0 analyzed / N failed"
    // and the dashboard cannot tell the operator why nothing was sent.
    if (failedAnalyses.length > 0) {
      const first = failedAnalyses[0];
      const reason = first.message ?? first.code ?? "ناموفق";
      const rest = failedAnalyses.length > 1 ? ` (و ${failedAnalyses.length - 1} مورد دیگر)` : "";
      errors.push(`تحلیل خبر: ${reason}${rest}`);
    }
  } catch (error) {
    const detail = errorText(error);
    analysis = { selected: 0, analyzed: 0, failed: 0, skippedOfftopic: 0 };
    errors.push(`تحلیل اخبار: ${detail}`);
  }

  // 3) Delivery — per-item messages, or held for the digest, depending on the
  //    pass kind and the configured publish mode.
  let gapSearch: ScheduleGapSummary | null = null;
  let bulletin: ScheduleBulletinSummary | null = null;

  if (args.passKind === "bulletin") {
    // Digest pass: everything analyzed above goes through the same strict
    // rule, then out as ONE bulletin message.
    try {
      const outcome = await runBulletinPhase(args.config, args.trigger);
      bulletin = outcome.summary;
      gapSearch = outcome.gapSearch ?? null;
    } catch (error) {
      bulletin = { attempted: true, sent: false, itemCount: 0, reason: "delivery_failed" };
      errors.push(`بولتن: ${errorText(error)}`);
    }
  } else if (args.config.publishMode === "bulletin") {
    // hold_all: nothing goes out per-item; the next bulletin carries it.
    send = {
      enabled: true,
      destination: args.config.destination,
      considered: 0,
      matched: 0,
      sent: 0,
      skippedDuplicates: 0,
      skippedReview: 0,
      failed: 0,
      heldForBulletin: true,
    };
  } else {
    // single | both — send everything analyzed and not yet delivered.
    try {
      const candidates = await selectSendCandidates(args.config);
      const result = await runAutoDeliveryPass({
        newsIds: candidates,
        rule: scheduleToRule(args.config),
      });

      send = {
        enabled: result.enabled,
        destination: result.destination,
        considered: result.considered,
        matched: result.matched,
        sent: result.sent,
        skippedDuplicates: result.skippedDuplicates,
        skippedReview: result.skippedReview,
        failed: result.failed,
        // Keep a few rejected candidates with their reasons so the operator can
        // see WHY a news item was not sent instead of guessing at the thresholds.
        rejected: result.items
          .filter((item) => item.outcome === "not_matched" || item.outcome === "skipped_review")
          .slice(0, 5)
          .map((item) => ({ title: item.title, reasons: item.reasons ?? [] })),
      };

      for (const item of result.items) {
        if (item.outcome === "failed" && item.errors?.length) {
          errors.push(`${item.title}: ${item.errors.join(" | ")}`);
        }
      }
    } catch (error) {
      const detail = errorText(error);
      send = {
        enabled: true,
        destination: args.config.destination,
        considered: 0,
        matched: 0,
        sent: 0,
        skippedDuplicates: 0,
        skippedReview: 0,
        failed: 0,
      };
      errors.push(`ارسال خودکار: ${detail}`);
    }

    // 4) Coverage-gap search — only when this pass sent nothing and the feature
    //    is enabled (bulletin passes handle their own silence inside the phase).
    if (args.config.gapSearchEnabled) {
      try {
        gapSearch = await runGapSearchPhase(args.config, send.sent, true);
      } catch (error) {
        gapSearch = {
          ran: false,
          reason: "all_fetches_failed",
          queries: [],
          found: 0,
          analyzed: 0,
          sent: 0,
        };
        errors.push(`جست‌وجوی هدفمند: ${errorText(error)}`);
      }
    }
  }

  const finishedAt = new Date();

  return {
    ok: errors.length === 0,
    trigger: args.trigger,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    slotKey: args.slotKey ?? null,
    ingest,
    analysis,
    send,
    gapSearch,
    bulletin,
    errors: errors.slice(0, 10),
  };
}
