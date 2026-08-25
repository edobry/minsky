CREATE TABLE "transcript_lines" (
	"agent_session_id" text NOT NULL,
	"line_ordinal" integer NOT NULL,
	"line" jsonb NOT NULL,
	"line_type" text NOT NULL,
	CONSTRAINT "transcript_lines_agent_session_id_line_ordinal_pk" PRIMARY KEY("agent_session_id","line_ordinal")
);
--> statement-breakpoint
ALTER TABLE "transcript_lines" ADD CONSTRAINT "transcript_lines_agent_session_id_agent_transcripts_agent_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_transcripts"("agent_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_transcript_lines_type" ON "transcript_lines" USING btree ("agent_session_id","line_type");