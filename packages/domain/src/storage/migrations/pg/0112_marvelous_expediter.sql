-- drizzle-kit 0.31.2 emits a bare SET DATA TYPE for a non-enum->non-enum change and Postgres
-- rejects text->uuid without an explicit cast (no pg_cast entry exists either direction); the
-- USING clause below is hand-added post-generation per mem#1314 / mt#4668 (precedent:
-- 0013_slippery_grim_reaper.sql). Data verified clean pre-migration: 0 malformed, 0 orphaned.
ALTER TABLE "memories" ALTER COLUMN "project_id" SET DATA TYPE uuid USING "project_id"::uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;