CREATE TABLE "task_embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"dimension" integer NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
