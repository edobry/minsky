ALTER TABLE "engprod_miner_runs" ADD COLUMN "mining_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "engprod_miner_runs" ADD COLUMN "collapse_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "engprod_miner_runs" ADD COLUMN "refinement_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "engprod_miner_runs" ADD COLUMN "llm_ms" integer DEFAULT 0 NOT NULL;