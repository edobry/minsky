CREATE TABLE "entity_thread_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"local_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_threads" (
	"local_id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_ett_thread_seq_unique" ON "entity_thread_turns" USING btree ("local_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_et_entity" ON "entity_threads" USING btree ("entity_type","entity_id");