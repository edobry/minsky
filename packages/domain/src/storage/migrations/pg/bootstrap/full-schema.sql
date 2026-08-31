CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TYPE "public"."task_backend" AS ENUM('github-issues', 'github', 'minsky', 'db');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('TODO', 'PLANNING', 'READY', 'IN-PROGRESS', 'IN-REVIEW', 'DONE', 'BLOCKED', 'CLOSED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."subagent_invocation_outcome" AS ENUM('completed-with-pr', 'committed-no-pr', 'partial-committed-handoff-written', 'partial-uncommitted-no-handoff', 'crashed-no-output', 'rate-limited', 'pending', 'no-workspace');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('project', 'user', 'cross_project');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('user', 'feedback', 'project', 'reference');--> statement-breakpoint
CREATE TYPE "public"."system_event_type" AS ENUM('ask.created', 'task.auto_created', 'pr.review_posted', 'subagent.failed', 'embeddings.provider_degraded', 'principal.message_rejected', 'principal.message_failed', 'ask.page_failed', 'task.status_changed', 'pr.merged', 'subagent.completed', 'session.started', 'memory.created', 'ask.answered', 'changeset.created', 'hook.fired', 'mcp.disconnect', 'retrospective.fired', 'deploy.build', 'deploy.smoke', 'deploy.live', 'deploy.fail', 'ask.policy_closed', 'authorization.policy_covered', 'task.bulk_edit.dry_run', 'task.bulk_edit.executed', 'guard.overridden', 'principal.message_received', 'principal.poll_advanced', 'cockpit.port_displaced');--> statement-breakpoint
CREATE TYPE "public"."follow_up_status" AS ENUM('pending', 'fired', 'cancelled', 'failed');--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"repo_url" text,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
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
	"agent_id" text,
	"project_id" uuid,
	"interface_binding" text,
	"short_id" text
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
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"last_indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"project_id" uuid
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
CREATE TABLE "work_package_members" (
	"package_task_id" text NOT NULL,
	"member_task_id" text NOT NULL,
	"rank" integer NOT NULL,
	"status_at_write" text,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "work_package_members_package_task_id_member_task_id_pk" PRIMARY KEY("package_task_id","member_task_id")
);
--> statement-breakpoint
CREATE TABLE "work_package_transfers" (
	"package_task_id" text NOT NULL,
	"seq" integer NOT NULL,
	"origin" text NOT NULL,
	"by_conversation" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "work_package_transfers_package_task_id_seq_pk" PRIMARY KEY("package_task_id","seq")
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
	"title" text,
	"title_attempted_at" timestamp with time zone,
	"title_skip_reason" text,
	"related_task_ids" text[] DEFAULT '{}'::text[],
	"related_pr_numbers" text[] DEFAULT '{}'::text[],
	"last_ingested_jsonl_timestamp" timestamp with time zone,
	"divergent_tip_leaves" text[],
	"divergence_checked_at" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now(),
	"project_id" uuid,
	"ingest_failure_count" integer DEFAULT 0 NOT NULL,
	"ingest_last_error" text,
	"ingest_last_failed_at" timestamp with time zone,
	"ingest_quarantined_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_transcript_turns" (
	"agent_session_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"user_text" text,
	"user_origin" text,
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
CREATE TABLE "transcript_lines" (
	"agent_session_id" text NOT NULL,
	"line_ordinal" integer NOT NULL,
	"line" jsonb NOT NULL,
	"line_type" text NOT NULL,
	CONSTRAINT "transcript_lines_agent_session_id_line_ordinal_pk" PRIMARY KEY("agent_session_id","line_ordinal")
);
--> statement-breakpoint
CREATE TABLE "agent_spawns" (
	"parent_agent_session_id" text NOT NULL,
	"parent_turn_index" integer NOT NULL,
	"parent_tool_use_id" text,
	"child_agent_session_id" text,
	"spawn_type" text,
	"agent_kind" text,
	"spawned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_tool_call_projection" (
	"agent_session_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"tool_name" text NOT NULL,
	"server" text,
	"arg_fingerprint" text NOT NULL,
	"timestamp" timestamp with time zone,
	CONSTRAINT "agent_tool_call_projection_agent_session_id_turn_index_ordinal_pk" PRIMARY KEY("agent_session_id","turn_index","ordinal")
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
CREATE TABLE "driven_session_cost" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_id" text NOT NULL,
	"harness_session_id" text,
	"task_id" text,
	"minsky_session_id" text,
	"turn_index" integer DEFAULT 0 NOT NULL,
	"subtype" text,
	"is_error" boolean DEFAULT false NOT NULL,
	"total_cost_usd" numeric(12, 6),
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_creation_input_tokens" integer,
	"cache_read_input_tokens" integer,
	"duration_ms" integer,
	"duration_api_ms" integer,
	"num_turns" integer,
	"model_usage" jsonb,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driven_session_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "driven_session_conversations_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"local_id" text NOT NULL,
	"harness_session_id" text NOT NULL,
	"harness" text NOT NULL,
	"driver_generation" integer DEFAULT 0 NOT NULL,
	"adopted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"adoption_reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driven_sessions" (
	"local_id" text PRIMARY KEY NOT NULL,
	"harness_session_id" text,
	"cwd" text NOT NULL,
	"permission_mode" text NOT NULL,
	"task_id" text,
	"minsky_session_id" text,
	"model" text,
	"status" text NOT NULL,
	"unrecoverable_reason" text,
	"pid" integer,
	"pid_cmdline" text,
	"driver_generation" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_thread_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"local_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recovered_from_conversation_id" text,
	"originally_sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "entity_threads" (
	"local_id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaced_conversation_id" text,
	"replaced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "asks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_id" text,
	"kind" text NOT NULL,
	"classifier_version" text NOT NULL,
	"state" text NOT NULL,
	"requestor" text NOT NULL,
	"routing_target" text,
	"parent_task_id" text,
	"parent_session_id" text,
	"filed_by_agent_id" text,
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
	"severity" text,
	"principal_paged_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"project_id" uuid,
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
	"parent_agent_session_id" text,
	"parent_tool_use_id" text,
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
	"handoff_written" boolean,
	"resumed_from_invocation_id" uuid,
	"attempt_number" integer DEFAULT 1 NOT NULL
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
	"short_id" text,
	"type" "memory_type" NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"project_id" uuid,
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
	"parent_session_id" text,
	"agent_id" text,
	"ask_id" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"emitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drained_at" timestamp with time zone,
	"drained_for_tool" text,
	CONSTRAINT "wake_pending_addressable" CHECK ("wake_pending"."parent_session_id" IS NOT NULL OR "wake_pending"."agent_id" IS NOT NULL)
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
CREATE TABLE "presence_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"cc_conversation_id" text,
	"tty" text,
	"host" text,
	"session_id" text,
	"project_id" uuid,
	"pid" integer,
	"entrypoint" text,
	"terminal_context" jsonb,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "follow_up_status" DEFAULT 'pending' NOT NULL,
	"related_task_id" text,
	"related_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "task_supervision_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supervision_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"status" text DEFAULT 'dispatched' NOT NULL,
	"driven_session_local_id" text,
	"minsky_session_id" text,
	"settled_by" text,
	"last_error" text,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_supervisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"umbrella_task_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_filter" text NOT NULL,
	"wip_limit" integer DEFAULT 4 NOT NULL,
	"model" text,
	"events_watermark" timestamp with time zone,
	"last_tick_at" timestamp with time zone,
	"last_advance_at" timestamp with time zone,
	"last_hold_reason" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversation_run_state" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"last_event_name" text NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"activity" text,
	"tool_name" text,
	"tool_started_at" timestamp with time zone,
	"prompt_id" text,
	"needs_input_reason" text,
	"needs_input_tool" text,
	"needs_input_at" timestamp with time zone,
	"last_error_type" text,
	"last_error_message" text,
	"last_error_at" timestamp with time zone,
	"last_compaction_trigger" text,
	"last_compaction_at" timestamp with time zone,
	"last_compaction_ended_at" timestamp with time zone,
	"ended_hint_at" timestamp with time zone,
	"ended_hint_reason" text,
	"cwd" text,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engprod_miner_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"turns_scanned" integer NOT NULL,
	"clusters_found" integer NOT NULL,
	"clusters_sent_to_llm" integer NOT NULL,
	"proposals_generated" integer NOT NULL,
	"suppressed_by_dedupe" integer NOT NULL,
	"suppressed_by_budget" integer NOT NULL,
	"suppressed_by_maximal_collapse" integer DEFAULT 0 NOT NULL,
	"suppressed_by_low_distinctiveness" integer DEFAULT 0 NOT NULL,
	"llm_errors" integer DEFAULT 0 NOT NULL,
	"errored" boolean DEFAULT false NOT NULL,
	"mining_ms" integer DEFAULT 0 NOT NULL,
	"collapse_ms" integer DEFAULT 0 NOT NULL,
	"refinement_ms" integer DEFAULT 0 NOT NULL,
	"llm_ms" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engprod_proposal_ledger" (
	"cluster_signature" text PRIMARY KEY NOT NULL,
	"verdict" text DEFAULT 'proposed' NOT NULL,
	"rejection_reason" text,
	"suppressed_reason" text,
	"tool_sequence" jsonb NOT NULL,
	"evidence_frequency" integer NOT NULL,
	"evidence_sessions" integer NOT NULL,
	"evidence_chain_length" integer NOT NULL,
	"evidence_snapshot" jsonb NOT NULL,
	"filed_task_id" text,
	"ever_proposed" boolean DEFAULT false NOT NULL,
	"last_suppressed_at" timestamp with time zone,
	"suppression_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_channel_topics" (
	"local_id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"message_thread_id" integer NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guard_canary_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"guard_name" text NOT NULL,
	"source" text NOT NULL,
	"expects" text NOT NULL,
	"passed" boolean NOT NULL,
	"failure_detail" text,
	"ran_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cockpit_auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"passkey_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cockpit_auth_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "cockpit_passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" jsonb,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "cockpit_passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "guard_event_fire_log_rollup" (
	"guard_name" text PRIMARY KEY NOT NULL,
	"total_fires" integer DEFAULT 0 NOT NULL,
	"first_fire_at" timestamp with time zone,
	"last_fire_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guard_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stream" text NOT NULL,
	"family" text NOT NULL,
	"guard_name" text,
	"session_id" text,
	"project_id" uuid,
	"occurred_at" timestamp with time zone,
	"decision" text,
	"event" text,
	"duration_ms" integer,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"source_path" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cockpit_conversation_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"conversation_id" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	CONSTRAINT "cockpit_conversation_shares_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_package_members" ADD CONSTRAINT "work_package_members_package_task_id_tasks_id_fk" FOREIGN KEY ("package_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_package_transfers" ADD CONSTRAINT "work_package_transfers_package_task_id_tasks_id_fk" FOREIGN KEY ("package_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_transcripts" ADD CONSTRAINT "agent_transcripts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_transcript_turns" ADD CONSTRAINT "agent_transcript_turns_agent_session_id_agent_transcripts_agent_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_transcripts"("agent_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_lines" ADD CONSTRAINT "transcript_lines_agent_session_id_agent_transcripts_agent_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_transcripts"("agent_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_spawns" ADD CONSTRAINT "agent_spawns_parent_agent_session_id_agent_transcripts_agent_session_id_fk" FOREIGN KEY ("parent_agent_session_id") REFERENCES "public"."agent_transcripts"("agent_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_call_projection" ADD CONSTRAINT "agent_tool_call_projection_agent_session_id_agent_transcripts_agent_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_transcripts"("agent_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minsky_session_links" ADD CONSTRAINT "minsky_session_links_agent_session_id_agent_transcripts_agent_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_transcripts"("agent_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "fk_access_tokens_client_id" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "fk_auth_codes_client_id" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "fk_refresh_tokens_client_id" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_claims" ADD CONSTRAINT "presence_claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_supervision_dispatches" ADD CONSTRAINT "task_supervision_dispatches_supervision_id_task_supervisions_id_fk" FOREIGN KEY ("supervision_id") REFERENCES "public"."task_supervisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_run_state" ADD CONSTRAINT "conversation_run_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cockpit_auth_sessions" ADD CONSTRAINT "cockpit_auth_sessions_passkey_id_cockpit_passkeys_id_fk" FOREIGN KEY ("passkey_id") REFERENCES "public"."cockpit_passkeys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard_events" ADD CONSTRAINT "guard_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_projects_slug" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sessions_short_id_unique" ON "sessions" USING btree ("short_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_embeddings_hnsw" ON "tasks_embeddings" USING hnsw ("vector" vector_l2_ops);--> statement-breakpoint
CREATE INDEX "idx_rules_embeddings_hnsw" ON "rules_embeddings" USING hnsw ("vector" vector_l2_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "tr_unique_edge" ON "task_relationships" USING btree ("from_task_id","to_task_id","type");--> statement-breakpoint
CREATE INDEX "tr_from_idx" ON "task_relationships" USING btree ("from_task_id");--> statement-breakpoint
CREATE INDEX "tr_to_idx" ON "task_relationships" USING btree ("to_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tr_one_parent" ON "task_relationships" USING btree ("from_task_id") WHERE type = 'parent';--> statement-breakpoint
CREATE INDEX "work_package_members_member_task_id_idx" ON "work_package_members" USING btree ("member_task_id");--> statement-breakpoint
CREATE INDEX "idx_provenance_artifact" ON "provenance" USING btree ("artifact_id","artifact_type");--> statement-breakpoint
CREATE INDEX "idx_provenance_session" ON "provenance" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_provenance_task" ON "provenance" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_agent_transcripts_started_at" ON "agent_transcripts" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_agent_transcript_turns_fts" ON "agent_transcript_turns" USING gin ("fts_text");--> statement-breakpoint
CREATE INDEX "idx_agent_transcript_turns_embedding" ON "agent_transcript_turns" USING hnsw ("embedding" vector_l2_ops);--> statement-breakpoint
CREATE INDEX "idx_agent_transcript_turns_embedding_backlog" ON "agent_transcript_turns" USING btree ("agent_session_id","turn_index") WHERE "agent_transcript_turns"."embedding" IS NULL AND ("agent_transcript_turns"."user_text" IS NOT NULL OR "agent_transcript_turns"."assistant_text" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_transcript_lines_type" ON "transcript_lines" USING btree ("agent_session_id","line_type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_spawns_parent_tool_use_id" ON "agent_spawns" USING btree ("parent_agent_session_id","parent_tool_use_id");--> statement-breakpoint
CREATE INDEX "idx_agent_spawns_parent_turn" ON "agent_spawns" USING btree ("parent_agent_session_id","parent_turn_index");--> statement-breakpoint
CREATE INDEX "idx_agent_spawns_child_agent_session_id" ON "agent_spawns" USING btree ("child_agent_session_id");--> statement-breakpoint
CREATE INDEX "idx_agent_tool_call_projection_timestamp" ON "agent_tool_call_projection" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_minsky_session_links_minsky_session_id" ON "minsky_session_links" USING btree ("minsky_session_id");--> statement-breakpoint
CREATE INDEX "idx_dsc_local_id" ON "driven_session_cost" USING btree ("local_id");--> statement-breakpoint
CREATE INDEX "idx_dsc_harness_session_id" ON "driven_session_cost" USING btree ("harness_session_id");--> statement-breakpoint
CREATE INDEX "idx_dsc_task_id" ON "driven_session_cost" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_dsc_recorded_at" ON "driven_session_cost" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_dsconv_local_id" ON "driven_session_conversations" USING btree ("local_id");--> statement-breakpoint
CREATE INDEX "idx_dsconv_harness_session_id" ON "driven_session_conversations" USING btree ("harness_session_id");--> statement-breakpoint
CREATE INDEX "idx_ds_harness_session_id" ON "driven_sessions" USING btree ("harness_session_id");--> statement-breakpoint
CREATE INDEX "idx_ds_task_id" ON "driven_sessions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_ds_status" ON "driven_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ett_thread_seq_unique" ON "entity_thread_turns" USING btree ("local_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_et_entity" ON "entity_threads" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_asks_state_kind" ON "asks" USING btree ("state","kind");--> statement-breakpoint
CREATE INDEX "idx_asks_parent_task_id" ON "asks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "idx_asks_parent_session_id" ON "asks" USING btree ("parent_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_asks_short_id_unique" ON "asks" USING btree ("short_id");--> statement-breakpoint
CREATE INDEX "idx_pr_watches_pr" ON "pr_watches" USING btree ("pr_owner","pr_repo","pr_number");--> statement-breakpoint
CREATE INDEX "idx_pr_watches_triggered_at" ON "pr_watches" USING btree ("triggered_at");--> statement-breakpoint
CREATE INDEX "idx_pr_watches_parent_session" ON "pr_watches" USING btree ("parent_session_id") WHERE "pr_watches"."parent_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_subagent_invocations_task_id" ON "subagent_invocations" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_subagent_invocations_agent_session_id" ON "subagent_invocations" USING btree ("agent_session_id");--> statement-breakpoint
CREATE INDEX "idx_subagent_invocations_started_at" ON "subagent_invocations" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_subagent_invocations_outcome" ON "subagent_invocations" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "idx_subagent_invocations_resumed_from" ON "subagent_invocations" USING btree ("resumed_from_invocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_subagent_invocations_parent_tool_use_id" ON "subagent_invocations" USING btree ("parent_agent_session_id","parent_tool_use_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_embeddings_hnsw" ON "knowledge_embeddings" USING hnsw ("vector" vector_l2_ops);--> statement-breakpoint
CREATE INDEX "idx_memories_embeddings_hnsw" ON "memories_embeddings" USING hnsw ("vector" vector_l2_ops);--> statement-breakpoint
CREATE INDEX "idx_memories_type_scope_project" ON "memories" USING btree ("type","scope","project_id");--> statement-breakpoint
CREATE INDEX "idx_memories_created_at" ON "memories" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_memories_source_agent_id" ON "memories" USING btree ("source_agent_id");--> statement-breakpoint
CREATE INDEX "idx_memories_superseded_by" ON "memories" USING btree ("superseded_by");--> statement-breakpoint
CREATE INDEX "idx_memories_associations" ON "memories" USING gin ("associations");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memories_short_id_unique" ON "memories" USING btree ("short_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_access_tokens_expires_at" ON "oauth_access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_access_tokens_client_sub" ON "oauth_access_tokens" USING btree ("client_id","sub");--> statement-breakpoint
CREATE INDEX "idx_oauth_auth_codes_expires_at" ON "oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_auth_codes_client_sub" ON "oauth_authorization_codes" USING btree ("client_id","sub");--> statement-breakpoint
CREATE INDEX "idx_oauth_clients_name" ON "oauth_clients" USING btree ("client_name");--> statement-breakpoint
CREATE INDEX "idx_oauth_refresh_tokens_expires_at" ON "oauth_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_refresh_tokens_client_sub" ON "oauth_refresh_tokens" USING btree ("client_id","sub");--> statement-breakpoint
CREATE INDEX "idx_tool_embeddings_hnsw" ON "tool_embeddings" USING hnsw ("vector" vector_l2_ops);--> statement-breakpoint
CREATE INDEX "wake_pending_undelivered" ON "wake_pending" USING btree ("parent_session_id") WHERE "wake_pending"."drained_at" IS NULL;--> statement-breakpoint
CREATE INDEX "wake_pending_undelivered_by_agent" ON "wake_pending" USING btree ("agent_id") WHERE "wake_pending"."drained_at" IS NULL;--> statement-breakpoint
CREATE INDEX "wake_pending_delivered_by_ask" ON "wake_pending" USING btree ("ask_id","drained_at") WHERE "wake_pending"."drained_at" IS NOT NULL AND "wake_pending"."agent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_system_events_event_type" ON "system_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_system_events_created_at" ON "system_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_system_events_related_task_id" ON "system_events" USING btree ("related_task_id");--> statement-breakpoint
CREATE INDEX "idx_detector_dismissals_sig_repo" ON "detector_dismissals" USING btree ("signature","repo_url");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_presence_claims_subject_actor" ON "presence_claims" USING btree ("subject_kind","subject_id","actor_id");--> statement-breakpoint
CREATE INDEX "idx_presence_claims_subject" ON "presence_claims" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_follow_ups_status_due_at" ON "scheduled_follow_ups" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "idx_task_supervision_dispatches_supervision_status" ON "task_supervision_dispatches" USING btree ("supervision_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_task_supervision_dispatches_supervision_task" ON "task_supervision_dispatches" USING btree ("supervision_id","task_id");--> statement-breakpoint
CREATE INDEX "idx_task_supervisions_status" ON "task_supervisions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_task_supervisions_active_umbrella" ON "task_supervisions" USING btree ("umbrella_task_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_conversation_run_state_last_event_at" ON "conversation_run_state" USING btree ("last_event_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_conversation_run_state_project_id" ON "conversation_run_state" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tct_chat_thread" ON "telegram_channel_topics" USING btree ("chat_id","message_thread_id");--> statement-breakpoint
CREATE INDEX "idx_guard_canary_runs_guard_name_ran_at" ON "guard_canary_runs" USING btree ("guard_name","ran_at");--> statement-breakpoint
CREATE INDEX "idx_guard_canary_runs_run_id" ON "guard_canary_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_cockpit_auth_sessions_token_hash" ON "cockpit_auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_cockpit_auth_sessions_expires_at" ON "cockpit_auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_cockpit_passkeys_credential_id" ON "cockpit_passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_guard_events_dedupe_key" ON "guard_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_guard_events_guard_name_occurred_at" ON "guard_events" USING btree ("guard_name","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_guard_events_stream_occurred_at" ON "guard_events" USING btree ("stream","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_guard_events_project_id_occurred_at" ON "guard_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_conversation_shares_token_hash" ON "cockpit_conversation_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_conversation_shares_conversation" ON "cockpit_conversation_shares" USING btree ("conversation_id");