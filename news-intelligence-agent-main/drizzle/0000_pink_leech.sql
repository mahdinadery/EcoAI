CREATE TABLE "ai_analyses" (
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'openai-compatible' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"system_prompt" text NOT NULL,
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
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
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
);
--> statement-breakpoint
CREATE TABLE "delivery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"event" text NOT NULL,
	"detail" text,
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
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
);
--> statement-breakpoint
CREATE TABLE "news" (
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
);
--> statement-breakpoint
CREATE TABLE "news_sources" (
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
);
--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_news_id_news_id_fk" FOREIGN KEY ("news_id") REFERENCES "public"."news"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_news_id_news_id_fk" FOREIGN KEY ("news_id") REFERENCES "public"."news"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_source_id_news_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."news_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news" ADD CONSTRAINT "news_source_id_news_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."news_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news" ADD CONSTRAINT "news_duplicate_of_id_news_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."news"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_analyses_news_created_idx" ON "ai_analyses" USING btree ("news_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_configurations_active_idx" ON "ai_configurations" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "ai_configurations_version_idx" ON "ai_configurations" USING btree ("version");--> statement-breakpoint
CREATE INDEX "deliveries_news_destination_idx" ON "deliveries" USING btree ("news_id","destination","status");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_open_candidate_unique" ON "deliveries" USING btree ("news_id","destination") WHERE "deliveries"."status" IN ('pending_approval', 'approved');--> statement-breakpoint
CREATE INDEX "delivery_events_delivery_created_idx" ON "delivery_events" USING btree ("delivery_id","created_at");--> statement-breakpoint
CREATE INDEX "ingestion_runs_source_started_idx" ON "ingestion_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "news_url_unique" ON "news" USING btree ("url");--> statement-breakpoint
CREATE INDEX "news_published_at_idx" ON "news" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "news_canonical_url_idx" ON "news" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "news_external_id_idx" ON "news" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "news_source_id_idx" ON "news" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "news_status_idx" ON "news" USING btree ("status");--> statement-breakpoint
CREATE INDEX "news_created_at_idx" ON "news" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "news_sources_active_idx" ON "news_sources" USING btree ("active");