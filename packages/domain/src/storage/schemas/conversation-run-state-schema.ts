import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects-schema";

/**
 * Conversation run-state table — the hook-fed channel carrying what a Claude
 * Code conversation is DOING right now, as opposed to what it SAID (which is
 * `agent_transcripts`).
 *
 * One row per conversation, upserted on every observed harness event. Keyed on
 * the harness-native conversation id, which is the `session_id` field present
 * on every hook payload and is the same value as
 * `agent_transcripts.agent_session_id` (mt#1313) and
 * `subagent_invocations.agent_session_id` (mt#1005). Type is plain `text` to
 * align with both, which deliberately do NOT use `uuid` for this id-space.
 *
 * ## Design: store raw harness signals, not collapsed classifications
 *
 * Every column below records what the harness actually reported —
 * `StopFailure`'s `error_type` verbatim, the `Notification` matcher verbatim,
 * `PreCompact`'s `trigger` verbatim. The mapping from these onto the
 * principal-facing vocabulary (`LIVE` / `NEEDS INPUT` / `Thinking…` /
 * `Rate-limited` / …) belongs to the render layer (mt#3130 Phase 3) so it stays
 * revisable without a migration. A column named for a vocabulary VALUE rather
 * than for its harness SOURCE would bake today's mapping into the schema.
 *
 * ## Design: this table asserts observations, never inferences
 *
 * mt#3130's cross-cutting finding is that a falsely-confident derived field is
 * worse than no field (Lee & See 2004). Two consequences visible here:
 *
 *  - There is **no `presence` column.** Presence is DERIVED at read time from
 *    the observations here plus absence-detection (mt#3130 Phase 2's sweep).
 *    A stored `presence = 'LIVE'` would be a claim no writer can retract when
 *    the process dies mid-tool-call — precisely the failure the umbrella's risk
 *    gate forbids.
 *  - `SessionEnd` is recorded as {@link conversationRunStateTable.endedHintAt},
 *    a HINT — never as an authoritative "ended". Per ADR-017 (and mt#2313,
 *    which tracks correcting the docs that still overclaim this), `/exit` and
 *    `/clear` do NOT fire `SessionEnd` (Claude Code issues #17885, #6428, both
 *    closed "not planned"), and a Cmd+W SIGHUP can kill the hook before it
 *    completes. Those are the CLEANEST ways to end a conversation. Treating
 *    this column as authoritative would leave every politely-exited
 *    conversation asserting a live-ish state forever.
 *
 * @see mt#3161 — this table (mt#3130 Phase 1)
 * @see mt#3130 — the conversation-view state-visibility umbrella + locked vocabulary
 * @see packages/domain/src/storage/schemas/presence-claims-schema.ts — the
 *      refresh-not-duplicate + stamp-project-on-write prior art this follows
 */
