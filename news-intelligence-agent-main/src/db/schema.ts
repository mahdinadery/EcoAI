import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type {
  AiAutoSendPolicy,
  AiDecisionRules,
  AiFeaturesConfig,
  AiOutputSchema,
  AiTopicFilterConfig,
} from "@/lib/ai/config-types";
import type { AgentRunSummary } from "@/lib/agent/schedule";

/**
 * Registered news sources (Milestone 6 — Data Layer).
 *
 * One row per feed/API endpoint. RSS is the working ingestion type; `api` is
 * modeled for the future only. Per-source health/statistics columns are updated
 * by the ingestion pipeline so the admin UI can show source health without a
 * separate metrics store.
 */
export const newsSources = pgTable(
  "news_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    // "rss" (working) | "api" (data model prepared; ingestion not implemented)
    type: text("type").notNull().default("rss"),
    url: text("url").notNull(),
    description: text("description"),
    // Default/initial category hint for items from this source (informational).
    category: text("category"),
    // 1 = Highest .. 5 = Lowest. Stored for future ranking/weighting only.
    priority: integer("priority").notNull().default(3),
    active: boolean("active").notNull().default(true),
    fetchIntervalMinutes: integer("fetch_interval_minutes").notNull().default(30),
    maxItemsPerFetch: integer("max_items_per_fetch").notNull().default(50),

    // Health & statistics (written by the ingestion pipeline).
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: "date" }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    errorCount: integer("error_count").notNull().default(0),
    totalFetched: integer("total_fetched").notNull().default(0),
    totalAccepted: integer("total_accepted").notNull().default(0),
    totalDuplicates: integer("total_duplicates").notNull().default(0),
    // Health snapshot of the LAST successful fetch (Phase 1 feed health):
    // "200 OK with zero items" and "feed of month-old news" are both unhealthy
    // even though the fetch itself succeeded.
    lastItemCount: integer("last_item_count"),
    lastNewestPublishedAt: timestamp("last_newest_published_at", { withTimezone: true, mode: "date" }),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("news_sources_active_idx").on(table.active)],
);

/**
 * News model — raw source data + processing lifecycle + AI analysis snapshot.
 *
 * Raw vs normalized: `title`/`description`/`content` are what the source
 * provided (never rewritten by the pipeline); `normalizedTitle`/
 * `normalizedContent` hold the cleaned values used downstream. `url` is the
 * original article URL, `canonicalUrl` is the tracking-stripped identity used
 * for duplicate detection alongside `externalId`.
 *
 * The inline AI columns remain the "latest analysis" snapshot (every existing
 * screen and the delivery pipeline read them); full history lives in
 * `ai_analyses` and is appended to, never overwritten.
 */
export const news = pgTable(
  "news",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Source identity. sourceId is null for rows ingested before Milestone 6.
    sourceId: uuid("source_id").references(() => newsSources.id, { onDelete: "set null" }),
    source: text("source").notNull(),
    externalId: text("external_id"),

    // Original information (never mutated by processing).
    title: text("title").notNull(),
    // Duplicate detection anchor: one row per article URL (preserved from before).
    url: text("url").notNull(),
    // Conservative canonical form (tracking params removed) for smarter dedupe.
    canonicalUrl: text("canonical_url"),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    description: text("description"),
    content: text("content"),
    author: text("author"),
    imageUrl: text("image_url"),

    // Processing lifecycle — see src/lib/news/status.ts (NewsStatus values).
    status: text("status").notNull().default("READY_FOR_AI"),
    normalizedTitle: text("normalized_title"),
    normalizedContent: text("normalized_content"),
    // When this row was detected as a duplicate, the original it points at.
    duplicateOfId: uuid("duplicate_of_id").references((): AnyPgColumn => news.id, { onDelete: "set null" }),

    // Timestamps.
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),

    // Latest AI analysis snapshot (Milestone 4) — nullable until analyzed.
    summary: text("summary"),
    category: text("category"),
    importanceScore: integer("importance_score"),
    relevanceScore: integer("relevance_score"),
    noveltyScore: integer("novelty_score"),
    shouldSend: boolean("should_send"),
    analysisReason: text("analysis_reason"),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true, mode: "date" }),
    mainEvent: text("main_event"),
    /** One-line "why this matters for the audience" (Phase 1). Nullable until analyzed. */
    whyItMatters: text("why_it_matters"),
    // Phase 3: multi-source confirmation (#10) — deterministic title
    // fingerprint + how many DISTINCT sources carry the same event.
    similarityKey: text("similarity_key"),
    corroborationCount: integer("corroboration_count").notNull().default(0),
    // Phase 3: two-stage grader (#9) — null | "confirmed" | "rejected".
    relevanceGrade: text("relevance_grade"),
    // Phase 3: entity extraction (#7) — Persian names of banks/companies/
    // institutions mentioned in the story (from the AI output).
    hashtags: text("hashtags"),
    entityTags: jsonb("entity_tags").$type<string[]>(),
    // Snapshot of which AI config version produced the current analysis.
    aiConfigVersion: integer("ai_config_version"),
  },
  (table) => [
    uniqueIndex("news_url_unique").on(table.url),
    index("news_published_at_idx").on(table.publishedAt),
    index("news_canonical_url_idx").on(table.canonicalUrl),
    index("news_external_id_idx").on(table.externalId),
    index("news_source_id_idx").on(table.sourceId),
    index("news_status_idx").on(table.status),
    index("news_created_at_idx").on(table.createdAt),
  ],
);

