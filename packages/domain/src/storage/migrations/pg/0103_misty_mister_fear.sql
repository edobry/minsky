CREATE TABLE "driven_session_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "driven_session_conversations_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"local_id" text NOT NULL,
	"harness_session_id" text NOT NULL,
	"harness" text NOT NULL,
	"actuator_generation" integer DEFAULT 0 NOT NULL,
	"adopted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"adoption_reason" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_dsconv_local_id" ON "driven_session_conversations" USING btree ("local_id");--> statement-breakpoint
CREATE INDEX "idx_dsconv_harness_session_id" ON "driven_session_conversations" USING btree ("harness_session_id");