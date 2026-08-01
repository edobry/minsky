CREATE TABLE "telegram_channel_topics" (
	"local_id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"message_thread_id" integer NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_tct_chat_thread" ON "telegram_channel_topics" USING btree ("chat_id","message_thread_id");
