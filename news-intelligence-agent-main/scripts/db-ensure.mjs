#!/usr/bin/env node
/**
 * db-ensure — idempotent, ADDITIVE-ONLY schema sync.
 *
 * Root-cause fix for the admin dashboards ("خطا در بارگذاری فهرست منابع."):
 * this repository previously shipped no migrations at all, so any database
 * created before the Milestone 6+ tables/columns (news_sources, ingestion_runs,
 * ai_configurations.publishing_template, ...) was silently out of sync with
 * src/db/schema.ts and every admin API failed with an opaque 500.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npm run db:ensure
 *
 * Guarantees (per the project's operating rules):
 *   - NEVER drops or truncates anything
 *   - NEVER rewrites existing rows (only fills DEFAULTs on newly added columns)
 *   - safe to run any number of times, on fresh or drifted databases
 *
 * The authoritative baseline DDL is also kept in drizzle/ (drizzle-kit
 * generate) for fresh installs and future diffs; this script is the safe
 * repair tool for databases that already contain data.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoolOptions } from "../src/db/pool-config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env if present (no dependency on dotenv CLI behavior).
try {
  const envText = readFileSync(join(__dirname, "..", ".env"), "utf8");
  for (const line of envText.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // no .env — rely on the real environment
}

const databaseUrl = process.env.DATABASE_URL?.trim();

/** @type {Array<{ name: string, sql: string }>} */
const STEPS = [
  // ── Tables (full current shape — CREATE IF NOT EXISTS adds nothing on drift) ──
  {
    name: "table news_sources",
    sql: `CREATE TABLE IF NOT EXISTS "news_sources" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "name" text NOT NULL,
      "type" text DEFAULT 'rss' NOT NULL,
      "url" text NOT NULL,
      "description" text,
      "category" text,
      "priority" integer DEFAULT 3 NOT NULL,
      "active" boolean DEFAULT true NOT NULL,
      "fetch_interval_minutes" integer DEFAULT 30 NOT NULL,
      "max_items_per_fetch" integer DEFAULT 50 NOT NULL,
      "last_success_at" timestamp with time zone,
      "last_attempt_at" timestamp with time zone,
      "last_error" text,
      "error_count" integer DEFAULT 0 NOT NULL,
      "total_fetched" integer DEFAULT 0 NOT NULL,
      "total_accepted" integer DEFAULT 0 NOT NULL,
      "total_duplicates" integer DEFAULT 0 NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
  },
  {
    name: "table news",
    sql: `CREATE TABLE IF NOT EXISTS "news" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "source_id" uuid,
      "source" text NOT NULL,
      "external_id" text,
      "title" text NOT NULL,
      "url" text NOT NULL,
      "canonical_url" text,
      "published_at" timestamp with time zone,
      "description" text,
      "content" text,
      "author" text,
      "image_url" text,
      "status" text DEFAULT 'READY_FOR_AI' NOT NULL,
      "normalized_title" text,
      "normalized_content" text,
      "duplicate_of_id" uuid,
      "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "summary" text,
      "category" text,
      "importance_score" integer,
      "relevance_score" integer,
      "novelty_score" integer,
      "should_send" boolean,
      "analysis_reason" text,
      "analyzed_at" timestamp with time zone,
      "main_event" text,
      "ai_config_version" integer
    )`,
  },
  {
    name: "table ai_analyses",
    sql: `CREATE TABLE IF NOT EXISTS "ai_analyses" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "news_id" uuid NOT NULL,
      "configuration_id" uuid,
      "configuration_version" integer,
      "model" text,
      "status" text NOT NULL,
      "summary" text,
      "category" text,
      "importance" integer,
      "relevance" integer,
      "novelty" integer,
      "main_event" text,
      "should_send" boolean,
      "reason" text,
      "error_message" text,
      "prompt_tokens" integer,
      "completion_tokens" integer,
      "total_tokens" integer,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
  },
  {
    name: "table ingestion_runs",
    sql: `CREATE TABLE IF NOT EXISTS "ingestion_runs" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "source_id" uuid,
      "started_at" timestamp with time zone NOT NULL,
      "completed_at" timestamp with time zone,
      "status" text NOT NULL,
      "items_found" integer DEFAULT 0 NOT NULL,
      "items_created" integer DEFAULT 0 NOT NULL,
      "items_filtered" integer DEFAULT 0 NOT NULL,
      "duplicates" integer DEFAULT 0 NOT NULL,
      "errors" integer DEFAULT 0 NOT NULL,
      "error_message" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
  },
  {
    name: "table deliveries",
    sql: `CREATE TABLE IF NOT EXISTS "deliveries" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "news_id" uuid NOT NULL,
      "destination" text NOT NULL,
      "status" text NOT NULL,
      "triggered_by" text DEFAULT 'manual' NOT NULL,
      "message" text,
      "error_message" text,
      "sent_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "ai_analysis_id" uuid,
      "provider_message_id" text,
      "approved_at" timestamp with time zone,
      "approved_by" text,
      "override_requested" boolean DEFAULT false NOT NULL,
      "override_reason" text,
      "retry_count" integer DEFAULT 0 NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
  },
  {
    name: "table delivery_events",
    sql: `CREATE TABLE IF NOT EXISTS "delivery_events" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "delivery_id" uuid NOT NULL,
      "event" text NOT NULL,
      "detail" text,
      "actor" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
  },
  {
    name: "table ai_configurations",
    sql: `CREATE TABLE IF NOT EXISTS "ai_configurations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "name" text NOT NULL,
      "provider" text DEFAULT 'openai-compatible' NOT NULL,
      "model" text DEFAULT '' NOT NULL,
      "system_prompt" text NOT NULL,
      "audience_focus" text,
      "temperature" real DEFAULT 0.2 NOT NULL,
      "max_tokens" integer DEFAULT 3000 NOT NULL,
      "features" jsonb NOT NULL,
      "decision_rules" jsonb NOT NULL,
      "output_schema" jsonb NOT NULL,
      "publishing_template" text DEFAULT '' NOT NULL,
      "topic_filter" jsonb,
      "auto_send_policy" jsonb,
      "is_active" boolean DEFAULT false NOT NULL,
      "version" integer NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
  },

  {
    name: "table agent_schedules",
    sql: `CREATE TABLE IF NOT EXISTS "agent_schedules" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "enabled" boolean DEFAULT false NOT NULL,
      "timezone" text DEFAULT 'Asia/Tehran' NOT NULL,
      "times" jsonb DEFAULT '["08:00"]'::jsonb NOT NULL,
      "destination" text DEFAULT 'bale' NOT NULL,
      "min_importance" integer DEFAULT 50 NOT NULL,
      "min_relevance" integer DEFAULT 50 NOT NULL,
      "min_novelty" integer DEFAULT 0 NOT NULL,
      "require_ai_recommendation" boolean DEFAULT false NOT NULL,
      "max_analyze" integer DEFAULT 8 NOT NULL,
      "max_send" integer DEFAULT 10 NOT NULL,
      "last_run_at" timestamp with time zone,
      "last_run_slot" text,
      "last_result" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
  },

  {
    name: "table short_links",
    sql: `CREATE TABLE IF NOT EXISTS "short_links" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "slug" text NOT NULL,
      "url" text NOT NULL,
      "click_count" integer DEFAULT 0 NOT NULL,
      "last_clicked_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
  },

  // ── Column repair for drifted tables (older milestone shapes) ────────────
  { name: "column news.external_id", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "external_id" text` },
  { name: "column news.canonical_url", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "canonical_url" text` },
  { name: "column news.normalized_title", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "normalized_title" text` },
  { name: "column news.normalized_content", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "normalized_content" text` },
  { name: "column news.duplicate_of_id", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "duplicate_of_id" uuid` },
  { name: "column news.summary", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "summary" text` },
  { name: "column news.category", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "category" text` },
  { name: "column news.importance_score", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "importance_score" integer` },
  { name: "column news.relevance_score", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "relevance_score" integer` },
  { name: "column news.novelty_score", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "novelty_score" integer` },
  { name: "column news.should_send", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "should_send" boolean` },
  { name: "column news.analysis_reason", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "analysis_reason" text` },
  { name: "column news.analyzed_at", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "analyzed_at" timestamp with time zone` },
  { name: "column news.main_event", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "main_event" text` },
  { name: "column news.ai_config_version", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "ai_config_version" integer` },
  { name: "column ingestion_runs.items_filtered", sql: `ALTER TABLE "ingestion_runs" ADD COLUMN IF NOT EXISTS "items_filtered" integer DEFAULT 0 NOT NULL` },
  { name: "column deliveries.ai_analysis_id", sql: `ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "ai_analysis_id" uuid` },
  { name: "column deliveries.provider_message_id", sql: `ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "provider_message_id" text` },
  { name: "column deliveries.approved_at", sql: `ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone` },
  { name: "column deliveries.approved_by", sql: `ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "approved_by" text` },
  { name: "column deliveries.override_requested", sql: `ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "override_requested" boolean DEFAULT false NOT NULL` },
  { name: "column deliveries.override_reason", sql: `ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "override_reason" text` },
  { name: "column deliveries.retry_count", sql: `ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "retry_count" integer DEFAULT 0 NOT NULL` },
  { name: "column deliveries.updated_at", sql: `ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL` },
  { name: "column ai_configurations.publishing_template", sql: `ALTER TABLE "ai_configurations" ADD COLUMN IF NOT EXISTS "publishing_template" text DEFAULT '' NOT NULL` },
  { name: "column ai_configurations.audience_focus", sql: `ALTER TABLE "ai_configurations" ADD COLUMN IF NOT EXISTS "audience_focus" text` },
  { name: "column news.why_it_matters", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "why_it_matters" text` },
  { name: "column news.similarity_key", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "similarity_key" text` },
  { name: "column news.corroboration_count", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "corroboration_count" integer DEFAULT 0 NOT NULL` },
  { name: "column news.relevance_grade", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "relevance_grade" text` },
  { name: "column news.hashtags", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "hashtags" text` },
  { name: "column ai_analyses.hashtags", sql: `ALTER TABLE "ai_analyses" ADD COLUMN IF NOT EXISTS "hashtags" text` },
  { name: "column news.entity_tags", sql: `ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "entity_tags" jsonb` },
  { name: "column ai_analyses.entities", sql: `ALTER TABLE "ai_analyses" ADD COLUMN IF NOT EXISTS "entities" jsonb` },
  { name: "column ai_analyses.why_it_matters", sql: `ALTER TABLE "ai_analyses" ADD COLUMN IF NOT EXISTS "why_it_matters" text` },
  { name: "column ai_analyses.prompt_tokens", sql: `ALTER TABLE "ai_analyses" ADD COLUMN IF NOT EXISTS "prompt_tokens" integer` },
  { name: "column ai_analyses.completion_tokens", sql: `ALTER TABLE "ai_analyses" ADD COLUMN IF NOT EXISTS "completion_tokens" integer` },
  { name: "column ai_analyses.shadow_evaluation", sql: `ALTER TABLE "ai_analyses" ADD COLUMN IF NOT EXISTS "shadow_evaluation" jsonb` },
  { name: "column ai_analyses.total_tokens", sql: `ALTER TABLE "ai_analyses" ADD COLUMN IF NOT EXISTS "total_tokens" integer` },
  { name: "column news_sources.last_item_count", sql: `ALTER TABLE "news_sources" ADD COLUMN IF NOT EXISTS "last_item_count" integer` },
  { name: "column news_sources.last_newest_published_at", sql: `ALTER TABLE "news_sources" ADD COLUMN IF NOT EXISTS "last_newest_published_at" timestamp with time zone` },
  { name: "column agent_schedules.gap_search_enabled", sql: `ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "gap_search_enabled" boolean DEFAULT false NOT NULL` },
  { name: "column agent_schedules.gap_search_queries", sql: `ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "gap_search_queries" jsonb DEFAULT '[]'::jsonb NOT NULL` },
  { name: "column agent_schedules.last_gap_search_at", sql: `ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "last_gap_search_at" timestamp with time zone` },
  { name: "column agent_schedules.publish_mode", sql: `ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "publish_mode" text DEFAULT 'single' NOT NULL` },
  { name: "column agent_schedules.bulletin_times", sql: `ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "bulletin_times" jsonb DEFAULT '["08:00","14:00"]'::jsonb NOT NULL` },
  { name: "column agent_schedules.last_bulletin_slot", sql: `ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "last_bulletin_slot" text` },
  { name: "column agent_schedules.last_bulletin_at", sql: `ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "last_bulletin_at" timestamp with time zone` },
  { name: "column agent_schedules.last_tick_at", sql: `ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "last_tick_at" timestamp with time zone` },
  { name: "column ai_configurations.topic_filter", sql: `ALTER TABLE "ai_configurations" ADD COLUMN IF NOT EXISTS "topic_filter" jsonb` },
  { name: "column ai_configurations.auto_send_policy", sql: `ALTER TABLE "ai_configurations" ADD COLUMN IF NOT EXISTS "auto_send_policy" jsonb` },
  { name: "column agent_schedules.max_analyze", sql: `ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "max_analyze" integer DEFAULT 8 NOT NULL` },
  { name: "column agent_schedules.max_send", sql: `ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "max_send" integer DEFAULT 10 NOT NULL` },
  { name: "column agent_schedules.last_run_slot", sql: `ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "last_run_slot" text` },
  { name: "column agent_schedules.last_result", sql: `ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "last_result" jsonb` },

  // ── Foreign keys (named exactly as drizzle-kit generates them) ───────────
  // Each block is failure-proof by design (M1):
  //   - existence is checked by constraint NAME *or* by the real relation
  //     identity (conrelid, confrelid, contype + key columns), so an equivalent
  //     FK that already exists under a different name is not added twice;
  //   - if the ADD CONSTRAINT itself fails on legacy/orphan rows, we WARN with
  //     the step + constraint name and the error reason, then CONTINUE — the
  //     sync must never abort halfway and orphan data is never touched.
  {
    name: "fk ai_analyses.news_id",
    sql: `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ai_analyses_news_id_news_id_fk'
          OR (
            contype = 'f'
            AND conrelid = 'ai_analyses'::regclass
            AND confrelid = 'news'::regclass
            AND conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'ai_analyses'::regclass AND a.attname = 'news_id' AND NOT a.attisdropped)]::smallint[]
            AND confkey = ARRAY[(SELECT b.attnum FROM pg_attribute b WHERE b.attrelid = 'news'::regclass AND b.attname = 'id' AND NOT b.attisdropped)]::smallint[]
          )
      ) THEN
        ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_news_id_news_id_fk"
          FOREIGN KEY ("news_id") REFERENCES "news"("id") ON DELETE cascade ON UPDATE no action;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'db-ensure step "fk ai_analyses.news_id": constraint "ai_analyses_news_id_news_id_fk" not created (%). Orphan rows are left untouched — fix them manually, then re-run db:ensure.', SQLERRM;
    END $$`,
  },
  {
    name: "fk deliveries.news_id",
    sql: `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'deliveries_news_id_news_id_fk'
          OR (
            contype = 'f'
            AND conrelid = 'deliveries'::regclass
            AND confrelid = 'news'::regclass
            AND conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'deliveries'::regclass AND a.attname = 'news_id' AND NOT a.attisdropped)]::smallint[]
            AND confkey = ARRAY[(SELECT b.attnum FROM pg_attribute b WHERE b.attrelid = 'news'::regclass AND b.attname = 'id' AND NOT b.attisdropped)]::smallint[]
          )
      ) THEN
        ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_news_id_news_id_fk"
          FOREIGN KEY ("news_id") REFERENCES "news"("id") ON DELETE cascade ON UPDATE no action;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'db-ensure step "fk deliveries.news_id": constraint "deliveries_news_id_news_id_fk" not created (%). Orphan rows are left untouched — fix them manually, then re-run db:ensure.', SQLERRM;
    END $$`,
  },
  {
    name: "fk delivery_events.delivery_id",
    sql: `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'delivery_events_delivery_id_deliveries_id_fk'
          OR (
            contype = 'f'
            AND conrelid = 'delivery_events'::regclass
            AND confrelid = 'deliveries'::regclass
            AND conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'delivery_events'::regclass AND a.attname = 'delivery_id' AND NOT a.attisdropped)]::smallint[]
            AND confkey = ARRAY[(SELECT b.attnum FROM pg_attribute b WHERE b.attrelid = 'deliveries'::regclass AND b.attname = 'id' AND NOT b.attisdropped)]::smallint[]
          )
      ) THEN
        ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_delivery_id_deliveries_id_fk"
          FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE cascade ON UPDATE no action;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'db-ensure step "fk delivery_events.delivery_id": constraint "delivery_events_delivery_id_deliveries_id_fk" not created (%). Orphan rows are left untouched — fix them manually, then re-run db:ensure.', SQLERRM;
    END $$`,
  },
  {
    name: "fk ingestion_runs.source_id",
    sql: `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ingestion_runs_source_id_news_sources_id_fk'
          OR (
            contype = 'f'
            AND conrelid = 'ingestion_runs'::regclass
            AND confrelid = 'news_sources'::regclass
            AND conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'ingestion_runs'::regclass AND a.attname = 'source_id' AND NOT a.attisdropped)]::smallint[]
            AND confkey = ARRAY[(SELECT b.attnum FROM pg_attribute b WHERE b.attrelid = 'news_sources'::regclass AND b.attname = 'id' AND NOT b.attisdropped)]::smallint[]
          )
      ) THEN
        ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_source_id_news_sources_id_fk"
          FOREIGN KEY ("source_id") REFERENCES "news_sources"("id") ON DELETE set null ON UPDATE no action;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'db-ensure step "fk ingestion_runs.source_id": constraint "ingestion_runs_source_id_news_sources_id_fk" not created (%). Orphan rows are left untouched — fix them manually, then re-run db:ensure.', SQLERRM;
    END $$`,
  },
  {
    name: "fk news.source_id",
    sql: `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'news_source_id_news_sources_id_fk'
          OR (
            contype = 'f'
            AND conrelid = 'news'::regclass
            AND confrelid = 'news_sources'::regclass
            AND conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'news'::regclass AND a.attname = 'source_id' AND NOT a.attisdropped)]::smallint[]
            AND confkey = ARRAY[(SELECT b.attnum FROM pg_attribute b WHERE b.attrelid = 'news_sources'::regclass AND b.attname = 'id' AND NOT b.attisdropped)]::smallint[]
          )
      ) THEN
        ALTER TABLE "news" ADD CONSTRAINT "news_source_id_news_sources_id_fk"
          FOREIGN KEY ("source_id") REFERENCES "news_sources"("id") ON DELETE set null ON UPDATE no action;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'db-ensure step "fk news.source_id": constraint "news_source_id_news_sources_id_fk" not created (%). Orphan rows are left untouched — fix them manually, then re-run db:ensure.', SQLERRM;
    END $$`,
  },
  {
    name: "fk news.duplicate_of_id",
    sql: `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'news_duplicate_of_id_news_id_fk'
          OR (
            contype = 'f'
            AND conrelid = 'news'::regclass
            AND confrelid = 'news'::regclass
            AND conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'news'::regclass AND a.attname = 'duplicate_of_id' AND NOT a.attisdropped)]::smallint[]
            AND confkey = ARRAY[(SELECT b.attnum FROM pg_attribute b WHERE b.attrelid = 'news'::regclass AND b.attname = 'id' AND NOT b.attisdropped)]::smallint[]
          )
      ) THEN
        ALTER TABLE "news" ADD CONSTRAINT "news_duplicate_of_id_news_id_fk"
          FOREIGN KEY ("duplicate_of_id") REFERENCES "news"("id") ON DELETE set null ON UPDATE no action;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'db-ensure step "fk news.duplicate_of_id": constraint "news_duplicate_of_id_news_id_fk" not created (%). Orphan rows are left untouched — fix them manually, then re-run db:ensure.', SQLERRM;
    END $$`,
  },

  // ── Indexes ─────────────────────────────────────────────────────────────
  { name: "index news_sources_active_idx", sql: `CREATE INDEX IF NOT EXISTS "news_sources_active_idx" ON "news_sources" ("active")` },
  // Unique URL index: if legacy rows violate uniqueness, WARN and CONTINUE
  // instead of aborting the sync (M2). Duplicate rows are never deleted or
  // rewritten here — clean them up manually, then re-run db:ensure.
  {
    name: "index news_url_unique",
    sql: `DO $$ BEGIN
      CREATE UNIQUE INDEX IF NOT EXISTS "news_url_unique" ON "news" ("url");
    EXCEPTION WHEN others THEN
      RAISE WARNING 'db-ensure step "index news_url_unique": unique index "news_url_unique" not created (%). Duplicate rows are left untouched — clean them up manually, then re-run db:ensure.', SQLERRM;
    END $$`,
  },
  { name: "index news_published_at_idx", sql: `CREATE INDEX IF NOT EXISTS "news_published_at_idx" ON "news" ("published_at")` },
  { name: "index news_canonical_url_idx", sql: `CREATE INDEX IF NOT EXISTS "news_canonical_url_idx" ON "news" ("canonical_url")` },
  { name: "index news_external_id_idx", sql: `CREATE INDEX IF NOT EXISTS "news_external_id_idx" ON "news" ("external_id")` },
  { name: "index news_source_id_idx", sql: `CREATE INDEX IF NOT EXISTS "news_source_id_idx" ON "news" ("source_id")` },
  { name: "index news_status_idx", sql: `CREATE INDEX IF NOT EXISTS "news_status_idx" ON "news" ("status")` },
  { name: "index news_created_at_idx", sql: `CREATE INDEX IF NOT EXISTS "news_created_at_idx" ON "news" ("created_at")` },
  { name: "index ai_analyses_news_created_idx", sql: `CREATE INDEX IF NOT EXISTS "ai_analyses_news_created_idx" ON "ai_analyses" ("news_id","created_at")` },
  { name: "index ingestion_runs_source_started_idx", sql: `CREATE INDEX IF NOT EXISTS "ingestion_runs_source_started_idx" ON "ingestion_runs" ("source_id","started_at")` },
  { name: "index deliveries_news_destination_idx", sql: `CREATE INDEX IF NOT EXISTS "deliveries_news_destination_idx" ON "deliveries" ("news_id","destination","status")` },
  { name: "index delivery_events_delivery_created_idx", sql: `CREATE INDEX IF NOT EXISTS "delivery_events_delivery_created_idx" ON "delivery_events" ("delivery_id","created_at")` },
  { name: "index ai_configurations_active_idx", sql: `CREATE INDEX IF NOT EXISTS "ai_configurations_active_idx" ON "ai_configurations" ("is_active")` },
  { name: "index ai_configurations_version_idx", sql: `CREATE INDEX IF NOT EXISTS "ai_configurations_version_idx" ON "ai_configurations" ("version")` },
  // Partial unique index: if legacy rows violate it, WARN instead of failing
  // the whole sync (data is never deleted or rewritten here).
  {
    name: "index deliveries_open_candidate_unique",
    sql: `DO $$ BEGIN
      CREATE UNIQUE INDEX IF NOT EXISTS "deliveries_open_candidate_unique"
        ON "deliveries" ("news_id","destination")
        WHERE "status" IN ('pending_approval', 'approved');
    EXCEPTION WHEN others THEN
      RAISE WARNING 'deliveries_open_candidate_unique not created (%). Clean up duplicate OPEN candidates manually, then re-run db:ensure.', SQLERRM;
    END $$`,
  },
  { name: "index short_links_slug_unique", sql: `CREATE UNIQUE INDEX IF NOT EXISTS "short_links_slug_unique" ON "short_links" ("slug")` },
  { name: "index short_links_url_unique", sql: `CREATE UNIQUE INDEX IF NOT EXISTS "short_links_url_unique" ON "short_links" ("url")` },
];

