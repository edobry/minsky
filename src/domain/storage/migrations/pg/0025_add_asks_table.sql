-- Add asks table — unified domain entity for all human-in-the-loop mechanisms.
-- ADR-006 §The Ask entity.
--
-- Backout: DROP TABLE IF EXISTS asks;

CREATE TABLE IF NOT EXISTS "asks" (
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
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "chk_asks_kind" CHECK (kind IN ('capability.escalate', 'information.retrieve', 'authorization.approve', 'direction.decide', 'coordination.notify', 'quality.review', 'stuck.unblock')),
	CONSTRAINT "chk_asks_state" CHECK (state IN ('detected', 'classified', 'routed', 'suspended', 'responded', 'closed', 'cancelled', 'expired'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_asks_state_kind" ON "asks" ("state", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_asks_parent_task_id" ON "asks" ("parent_task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_asks_parent_session_id" ON "asks" ("parent_session_id");
