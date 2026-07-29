ALTER TABLE "reviewer_findings" ADD COLUMN "natural_key" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rf_natural_key_unique" ON "reviewer_findings" USING btree ("natural_key");