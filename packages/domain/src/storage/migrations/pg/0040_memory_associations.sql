ALTER TABLE "memories" ADD COLUMN "associations" jsonb DEFAULT '{}' NOT NULL;
CREATE INDEX "idx_memories_associations" ON "memories" USING gin ("associations");
