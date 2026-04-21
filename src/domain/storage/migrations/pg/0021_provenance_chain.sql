-- Create provenance table for authorship provenance chain records
-- Every Minsky-managed artifact (commit, PR, review) gets an associated provenance
-- record linking it to its task, session, and authorship signals.
CREATE TABLE IF NOT EXISTS "provenance" (
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
CREATE INDEX IF NOT EXISTS "idx_provenance_artifact" ON "provenance" ("artifact_id","artifact_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provenance_session" ON "provenance" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provenance_task" ON "provenance" ("task_id");
