-- Add presence_claims table — task-grain (and future session/subagent-grain) agent presence signal.
-- mt#2562: "who is actively working on task mt#X right now" — independent of session.
--
-- Design decisions (locked 2026-06-26 after Step-4 architecture investigation):
-- - Grain-agnostic: subject_kind discriminates 'task' / 'session' / 'subagent'.
-- - UNIQUE(subject_kind, subject_id, actor_id): refresh-not-duplicate semantics.
-- - INDEX(subject_kind, subject_id): the "who is on mt#X?" read query.
-- - project_id FK to projects.id: stamped on write (mt#2563 lesson).
-- - All where-context columns nullable (cc_conversation_id, tty, host, session_id).
--
-- Backout: DROP TABLE IF EXISTS presence_claims;

CREATE TABLE IF NOT EXISTS "presence_claims" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "subject_kind" text NOT NULL,
    "subject_id" text NOT NULL,
    "actor_id" text NOT NULL,
    "cc_conversation_id" text,
    "tty" text,
    "host" text,
    "session_id" text,
    "project_id" uuid REFERENCES "projects"("id"),
    "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
    "last_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_presence_claims_subject_actor"
    ON "presence_claims" ("subject_kind", "subject_id", "actor_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_presence_claims_subject"
    ON "presence_claims" ("subject_kind", "subject_id");
