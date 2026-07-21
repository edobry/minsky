ALTER TABLE "asks" ADD COLUMN "short_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_asks_short_id_unique" ON "asks" USING btree ("short_id");