CREATE TABLE "task_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_task_id" text NOT NULL,
	"to_task_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks_embeddings" ADD COLUMN "status" "task_status";--> statement-breakpoint
ALTER TABLE "tasks_embeddings" ADD COLUMN "backend" "task_backend";--> statement-breakpoint
CREATE UNIQUE INDEX "tr_unique_edge" ON "task_relationships" USING btree ("from_task_id","to_task_id");--> statement-breakpoint
CREATE INDEX "tr_from_idx" ON "task_relationships" USING btree ("from_task_id");--> statement-breakpoint
CREATE INDEX "tr_to_idx" ON "task_relationships" USING btree ("to_task_id");