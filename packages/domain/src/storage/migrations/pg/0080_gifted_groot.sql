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
	"llm_errors" integer DEFAULT 0 NOT NULL,
	"errored" boolean DEFAULT false NOT NULL
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
