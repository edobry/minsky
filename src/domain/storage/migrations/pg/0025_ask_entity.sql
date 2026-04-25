-- Ask entity (mt#1068): attention-allocation subsystem Wave 1 (mt#1034 ADR; renumbering mt#1291).
-- Primary table for the Ask domain entity. No embeddings (asks are routed, not searched semantically at v1).
-- Router (mt#1069), transports (mt#1070/mt#1072/mt#1180), and accounting rollups (mt#1071) consume this table.

-- Enum types (idempotent: Postgres lacks CREATE TYPE IF NOT EXISTS)
DO $$ BEGIN
	CREATE TYPE "public"."ask_kind" AS ENUM (
		'capability.escalate',
		'direction.decide',
		'quality.review',
		'authorization.approve',
		'information.retrieve',
		'coordination.notify',
		'stuck.unblock'
	);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."ask_state" AS ENUM (
		'pending',
		'routed',
		'suspended',
		'responded',
		'closed'
	);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- Primary asks table
CREATE TABLE IF NOT EXISTS "asks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" ask_kind NOT NULL,
	"classifier_version" text NOT NULL DEFAULT 'v1',
	"state" ask_state NOT NULL DEFAULT 'pending',
	"requestor" text NOT NULL,
	"routing_target" jsonb,
	"parent_task_id" text,
	"parent_session_id" text,
	"title" text NOT NULL,
	"question" text NOT NULL,
	"payload" jsonb NOT NULL,
	"response" jsonb,
	"metadata" jsonb,
	"deadline" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"routed_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint

-- BTree indexes (align with ask-schema.ts)
CREATE INDEX IF NOT EXISTS "idx_asks_state" ON "asks" ("state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_asks_parent_task_id" ON "asks" ("parent_task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_asks_parent_session_id" ON "asks" ("parent_session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_asks_kind_classifier" ON "asks" ("kind", "classifier_version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_asks_requestor" ON "asks" ("requestor");

-- Backout:
--   DROP INDEX IF EXISTS "idx_asks_requestor";
--   DROP INDEX IF EXISTS "idx_asks_kind_classifier";
--   DROP INDEX IF EXISTS "idx_asks_parent_session_id";
--   DROP INDEX IF EXISTS "idx_asks_parent_task_id";
--   DROP INDEX IF EXISTS "idx_asks_state";
--   DROP TABLE IF EXISTS "asks";
--   DROP TYPE IF EXISTS "public"."ask_state";
--   DROP TYPE IF EXISTS "public"."ask_kind";
