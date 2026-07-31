-- mt#1628: session-grain operator-interface binding (iTerm-tab binding v0).
-- Adds a nullable JSON-text column on `sessions` storing the correlator's
-- confirmed observation: { kind: "iterm-tab" | "unbound", surfaceId?, lastObservedAt }.
-- See the Design Decision note on SessionRecord.interfaceBinding in
-- packages/domain/src/session/types.ts for why this is a field here rather
-- than a separate InterfaceBinding table.
--
-- NOTE: this migration intentionally excludes an unrelated, pre-existing drizzle-kit
-- diff on `tasks.status` / the `task_status` enum (the same drift already noted in
-- 0056_session_attachment_extras.sql). That drift predates this task and is out of
-- scope here; it remains detectable by a future `bun run db:generate:pg` run against
-- a task that owns the enum cleanup.
--
-- Backout: ALTER TABLE sessions DROP COLUMN IF EXISTS "interface_binding";

ALTER TABLE "sessions" ADD COLUMN "interface_binding" text;
