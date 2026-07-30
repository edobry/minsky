CREATE TABLE "agent_tool_call_projection" (
	"agent_session_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"tool_name" text NOT NULL,
	"server" text,
	"arg_fingerprint" text NOT NULL,
	"timestamp" timestamp with time zone,
	CONSTRAINT "agent_tool_call_projection_agent_session_id_turn_index_ordinal_pk" PRIMARY KEY("agent_session_id","turn_index","ordinal")
);
--> statement-breakpoint
ALTER TABLE "agent_tool_call_projection" ADD CONSTRAINT "agent_tool_call_projection_agent_session_id_agent_transcripts_agent_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_transcripts"("agent_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_tool_call_projection_timestamp" ON "agent_tool_call_projection" USING btree ("timestamp");