/** Only run when invoked directly (`node scripts/db-ensure.mjs`), not on import. */
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  if (!databaseUrl) {
    console.error("DATABASE_URL is required. Set it in the environment or in .env (see .env.example).");
    process.exit(1);
  }

  const { Pool } = await import("pg");
  // `hostaddr=` URL support is shared with the app pool (src/db/pool-config.ts).
  const pool = new Pool({ ...buildPoolOptions(databaseUrl), max: 1, connectionTimeoutMillis: 10_000 });

    try {
      const client = await pool.connect();
      // Surface the M1/M2 WARNING notices in the console (PG otherwise only
      // forwards them to the client); ordinary IF NOT EXISTS NOTICEs stay quiet.
      client.on("notice", (notice) => {
        if (String(notice?.severity ?? "WARNING").toUpperCase() === "WARNING") {
          console.warn(`db-ensure warning: ${notice.message}`);
        }
      });
      try {
        for (const step of STEPS) {
          try {
            await client.query(step.sql);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`step "${step.name}": ${detail}`);
          }
        }
      } finally {
        client.release();
      }

    console.log(`db-ensure: ${STEPS.length} schema statements executed successfully.`);
    console.log("Schema is now in sync with src/db/schema.ts (additive-only; no data was modified).");
  } catch (error) {
    console.error("db-ensure failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

export { STEPS };
