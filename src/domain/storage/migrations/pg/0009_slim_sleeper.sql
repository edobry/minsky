ALTER TYPE "public"."task_backend" ADD VALUE 'db';--> statement-breakpoint
CREATE TABLE "task_specs" (
	"task_id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"content_hash" text,
	"version" integer DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "tasks_embeddings" RENAME COLUMN "embedding" TO "vector";--> statement-breakpoint
ALTER TABLE "tasks_embeddings" RENAME COLUMN "last_indexed_at" TO "indexed_at";--> statement-breakpoint
DROP INDEX "idx_tasks_embeddings_hnsw";--> statement-breakpoint
ALTER TABLE "tasks_embeddings" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "task_specs" ADD CONSTRAINT "task_specs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_embeddings" ADD CONSTRAINT "tasks_embeddings_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tasks_embeddings_hnsw" ON "tasks_embeddings" USING hnsw ("vector" vector_l2_ops);--> statement-breakpoint
ALTER TABLE "tasks_embeddings" DROP COLUMN "dimension";--> statement-breakpoint
ALTER TABLE "tasks_embeddings" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "tasks_embeddings" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "spec";