/**
 * Append-only AI analysis history (Milestone 6).
 *
 * Every analysis run (successful or failed) adds a row: historical analyses are
 * never overwritten, and each one records the configuration (id + version +
 * resolved model) that produced it for future evaluation/comparison.
 */
export const aiAnalyses = pgTable(
  "ai_analyses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    newsId: uuid("news_id")
      .notNull()
      .references(() => news.id, { onDelete: "cascade" }),
    // Plain uuid (no FK): configuration rows are append-only, but analyses must
    // survive any future cleanup of the configurations table.
    configurationId: uuid("configuration_id"),
    configurationVersion: integer("configuration_version"),
    model: text("model"),
    // "success" | "failed"
    status: text("status").notNull(),
    summary: text("summary"),
    category: text("category"),
    importance: integer("importance"),
    relevance: integer("relevance"),
    novelty: integer("novelty"),
    mainEvent: text("main_event"),
    whyItMatters: text("why_it_matters"),
    hashtags: text("hashtags"),
    entities: jsonb("entities").$type<string[]>(),
    shouldSend: boolean("should_send"),
    reason: text("reason"),
    errorMessage: text("error_message"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    shadowEvaluation: jsonb("shadow_evaluation").$type<import("../lib/ai/shadow-evaluation").ShadowEvaluation>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("ai_analyses_news_created_idx").on(table.newsId, table.createdAt)],
);

/**
 * Ingestion run log (Milestone 6).
 *
 * One row per fetch attempt (manual, due-sweep or legacy dashboard fetch with a
 * registered source). Explains why a source produced (or did not produce) news.
 */
export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id").references(() => newsSources.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    // "success" | "partial" | "failed"
    status: text("status").notNull(),
    itemsFound: integer("items_found").notNull().default(0),
    itemsCreated: integer("items_created").notNull().default(0),
    // Rows written with status SKIPPED_OFFTOPIC by the topic filter (subset of
    // rows inserted this run; kept separate so filter impact stays visible).
    itemsFiltered: integer("items_filtered").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("ingestion_runs_source_started_idx").on(table.sourceId, table.startedAt)],
);

/**
 * Delivery ledger — the publishing layer's foundation (Milestones 5 → 8).
 *
 * Milestone 8 extends this table in place rather than adding a parallel
 * `publishing` table: a row is either an OPEN CANDIDATE (status
 * "pending_approval"/"approved", content editable, nothing sent yet) or a
 * completed ATTEMPT record (legacy "sent"/"failed", or the outcome of a
 * candidate after a send). A news item therefore keeps its full append-only
 * delivery history.
 *
 * `destination` is "local" | "bale". Statuses are validated in the service layer
 * (src/lib/delivery/types.ts) — the DB stays a plain text column so existing
 * rows with "sent"/"failed" remain valid with zero migration.
 */
