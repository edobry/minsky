CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TYPE "public"."task_backend" AS ENUM('github-issues', 'github', 'minsky', 'db');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('TODO', 'PLANNING', 'READY', 'IN-PROGRESS', 'IN-REVIEW', 'DONE', 'BLOCKED', 'CLOSED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."subagent_invocation_outcome" AS ENUM('completed-with-pr', 'committed-no-pr', 'partial-committed-handoff-written', 'partial-uncommitted-no-handoff', 'crashed-no-output', 'rate-limited');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('project', 'user', 'cross_project');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('user', 'feedback', 'project', 'reference');--> statement-breakpoint
CREATE TYPE "public"."system_event_type" AS ENUM('ask.created', 'task.auto_created', 'pr.review_posted', 'subagent.failed', 'embeddings.provider_degraded', 'task.status_changed', 'pr.merged', 'subagent.completed', 'session.started');--> statement-breakpoint
CREATE TABLE "sessions" (
	"session" varchar(255) PRIMARY KEY NOT NULL,
	"repo_name" varchar(255) NOT NULL,
	"repo_url" varchar(1000) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"task_id" varchar(100),
	"pr_branch" varchar(255),
	"pr_approved" varchar(10),
	"pr_state" text,
	"backend_type" varchar(50),
	"pull_request" text,
	"last_activity_at" text,
	"last_commit_hash" text,
	"last_commit_message" text,
	"commit_count" integer,
	"status" text,
	"agent_id" text
);
--> statement-breakpoint
CREATE TABLE "deleted_task_ids" (
	"id" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_specs" (
	"task_id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"version" integer DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tasks_embeddings" (
	"task_id" text PRIMARY KEY NOT NULL,
	"vector" vector(1536),
	"metadata" jsonb,
	"content_hash" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"source_task_id" text,
	"backend" "task_backend",
	"status" "task_status",
	"title" text,
	"tags" text DEFAULT '[]',
	"kind" text DEFAULT 'implementation' NOT NULL,
	"last_indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "rules_embeddings" (
	"rule_id" text PRIMARY KEY NOT NULL,
	"vector" vector(1536),
	"metadata" jsonb,
	"content_hash" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "task_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_task_id" text NOT NULL,
	"to_task_id" text NOT NULL,
	"type" text DEFAULT 'depends' NOT NULL,
	CONSTRAINT "chk_task_relationships_type" CHECK (type IN ('depends', 'parent'))
);
--> statement-breakpoint
CREATE TABLE "provenance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" text NOT NULL,
	"artifact_type" text NOT NULL,
	"task_id" text,
	"session_id" text,
	"transcript_id" text,
	"task_origin" text,
	"spec_authorship" text,
	"initiation_mode" text,
	"human_messages" integer DEFAULT 0,
	"total_messages" integer DEFAULT 0,
	"corrections" integer DEFAULT 0,
	"participants" jsonb DEFAULT '[]'::jsonb,
	"substantive_human_input" text,
	"trajectory_changes" jsonb,
	"authorship_tier" integer,
	"tier_rationale" text,
	"policy_version" text DEFAULT '1.0.0',
	"judging_model" text,
	"computed_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agent_transcripts" (
	"agent_session_id" text PRIMARY KEY NOT NULL,
	"harness" text NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"model" text,
	"cwd" text,
	"project_dir" text,
	"transcript" jsonb,
	"summary" text,
	"summary_embedding" vector(1536),
	"related_task_ids" text[] DEFAULT '{}'::text[],
	"related_pr_numbers" text[] DEFAULT '{}'::text[],
	"last_ingested_jsonl_timestamp" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agent_transcript_turns" (
	"agent_session_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"user_text" text,
	"assistant_text" text,
	"tool_calls" jsonb,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"embedding" vector(1536),
	"fts_text" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(user_text, '') || ' ' || coalesce(assistant_text, ''))) STORED,
	"is_spawn_boundary" boolean DEFAULT false,
	CONSTRAINT "agent_transcript_turns_agent_session_id_turn_index_pk" PRIMARY KEY("agent_session_id","turn_index")
);
--> statement-breakpoint
CREATE TABLE "agent_spawns" (
	"parent_agent_session_id" text NOT NULL,
	"parent_turn_index" integer NOT NULL,
	"child_agent_session_id" text,
	"spawn_type" text,
	"agent_kind" text,
	"spawned_at" timestamp with time zone,
	CONSTRAINT "agent_spawns_parent_agent_session_id_parent_turn_index_pk" PRIMARY KEY("parent_agent_session_id","parent_turn_index")
);
--> statement-breakpoint
CREATE TABLE "minsky_session_links" (
	"agent_session_id" text NOT NULL,
	"minsky_session_id" text NOT NULL,
	"link_type" text NOT NULL,
	"confidence" real,
	"detected_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "minsky_session_links_agent_session_id_minsky_session_id_pk" PRIMARY KEY("agent_session_id","minsky_session_id")
);
--> statement-breakpoint
CREATE TABLE "asks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"classifier_version" text NOT NULL,
	"state" text NOT NULL,
	"requestor" text NOT NULL,
	"routing_target" text,
	"parent_task_id" text,
	"parent_session_id" text,
	"title" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb,
	"context_refs" jsonb,
	"response" jsonb,
	"deadline" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"routed_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"service_strategy" text,
	"window_key" text,
	"window_missed_count" integer DEFAULT 0,
	"force_immediate" boolean DEFAULT false,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "chk_asks_kind" CHECK (kind IN ('capability.escalate', 'information.retrieve', 'authorization.approve', 'direction.decide', 'coordination.notify', 'quality.review', 'stuck.unblock')),
	CONSTRAINT "chk_asks_state" CHECK (state IN ('detected', 'classified', 'routed', 'suspended', 'responded', 'closed', 'cancelled', 'expired')),
	CONSTRAINT "chk_asks_service_strategy" CHECK (service_strategy IS NULL OR service_strategy IN ('asap', 'scheduled', 'deadline-bound')),
	CONSTRAINT "chk_asks_window_key_strategy" CHECK (window_key IS NULL OR service_strategy = 'scheduled')
);
--> statement-breakpoint
CREATE TABLE "pr_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_owner" text NOT NULL,
	"pr_repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"event" text NOT NULL,
	"keep" boolean NOT NULL,
	"watcher_id" text NOT NULL,
	"parent_session_id" text,
	"last_seen" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"triggered_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "chk_pr_watches_event" CHECK (event IN ('merged', 'review-posted', 'check-status-changed'))
);
--> statement-breakpoint
CREATE TABLE "subagent_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"session_id" text,
	"agent_session_id" text,
	"parent_session_id" text,
	"parent_task_id" text,
	"subagent_session_id" text,
	"agent_type" text NOT NULL,
	"suggested_model" text,
	"actual_model" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"tool_use_count" integer,
	"total_tokens" integer,
	"outcome" "subagent_invocation_outcome" NOT NULL,
	"error_summary" text,
	"summary" text,
	"pr_url" text,
	"last_commit_hash" text,
	"handoff_written" boolean
);
--> statement-breakpoint
CREATE TABLE "knowledge_embeddings" (
	"document_id" text PRIMARY KEY NOT NULL,
	"vector" vector(1536),
	"metadata" jsonb,
	"content_hash" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "memories_embeddings" (
	"memory_id" text PRIMARY KEY NOT NULL,
	"vector" vector(1536),
	"metadata" jsonb,
	"content_hash" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "memory_type" NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"project_id" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"source_agent_id" text,
	"source_session_id" text,
	"confidence" real,
	"superseded_by" uuid,
	"metadata" jsonb,
	"associations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"sub" text NOT NULL,
	"scopes" text NOT NULL,
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"sub" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scopes" text NOT NULL,
	"audience" text,
	"code_challenge" text,
	"code_challenge_method" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_secret_hash" text,
	"client_name" text,
	"redirect_uris" text NOT NULL,
	"grant_types" text NOT NULL,
	"token_endpoint_auth_method" text NOT NULL,
	"registration_access_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"sub" text NOT NULL,
	"scopes" text NOT NULL,
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_hash" text,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_embeddings" (
	"tool_id" text PRIMARY KEY NOT NULL,
	"vector" vector(1536),
	"metadata" jsonb,
	"content_hash" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "wake_pending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_session_id" text NOT NULL,
	"ask_id" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"emitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drained_at" timestamp with time zone,
	"drained_for_tool" text
);
--> statement-breakpoint
CREATE TABLE "system_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" "system_event_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"actor" text,
	"related_task_id" text,
	"related_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "detector_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signature" text NOT NULL,
	"repo_url" text NOT NULL,
	"response" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_transcript_turns" ADD CONSTRAINT "agent_transcript_turns_agent_session_id_agent_transcripts_agent_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_transcripts"("agent_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_spawns" ADD CONSTRAINT "agent_spawns_parent_agent_session_id_agent_transcripts_agent_session_id_fk" FOREIGN KEY ("parent_agent_session_id") REFERENCES "public"."agent_transcripts"("agent_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minsky_session_links" ADD CONSTRAINT "minsky_session_links_agent_session_id_agent_transcripts_agent_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_transcripts"("agent_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "fk_access_tokens_client_id" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "fk_auth_codes_client_id" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "fk_refresh_tokens_client_id" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tasks_embeddings_hnsw" ON "tasks_embeddings" USING hnsw ("vector" vector_l2_ops);--> statement-breakpoint
CREATE INDEX "idx_rules_embeddings_hnsw" ON "rules_embeddings" USING hnsw ("vector" vector_l2_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "tr_unique_edge" ON "task_relationships" USING btree ("from_task_id","to_task_id","type");--> statement-breakpoint
CREATE INDEX "tr_from_idx" ON "task_relationships" USING btree ("from_task_id");--> statement-breakpoint
CREATE INDEX "tr_to_idx" ON "task_relationships" USING btree ("to_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tr_one_parent" ON "task_relationships" USING btree ("from_task_id") WHERE type = 'parent';--> statement-breakpoint
CREATE INDEX "idx_provenance_artifact" ON "provenance" USING btree ("artifact_id","artifact_type");--> statement-breakpoint
CREATE INDEX "idx_provenance_session" ON "provenance" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_provenance_task" ON "provenance" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_agent_transcript_turns_fts" ON "agent_transcript_turns" USING gin ("fts_text");--> statement-breakpoint
CREATE INDEX "idx_agent_transcript_turns_embedding" ON "agent_transcript_turns" USING hnsw ("embedding" vector_l2_ops);--> statement-breakpoint
CREATE INDEX "idx_asks_state_kind" ON "asks" USING btree ("state","kind");--> statement-breakpoint
CREATE INDEX "idx_asks_parent_task_id" ON "asks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "idx_asks_parent_session_id" ON "asks" USING btree ("parent_session_id");--> statement-breakpoint
CREATE INDEX "idx_pr_watches_pr" ON "pr_watches" USING btree ("pr_owner","pr_repo","pr_number");--> statement-breakpoint
CREATE INDEX "idx_pr_watches_triggered_at" ON "pr_watches" USING btree ("triggered_at");--> statement-breakpoint
CREATE INDEX "idx_pr_watches_parent_session" ON "pr_watches" USING btree ("parent_session_id") WHERE "pr_watches"."parent_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_subagent_invocations_task_id" ON "subagent_invocations" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_subagent_invocations_agent_session_id" ON "subagent_invocations" USING btree ("agent_session_id");--> statement-breakpoint
CREATE INDEX "idx_subagent_invocations_started_at" ON "subagent_invocations" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_subagent_invocations_outcome" ON "subagent_invocations" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "idx_knowledge_embeddings_hnsw" ON "knowledge_embeddings" USING hnsw ("vector" vector_l2_ops);--> statement-breakpoint
CREATE INDEX "idx_memories_embeddings_hnsw" ON "memories_embeddings" USING hnsw ("vector" vector_l2_ops);--> statement-breakpoint
CREATE INDEX "idx_memories_type_scope_project" ON "memories" USING btree ("type","scope","project_id");--> statement-breakpoint
CREATE INDEX "idx_memories_source_agent_id" ON "memories" USING btree ("source_agent_id");--> statement-breakpoint
CREATE INDEX "idx_memories_superseded_by" ON "memories" USING btree ("superseded_by");--> statement-breakpoint
CREATE INDEX "idx_memories_associations" ON "memories" USING gin ("associations");--> statement-breakpoint
CREATE INDEX "idx_oauth_access_tokens_expires_at" ON "oauth_access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_access_tokens_client_sub" ON "oauth_access_tokens" USING btree ("client_id","sub");--> statement-breakpoint
CREATE INDEX "idx_oauth_auth_codes_expires_at" ON "oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_auth_codes_client_sub" ON "oauth_authorization_codes" USING btree ("client_id","sub");--> statement-breakpoint
CREATE INDEX "idx_oauth_clients_name" ON "oauth_clients" USING btree ("client_name");--> statement-breakpoint
CREATE INDEX "idx_oauth_refresh_tokens_expires_at" ON "oauth_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_refresh_tokens_client_sub" ON "oauth_refresh_tokens" USING btree ("client_id","sub");--> statement-breakpoint
CREATE INDEX "idx_tool_embeddings_hnsw" ON "tool_embeddings" USING hnsw ("vector" vector_l2_ops);--> statement-breakpoint
CREATE INDEX "wake_pending_undelivered" ON "wake_pending" USING btree ("parent_session_id") WHERE "wake_pending"."drained_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_system_events_event_type" ON "system_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_system_events_created_at" ON "system_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_system_events_related_task_id" ON "system_events" USING btree ("related_task_id");--> statement-breakpoint
CREATE INDEX "idx_detector_dismissals_sig_repo" ON "detector_dismissals" USING btree ("signature","repo_url");