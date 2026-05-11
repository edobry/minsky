-- Migration: add reviewer_webhook_events table (mt#1372)
-- Durable webhook-event persistence for forensic investigation of missed reviews.
-- See docs/incidents/reviewer-webhook-investigation.md for usage.
--> statement-breakpoint
CREATE TYPE "public"."webhook_outcome" AS ENUM(
	'received',
	'tier_resolved',
	'reviewer_called',
	'review_submitted',
	'skipped',
	'failed_at_signature',
	'failed_at_tier_resolve',
	'failed_at_reviewer'
);
--> statement-breakpoint
CREATE TABLE "reviewer_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"headers" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"outcome" "webhook_outcome" DEFAULT 'received' NOT NULL,
	"error_details" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "reviewer_webhook_events_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
CREATE INDEX "idx_rwe_delivery_id" ON "reviewer_webhook_events" USING btree ("delivery_id");
--> statement-breakpoint
CREATE INDEX "idx_rwe_received_at" ON "reviewer_webhook_events" USING btree ("received_at");
--> statement-breakpoint
CREATE INDEX "idx_rwe_outcome" ON "reviewer_webhook_events" USING btree ("outcome");
