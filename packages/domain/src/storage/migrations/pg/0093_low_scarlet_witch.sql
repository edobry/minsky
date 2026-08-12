--- Add guard_canary_runs — mt#4007.
---
--- `scripts/run-guard-canaries.ts` runs every declared guard canary and previously reported
--- pass/fail to stdout only; no history was kept, so a broken guard and a never-canary-tested
--- guard were indistinguishable, and "since when has this guard been broken?" was unanswerable
--- (the mt#2057 / mt#2835 incidents this closes — both dead guards went undetected for 7-9 days).
---
--- Append-only: every canary pass writes one fresh row per EVALUATED guard, sharing one run_id
--- (the "corpus baseline" — which guards were checked in a given pass). No upsert/unique
--- constraint on guard_name: two consecutive passing runs must leave two timestamped records,
--- not one row whose timestamp got bumped. A guard with no declared canary never gets a row here
--- at all — absence of history IS the never-verified state; see the schema's doc comment
--- (guard-canary-runs-schema.ts) for the full storage-choice rationale against ADR-027 and the
--- thin-hooks RFC.
---
--- Backout:
---   DROP TABLE "guard_canary_runs";
--- No data migration needed either direction — this is a new, additive table with no prior
--- consumers.
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
CREATE INDEX "idx_guard_canary_runs_guard_name_ran_at" ON "guard_canary_runs" USING btree ("guard_name","ran_at");--> statement-breakpoint
CREATE INDEX "idx_guard_canary_runs_run_id" ON "guard_canary_runs" USING btree ("run_id");