export const conversationRunStateTable = pgTable(
  "conversation_run_state",
  {
    // -------------------------------------------------------------------------
    // Identity
    // -------------------------------------------------------------------------

    /**
     * Harness-native conversation id (Claude Code's `session_id`). Primary key:
     * exactly one row per conversation, upserted rather than appended — the
     * same refresh-not-duplicate semantics `presence_claims` gets from its
     * unique index, expressed here as the PK because the natural key IS the
     * whole identity (there is no second dimension like `actor_id`).
     */
    conversationId: text("conversation_id").primaryKey(),

    // -------------------------------------------------------------------------
    // Last observed event (the liveness heartbeat)
    // -------------------------------------------------------------------------

    /** Harness `hook_event_name` of the most recent observed event. */
    lastEventName: text("last_event_name").notNull(),

    /**
     * When the most recent event was observed. This is the column an
     * absence-detection sweep reads to decide a conversation has gone quiet
     * (mt#3130 Phase 2) — the honest alternative to asserting an end.
     */
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),

    // -------------------------------------------------------------------------
    // Activity — what the agent is doing between prompt and stop
    // -------------------------------------------------------------------------

    /**
     * Coarse activity derived ONLY from which event last fired, never inferred:
     * `"thinking"` (UserPromptSubmit), `"running"` (PreToolUse), `"idle"`
     * (Stop). Null when no activity-bearing event has been observed yet.
     */
    activity: text("activity"),

    /** Tool name from the in-flight `PreToolUse`, cleared on `PostToolUse`. */
    toolName: text("tool_name"),

    /**
     * When the in-flight tool call started. The render layer needs this to show
     * elapsed time, which mt#3130's vocabulary makes MANDATORY rather than
     * optional — a bare indeterminate spinner is a measurably weaker signal
     * (Myers 1985).
     */
    toolStartedAt: timestamp("tool_started_at", { withTimezone: true }),

    /**
     * Harness `prompt_id` — the turn-grain correlation key carried on
     * `UserPromptSubmit` / `PreToolUse` / `PostToolUse`. Present on the
     * installed build (verified against 2.1.219). Lets activity be attributed
     * to a specific turn exactly, rather than reconstructed from timestamp
     * adjacency.
     */
    promptId: text("prompt_id"),

    // -------------------------------------------------------------------------
    // Needs-input — the harness-native source for the reason sub-label
    // -------------------------------------------------------------------------

    /**
     * Raw harness signal for why the conversation is waiting on a human: the
     * `Notification` matcher (`permission_prompt` / `idle_prompt` /
     * `agent_needs_input` / `agent_completed`) or `permission_request` for a
     * `PermissionRequest` event.
     *
     * mt#3130 decision (2) makes the `NEEDS INPUT` reason sub-label MANDATORY,
     * never optional. This column is what makes it sourceable rather than
     * inferred. Cleared when the conversation resumes.
     */
    needsInputReason: text("needs_input_reason"),

    /** Tool name that triggered a `PermissionRequest`, when applicable. */
    needsInputTool: text("needs_input_tool"),

    /** When the needs-input signal was observed. */
    needsInputAt: timestamp("needs_input_at", { withTimezone: true }),

    // -------------------------------------------------------------------------
    // Turn outcome — StopFailure
    // -------------------------------------------------------------------------

    /**
     * Raw `StopFailure.error_type`, stored verbatim. The harness documents ten
     * values (`rate_limit`, `overloaded`, `authentication_failed`,
     * `oauth_org_not_allowed`, `billing_error`, `invalid_request`,
     * `model_not_found`, `server_error`, `max_output_tokens`, `unknown`).
     * Deliberately NOT collapsed to the vocabulary's `Rate-limited` vs
     * `Errored` split — that mapping is the render layer's and must stay
     * revisable without a migration.
     */
    lastErrorType: text("last_error_type"),

    /** Raw `StopFailure.error_message`. */
    lastErrorMessage: text("last_error_message"),

    /** When the failing turn ended. */
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),

    // -------------------------------------------------------------------------
    // Context compaction
    // -------------------------------------------------------------------------

    /**
     * `PreCompact.trigger` — `"manual"` or `"auto"`.
     *
     * NOTE: the harness does NOT expose estimated token usage on this event.
     * mt#3130's build list claimed it did; that claim was checked against the
     * hooks reference and is false (the documented fields are `session_id`,
     * `transcript_path`, `cwd`, `hook_event_name`, `trigger`). Nothing may
     * render a compaction token estimate from this channel.
     */
    lastCompactionTrigger: text("last_compaction_trigger"),

    /** When compaction was last observed starting. */
    lastCompactionAt: timestamp("last_compaction_at", { withTimezone: true }),

    /** When compaction was last observed completing (`PostCompact`). */
    lastCompactionEndedAt: timestamp("last_compaction_ended_at", { withTimezone: true }),

    // -------------------------------------------------------------------------
    // End HINT — deliberately not authoritative (see the header)
    // -------------------------------------------------------------------------

    /**
     * When `SessionEnd` fired, if it fired at all. A HINT: its absence proves
     * nothing, because the cleanest exits (`/exit`, `/clear`) do not fire it.
     * Authoritative end/stall determination is absence-detection over
     * {@link conversationRunStateTable.lastEventAt} (mt#3130 Phase 2).
     */
    endedHintAt: timestamp("ended_hint_at", { withTimezone: true }),

    /** `SessionEnd.reason` (`clear` / `resume` / `logout` / `other` / …). */
    endedHintReason: text("ended_hint_reason"),

    // -------------------------------------------------------------------------
    // Where-context
    // -------------------------------------------------------------------------

    /** Working directory reported by the harness — resolves which project. */
    cwd: text("cwd"),

    /**
     * Project scoping, STAMPED ON WRITE rather than resolved at read time —
     * the mt#2563 lesson recorded in `presence-claims-schema.ts`. Nullable
     * because resolution can fail and ingest must never block on it.
     */
    projectId: uuid("project_id").references(() => projectsTable.id),

    // -------------------------------------------------------------------------
    // Audit
    // -------------------------------------------------------------------------

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    /**
     * The absence-detection sweep's scan (mt#3130 Phase 2): "which conversations
     * have not reported an event since T?". Indexed now, while the table is
     * empty, rather than after it has grown — `agent_transcripts` shipped
     * without its `started_at` index and paid for it in a full-table sort on
     * every poll (mt#2767).
     */
    index("idx_conversation_run_state_last_event_at").on(table.lastEventAt.desc()),

    /** Per-project fleet queries. */
    index("idx_conversation_run_state_project_id").on(table.projectId),
  ]
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type ConversationRunStateRecord = typeof conversationRunStateTable.$inferSelect;
export type ConversationRunStateInsert = typeof conversationRunStateTable.$inferInsert;