export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    newsId: uuid("news_id")
      .notNull()
      .references(() => news.id, { onDelete: "cascade" }),
    destination: text("destination").notNull(),
    status: text("status").notNull(),
    // Audit marker: what initiated this attempt ("manual" click or "auto" rule pass).
    triggeredBy: text("triggered_by").notNull().default("manual"),
    // The exact human-readable payload handed to the provider. Editable on an
    // open candidate; independent from the AI analysis text by design.
    message: text("message"),
    errorMessage: text("error_message"),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),

    // ── Milestone 8: controlled publishing ────────────────────────────────
    // Soft link (no FK) to the ai_analyses row whose content was published, so
    // delivery history survives analysis re-runs and cascade deletes.
    aiAnalysisId: uuid("ai_analysis_id"),
    // Provider-side id (Bale message_id). Its presence is the proof of success
    // used by the idempotency guard, so a second send cannot double-publish.
    providerMessageId: text("provider_message_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
    approvedBy: text("approved_by"),
    // Explicit admin override of the AI recommendation (never mutates the AI row).
    overrideRequested: boolean("override_requested").notNull().default(false),
    overrideReason: text("override_reason"),
    retryCount: integer("retry_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // Backs the duplicate-protection lookup (news + destination + status) and history reads.
    index("deliveries_news_destination_idx").on(table.newsId, table.destination, table.status),
    // At most ONE open candidate per (news, destination): makes candidate creation
    // idempotent under concurrency (a second insert is a no-op, not a duplicate).
    uniqueIndex("deliveries_open_candidate_unique")
      .on(table.newsId, table.destination)
      .where(sql`${table.status} IN ('pending_approval', 'approved')`),
  ],
);

/**
 * Delivery audit trail (Milestone 8).
 *
 * A deliberately small append-only event log (created/approved/rejected/edited/
 * override/send started/sent/failed/retry/cancelled). It exists because the
 * candidate row's `message` is mutable: without it, content edits and the order
 * of approval actions would be unrecoverable. No generic audit framework.
 */
export const deliveryEvents = pgTable(
  "delivery_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    // "created" | "approved" | "rejected" | "edited" | "override" |
    // "send_started" | "sent" | "failed" | "retry" | "cancelled"
    event: text("event").notNull(),
    detail: text("detail"),
    actor: text("actor"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("delivery_events_delivery_created_idx").on(table.deliveryId, table.createdAt)],
);

/**
 * AI Configuration Center (Milestone 5).
 *
 * Makes AI analysis behavior (prompt, model, features, decision guidance and
 * output schema) editable data instead of hard-coded application logic. Every
 * save inserts a new row (append-only version history); at most one row has
 * `isActive = true` at a time, enforced in the service layer (see
 * `src/lib/ai/config-service.ts`), not by a DB constraint, to keep this simple.
 */
export const aiConfigurations = pgTable(
  "ai_configurations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    provider: text("provider").notNull().default("openai-compatible"),
    // Empty string => defer to AI_API_MODEL / AI_MODEL env vars (backward compatible).
    model: text("model").notNull().default(""),
    systemPrompt: text("system_prompt").notNull(),
    audienceFocus: text("audience_focus"),
    temperature: real("temperature").notNull().default(0.2),
    maxTokens: integer("max_tokens").notNull().default(3000),
    // Record<AiFeatureKey, AiFeatureConfig> — see src/lib/ai/config-types.ts
    features: jsonb("features").notNull().$type<AiFeaturesConfig>(),
    // AiDecisionRules — guidance given to the AI for its own shouldSend recommendation.
    decisionRules: jsonb("decision_rules").notNull().$type<AiDecisionRules>(),
    // AiOutputSchema — configurable representation of the expected structured fields.
    outputSchema: jsonb("output_schema").notNull().$type<AiOutputSchema>(),
    // Milestone 8 — publishing format lives with the configuration version, so
    // template changes are versioned/auditable like prompt changes, and the
    // delivery row that used a template can be explained by the config snapshot.
    publishingTemplate: text("publishing_template").notNull().default(""),
    // Topic / relevance filter (pre-AI, cheap keyword rules). Versioned with the
    // configuration so topic changes are traceable. Null/absent on rows written
    // before the column existed — readers fall back to DEFAULT_TOPIC_FILTER.
    topicFilter: jsonb("topic_filter").$type<AiTopicFilterConfig | null>(),
    // Agent auto-delivery policy (dashboard override of AUTO_SEND_* env vars).
    // useCustom=false keeps the historical env-driven behavior.
    autoSendPolicy: jsonb("auto_send_policy").$type<AiAutoSendPolicy | null>(),
    isActive: boolean("is_active").notNull().default(false),
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("ai_configurations_active_idx").on(table.isActive),
    index("ai_configurations_version_idx").on(table.version),
  ],
);

