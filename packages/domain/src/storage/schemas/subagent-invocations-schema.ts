import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  boolean,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Subagent invocations table — persists execution history for subagent dispatches.
 *
 * Each row records one subagent invocation as dispatched by a parent agent session.
 * Captures dispatch parameters, timing, outcome, and workspace state at end of run.
 *
 * The `agentSessionId` column joins to `agent_transcripts.agent_session_id` (mt#1313)
 * and `agent_spawns.agent_session_id` (mt#1324). The type is plain `text` to align
 * with those tables (both use `text` for agent session IDs, not UUID).
 *
 * @see mt#1005 — Persist subagent execution history records linked to tasks
 * @see mt#1735 — Foundation subtask (schema + migration)
 * @see mt#1313 — Transcript search: harness-agnostic ingestion
 * @see mt#1324 — Foundation schema migration
 */

/**
 * Outcome enum — 8 values (6 workspace-derived classes per mt#1005, plus `pending` and
 * `no-workspace`).
 *
 * `pending` (mt#1770) is the DISPATCH-TIME placeholder, not a classification. Before it, a row
 * was seeded `crashed-no-output` as a "pessimistic default" — but that value reads as an
 * OBSERVATION to every consumer, so a row that simply had not been closed yet was
 * indistinguishable from a subagent that genuinely produced nothing.
 *
 * Measured harm before this shipped (2026-07-31): 6 of 19 dispatches in a 48h window carried
 * `crashed-no-output` while their tasks had actually shipped with commits, review rounds and a
 * merge (mt#3429, mt#3330, mt#3395, mt#3316, mt#3432, mt#3360); 145 of 179 rows had no
 * `ended_at` at all. `tasks_dispatch-recover`'s 2-attempt auto-resume bound was being consumed
 * by those phantom crashes — mt#2718 burned both attempts that way.
 *
 * `pending` is written ONLY at dispatch. The SubagentStop classifier overwrites it with a real
 * terminal class and must never emit it — see `../../subagent/workspace-classifier`. A row still
 * `pending` long after its dispatch means the row was never closed, which is a DIFFERENT and
 * separately-tracked problem (mt#2292, the writer half) from a subagent that crashed.
 *
 * `no-workspace` (mt#3894) is the OTHER non-workspace-derived value, and it is the opposite of
 * `pending` in the one way that matters: it records a PERMANENT absence, not a transient one.
 * Each of the six mt#1005 classes is a predicate over a workspace — commits, a dirty tree, a
 * `handoff.md`, a PR — but a raw harness `Agent` dispatch has no workspace at all
 * (`prompt-generation.ts` forbids `cd`, so its cwd is the MAIN repo). Classifying one against
 * that cwd describes the OPERATOR's checkout: all 3 such rows written between mt#2292 shipping
 * and this fix carried `partial-committed-handoff-written` plus main's HEAD in
 * `last_commit_hash`, for subagents that committed nothing.
 *
 * Reusing `pending` for that case was considered and rejected. `pending` means "no outcome
 * observed YET"; pushing a permanent fact into the placeholder for a transient one recreates the
 * one-value-two-meanings defect `pending` itself exists to remove, and moves the disambiguator
 * out of this column into `ended_at`, where every consumer reading `outcome` alone is misled
 * exactly as before.
 */
export const SUBAGENT_INVOCATION_OUTCOME_VALUES = [
  "completed-with-pr",
  "committed-no-pr",
  "partial-committed-handoff-written",
  "partial-uncommitted-no-handoff",
  "crashed-no-output",
  "rate-limited",
  "pending",
  "no-workspace",
] as const;

export type SubagentInvocationOutcome = (typeof SUBAGENT_INVOCATION_OUTCOME_VALUES)[number];

/**
 * The outcome classes the WORKSPACE classifier may produce — everything except `pending`
 * (mt#1770) and `no-workspace` (mt#3894).
 *
 * `pending` is written only at dispatch, by the dispatcher. A classifier runs at SubagentStop,
 * by which point an outcome HAS been observed; returning `pending` there would re-introduce
 * exactly the ambiguity this enum member exists to remove. Enforced by the type rather than by
 * convention, so a future edit to `classifyWorkspaceOutcome` cannot reintroduce it silently.
 *
 * `no-workspace` is excluded for the mirror-image reason: it is written by the SubagentStop hook
 * INSTEAD of calling the classifier, precisely because there is no workspace to inspect. Keeping
 * it out of this type means `classifyWorkspaceOutcome` cannot grow a branch that returns it from
 * a workspace inspection — the decision belongs at the call site, which is the only place that
 * knows whether a workspace exists.
 */
export type TerminalSubagentInvocationOutcome = Exclude<
  SubagentInvocationOutcome,
  "pending" | "no-workspace"
>;

/**
 * What the SubagentStop hook may record as an OBSERVED outcome (mt#3894): the workspace-derived
 * classes above, plus `no-workspace` for a subagent that had no workspace to derive them from.
 * Still excludes `pending`, which only the dispatcher writes.
 */
export type ObservedSubagentInvocationOutcome = Exclude<SubagentInvocationOutcome, "pending">;

export const subagentInvocationOutcomeEnum = pgEnum(
  "subagent_invocation_outcome",
  SUBAGENT_INVOCATION_OUTCOME_VALUES
);

/**
 * subagent_invocations table.
 *
 * Column groupings mirror the mt#1005 schema spec section:
 *   - Identity: id, taskId, sessionId, agentSessionId, parentSessionId, parentTaskId, subagentSessionId
 *   - Dispatch params: agentType, suggestedModel, actualModel
 *   - Timing: startedAt, endedAt, durationMs
 *   - Metrics: toolUseCount, totalTokens
 *   - Outcome: outcome, errorSummary, summary
 *   - Workspace state: prUrl, lastCommitHash, handoffWritten
 */
export const subagentInvocationsTable = pgTable(
  "subagent_invocations",
  {
    // -------------------------------------------------------------------------
    // Identity
    // -------------------------------------------------------------------------

    /** Surrogate primary key. */
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * Minsky task ID this invocation is associated with (e.g., "mt#1735").
     *
     * NOT NULL and deliberately unconstrained beyond that — no FK to `tasks`,
     * no CHECK, no format constraint (verified against the live schema
     * 2026-07-22: this table's only constraint is its primary key). Rows can
     * legitimately outlive or precede the task they name, so referential
     * integrity is intentionally not enforced here.
     *
     * Two writers, two shapes:
     *  - `tasks.dispatch` writes the real task id at dispatch time.
     *  - The SubagentStop hook writes `UNKNOWN_TASK_ID` ("unknown") when it
     *    could not resolve one (mt#3019). The tracker drops that sentinel on
     *    the UPDATE path so the dispatch-time value survives, so it only ever
     *    PERSISTS on an orphan INSERT — a Stop with no matching dispatch row.
     *    Same mechanism `agent_type` uses with `UNKNOWN_AGENT_TYPE` (mt#2653).
     *
     * Consumers query this column by equality against a real task id
     * (`getLatestInvocationForTask`, `getInvocationChainForTask`), so a
     * sentinel row simply never matches — which is the correct outcome for a
     * row that names no task. The sentinel cannot collide with a real id:
     * task ids are `<backend>#<number>` (`mt#3019`, `md#416`, `gh#491`).
     */
    taskId: text("task_id").notNull(),

    /** Minsky session ID of the parent/calling session. */
    sessionId: text("session_id"),

    /**
     * Harness-native agent session ID of the subagent.
     * Joins to agent_transcripts.agent_session_id and agent_spawns.agent_session_id.
     * Type is text (not UUID) to align with those tables.
     */
    agentSessionId: text("agent_session_id"),

    /** Minsky session ID of the parent agent. */
    parentSessionId: text("parent_session_id"),

    /** Minsky task ID of the parent agent (may differ from taskId for decomposed work). */
    parentTaskId: text("parent_task_id"),

    /** Minsky session ID assigned to the subagent's workspace. */
    subagentSessionId: text("subagent_session_id"),

    /**
     * Harness conversation id of the PARENT agent — the `session_id` field of
     * the `Agent` tool's PreToolUse payload (mt#2292).
     *
     * Distinct from `sessionId`/`parentSessionId` above, which are MINSKY
     * session ids. This one is the harness-native id, and it exists to pair
     * with {@link parentToolUseId}: the tool_use id is unique within a
     * conversation, not across the corpus, so it only identifies a dispatch
     * when scoped by the conversation that issued it.
     *
     * Nullable: every row written before mt#2292 has no such id, and there is
     * nothing to derive one from.
     */
    parentAgentSessionId: text("parent_agent_session_id"),

    /**
     * Harness-assigned `tool_use` id of the `Agent` call that spawned this
     * subagent (mt#2292) — the dispatch-side identity for rows written on the
     * raw harness spawn path.
     *
     * Deliberately the SAME key `agent_spawns.parent_tool_use_id` already uses
     * (`agent-spawns-pipeline.ts`), so the two tables are joinable rather than
     * each carrying its own private correlation id. That choice is why this is
     * not a token this hook mints: a bespoke id would have made
     * `subagent_invocations` unjoinable to the spawn edge that the cockpit
     * already renders.
     *
     * Nullable for the same reason as {@link parentAgentSessionId}, and
     * additionally for rows written by `session_generate_prompt` before the
     * dispatch that consumes them ever happens.
     */
    parentToolUseId: text("parent_tool_use_id"),

    // -------------------------------------------------------------------------
    // Dispatch params
    // -------------------------------------------------------------------------

    /** Agent type passed to session_generate_prompt (e.g., "refactorer", "auditor"). */
    agentType: text("agent_type").notNull(),

    /** Suggested model at dispatch time (e.g., "sonnet", "opus"). */
    suggestedModel: text("suggested_model"),

    /** Actual model the subagent ran on (recorded from transcript if available). */
    actualModel: text("actual_model"),

    // -------------------------------------------------------------------------
    // Timing
    // -------------------------------------------------------------------------

    /** When the subagent dispatch was initiated. */
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),

    /** When the subagent returned (or was declared timed out / crashed). */
    endedAt: timestamp("ended_at", { withTimezone: true }),

    /** Wall-clock duration in milliseconds (null when endedAt not yet recorded). */
    durationMs: integer("duration_ms"),

    // -------------------------------------------------------------------------
    // Metrics
    // -------------------------------------------------------------------------

    /** Number of tool calls the subagent made (from transcript if available). */
    toolUseCount: integer("tool_use_count"),

    /** Total token count for the subagent session (from transcript if available). */
    totalTokens: integer("total_tokens"),

    // -------------------------------------------------------------------------
    // Outcome
    // -------------------------------------------------------------------------

    /**
     * Outcome classification using the 6-class enum.
     * Exactly the 8 values defined in SUBAGENT_INVOCATION_OUTCOME_VALUES — 6 workspace-derived
     * classes, the dispatch-time `pending` placeholder (mt#1770), and `no-workspace` for a
     * subagent that had no workspace to derive a class from (mt#3894).
     */
    outcome: subagentInvocationOutcomeEnum("outcome").notNull(),

    /** Brief summary of any error that occurred, if applicable. */
    errorSummary: text("error_summary"),

    /** Narrative summary of what the subagent accomplished. */
    summary: text("summary"),

    // -------------------------------------------------------------------------
    // Workspace state
    // -------------------------------------------------------------------------

    /** URL of the PR created by the subagent, if any. */
    prUrl: text("pr_url"),

    /** Last git commit hash in the subagent's session workspace at end of run. */
    lastCommitHash: text("last_commit_hash"),

    /** Whether the subagent wrote a handoff.md file before exiting. */
    handoffWritten: boolean("handoff_written"),

    // -------------------------------------------------------------------------
    // Dispatch-recovery retry linkage (mt#2831)
    // -------------------------------------------------------------------------

    /**
     * The invocation this row RESUMES, when this row was produced by the
     * `tasks.dispatch-recover` command's auto-resume path. Null for an
     * original dispatch (attempt 1). No FK constraint (self-reference on a
     * table with no unique constraint on the natural retry-chain key) —
     * treated as an informational pointer, same posture as
     * `subagentSessionId`'s non-unique index.
     *
     * @see mt#2831 — dispatch auto-recovery (this column's origin)
     */
    resumedFromInvocationId: uuid("resumed_from_invocation_id"),

    /**
     * 1-indexed attempt number within a retry chain. 1 = the original
     * dispatch. 2 = the one auto-resume `tasks.dispatch-recover` is allowed
     * to produce. The recover command refuses to produce attempt 3 — the
     * 2-attempt bound is enforced by reading this column, not by an
     * agent-side loop counter.
     *
     * `NOT NULL DEFAULT 1` at the DB level (mt#2831 R1 NB #5) is the
     * AUTHORITATIVE source of "missing means 1" — migration
     * `0059_flippant_red_skull.sql` backfills every pre-existing row to 1 via
     * standard Postgres `ALTER TABLE ADD COLUMN ... DEFAULT` semantics, so no
     * row in a migrated database can ever read back `null`/`undefined` here.
     * Application-layer `?? 1` fallbacks in callers (e.g.
     * `dispatch-recover-command.ts`'s `latest.attemptNumber ?? 1`) are
     * therefore defensive belt-and-suspenders — guarding a non-Drizzle raw
     * read or a hand-built test fixture, not a real production gap — and are
     * intentionally kept rather than removed. See
     * `subagent-dispatch-tracker.test.ts`'s "defaults to 1 when omitted from
     * a hand-built row (no NOT NULL DEFAULT enforcement outside Postgres)"
     * test for the fake-store-level equivalent of the DB backfill guarantee.
     */
    attemptNumber: integer("attempt_number").notNull().default(1),
  },
  (table) => [
    // Primary lookup: all invocations for a given task
    index("idx_subagent_invocations_task_id").on(table.taskId),

    // Join to agent_transcripts / agent_spawns
    index("idx_subagent_invocations_agent_session_id").on(table.agentSessionId),

    // Chronological queries and time-range scans
    index("idx_subagent_invocations_started_at").on(table.startedAt),

    // Outcome-class aggregation and filtering
    index("idx_subagent_invocations_outcome").on(table.outcome),

    // Retry-chain lookups (mt#2831): find the resumed row for a given original
    index("idx_subagent_invocations_resumed_from").on(table.resumedFromInvocationId),

    // mt#2292: the dispatch-side natural key for rows written on the raw
    // harness `Agent` spawn path, and the Stop-side lookup target once the
    // stamped tool_use id is recovered from the child transcript.
    //
    // Composite and scoped by conversation for the same reason
    // `idx_agent_spawns_parent_tool_use_id` is: a tool_use id is unique WITHIN
    // a conversation, not across the corpus — the same id legitimately appears
    // in both a parent's and a child's transcript, because a dispatching Agent
    // call is replayed into the child's own transcript.
    //
    // UNIQUE is safe despite the 208 pre-existing rows that carry neither
    // column: Postgres permits unlimited NULLs under a unique index, so those
    // rows coexist without colliding (the same property agent_spawns relies on
    // for its own un-backfillable rows).
    uniqueIndex("idx_subagent_invocations_parent_tool_use_id").on(
      table.parentAgentSessionId,
      table.parentToolUseId
    ),
  ]
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type SubagentInvocationRecord = typeof subagentInvocationsTable.$inferSelect;
export type SubagentInvocationInsert = typeof subagentInvocationsTable.$inferInsert;
