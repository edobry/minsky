ALTER TABLE "review_timing" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "review_timing" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "review_timing" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "review_timing" ADD COLUMN "cost_usd" numeric(12, 6);