/**
 * Scheduled automatic publishing (Agent). One row holds the whole schedule:
 * which local times trigger a "fetch → analyze → send" pass, where the pass
 * sends to, and how many items it may process. `last_run_slot` is the exact
 * `YYYY-MM-DDTHH:MM` (local) slot that already ran, so a delayed cron or a
 * restarted host can never send the same digest twice.
 */
export const agentSchedules = pgTable("agent_schedules", {
  id: uuid("id").defaultRandom().primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  timezone: text("timezone").notNull().default("Asia/Tehran"),
  // Array of "HH:MM" wall-clock strings, interpreted in `timezone`.
  times: jsonb("times").notNull().$type<string[]>().default(sql`'["08:00"]'::jsonb`),
  destination: text("destination").notNull().default("bale"),
  minImportance: integer("min_importance").notNull().default(50),
  minRelevance: integer("min_relevance").notNull().default(50),
  minNovelty: integer("min_novelty").notNull().default(0),
  requireAiRecommendation: boolean("require_ai_recommendation").notNull().default(false),
  maxAnalyze: integer("max_analyze").notNull().default(8),
  maxSend: integer("max_send").notNull().default(10),
  lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "date" }),
  lastRunSlot: text("last_run_slot"),
  lastResult: jsonb("last_result").$type<AgentRunSummary | null>(),
  // Targeted coverage-gap search (Phase 1): when a pass finds nothing to send,
  // search the web for the configured topic keywords and feed results through
  // the same gate. `lastGapSearchAt` implements the cooldown between searches.
  gapSearchEnabled: boolean("gap_search_enabled").notNull().default(false),
  gapSearchQueries: jsonb("gap_search_queries").notNull().$type<string[]>().default(sql`'[]'::jsonb`),
  lastGapSearchAt: timestamp("last_gap_search_at", { withTimezone: true, mode: "date" }),
  // Publishing format (Phase 2): "single" (current per-item messages),
  // "bulletin" (digest at fixed hours; everything waits), or "both".
  publishMode: text("publish_mode").notNull().default("single"),
  // Local HH:MM times the bulletin is published at (independent of `times`).
  bulletinTimes: jsonb("bulletin_times").notNull().$type<string[]>().default(sql`'["08:00","14:00"]'::jsonb`),
  lastBulletinSlot: text("last_bulletin_slot"),
  lastBulletinAt: timestamp("last_bulletin_at", { withTimezone: true, mode: "date" }),
  // Liveness heartbeat: stamped on EVERY external-cron tick call (even no-ops),
  // so the dashboard can show whether GitHub Actions is actually firing.
  lastTickAt: timestamp("last_tick_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/**
 * Short links for delivery messages (additive). One deterministic slug per
 * target URL; the public `/s/[slug]` route redirects and counts clicks. The
 * long source URL always stays on `news.url` — only the rendered message is
 * presented with the short form.
 */
export const shortLinks = pgTable(
  "short_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    url: text("url").notNull(),
    clickCount: integer("click_count").notNull().default(0),
    lastClickedAt: timestamp("last_clicked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("short_links_slug_unique").on(table.slug),
    uniqueIndex("short_links_url_unique").on(table.url),
  ],
);

export type ShortLinkRow = typeof shortLinks.$inferSelect;
export type NewShortLinkRow = typeof shortLinks.$inferInsert;

export type NewsRow = typeof news.$inferSelect;
export type NewNewsRow = typeof news.$inferInsert;
export type NewsSourceRow = typeof newsSources.$inferSelect;
export type NewNewsSourceRow = typeof newsSources.$inferInsert;
export type AiAnalysisRow = typeof aiAnalyses.$inferSelect;
export type IngestionRunRow = typeof ingestionRuns.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type NewDeliveryRow = typeof deliveries.$inferInsert;
export type DeliveryEventRow = typeof deliveryEvents.$inferSelect;
export type AiConfigurationRow = typeof aiConfigurations.$inferSelect;
export type NewAiConfigurationRow = typeof aiConfigurations.$inferInsert;
export type AgentScheduleRow = typeof agentSchedules.$inferSelect;
