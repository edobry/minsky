import { pgTable, text, uuid, timestamp, jsonb, index, pgEnum } from "drizzle-orm/pg-core";

/**
 * System events table — unified event substrate for the cockpit activity feed.
 *
 * Persists actionable events emitted by the Minsky system (in-process) and
 * remote producers (adoption sweeper, reviewer service) via the `events.emit`
 * MCP tool. The table is append-only; no updates or deletes.
 *
 * v1 event types are deliberately narrow: only events where the operator
 * needs to know in order to take action. Informational events are added later
 * when a concrete operator workflow requires them.
 *
 * @see mt#2092 — Event log Phase 1a (this task)
 * @see RFC: https://www.notion.so/36a937f03cb481289df2ee5d2fa932d4
 */

/**
 * System event type enum.
 *
 * Write-scope is deliberately WIDER than the activity feed's default read-scope
 * (mt#2340). The feed defaults to the `actionable` category; the broader
 * `informational` types are persisted unconditionally so the Phase 2
 * attention-allocation noticer (mt#1034) has populated trajectory history to
 * consume when it lands, rather than starting cold. Which category a type
 * belongs to is read-side classification (see `eventCategory` below) — it is
 * NOT stored per-row, mirroring the RFC's "no `source` column; derive from the
 * type" decision.
 *
 * Actionability is a property of the TYPE, not the instance. Where a payload
 * subtype would change actionability (a failed vs. successful deploy), SPLIT
 * the event type rather than branching the classifier on payload — keeping the
 * `eventCategory` map a pure type→category lookup.
 */
export const SYSTEM_EVENT_TYPE_VALUES = [
  // --- actionable (mt#2092 / mt#2147) — operator must know to take action ---
  "ask.created",
  "task.auto_created",
  "pr.review_posted",
  "subagent.failed",
  "embeddings.provider_degraded",
  // mt#3228 (bidirectional principal channel) — an inbound Telegram message
  // was refused by the channel's allowlist. Actionable because an unauthorized
  // party attempting to drive the local swarm is something the operator must
  // see; its accepted sibling below is informational.
  "principal.message_rejected",
  // mt#3228 (PR #2324 R1) — carrying out an accepted message FAILED. Actionable
  // for the same reason the pre-action row is not sufficient on its own: "audit
  // before action" records what the channel was asked to do, and without this
  // the log never says whether it worked.
  "principal.message_failed",
  // mt#3595 — a severity ask could not page the principal. Actionable, and
  // deliberately NOT folded into `principal.message_failed`: that type is the
  // INBOUND channel's record (its documented payload carries updateId /
  // messageId from a Telegram update), whereas this is an OUTBOUND delivery
  // failure with an ask id. Sharing the type would make "the channel is broken
  // in the direction that pages me" unqueryable.
  //
  // Actionable is the whole point: this fires exactly when the mechanism that
  // exists to get the operator's attention has failed to get it, so its own
  // failure must not be informational — nobody would be reading.
  "ask.page_failed",
  // --- informational / trajectory (mt#2340) — discoverable on the operator's
  //     own schedule; primary consumer is the Phase 2 noticer ---
  "task.status_changed",
  "pr.merged",
  "subagent.completed",
  "session.started",
  // mt#2489 (plant board v2.1) — DB-resident domain events
  "memory.created",
  "ask.answered",
  // mt#2537 (plant board v2.1 — hard cross-process bridges) — informational,
  // each backed by a non-DB-resident source bridged into this table. See the
  // payload-shape doc block below for each type's non-stub invocation path
  // (CLAUDE.md "Invocation path required for event/poll mechanisms").
  "changeset.created",
  "hook.fired",
  "mcp.disconnect",
  "retrospective.fired",
  "deploy.build",
  "deploy.smoke",
  "deploy.live",
  "deploy.fail",
  "ask.policy_closed",
  // mt#2935 (commit-auth emission inversion) — a policy-covered authorization
  // action recorded as an audit EVENT instead of a per-action Ask. Emitted by
  // detection-time policy consults at authorization emit sites (v1:
  // `sessionCommit` in packages/domain/src/session/session-commands.ts) when
  // ADR-008 §Router policy coverage answers the action at the emit site — the
  // attention-cost ledger record (cost = 0, recorded) without occupying the
  // decision substrate.
  "authorization.policy_covered",
  // mt#2819 (bulk-mutation primitives) — the dry-run event doubles as the
  // durable token record the execute path validates against; the executed
  // event is the one-shot consumption marker. Append-only by design.
  "task.bulk_edit.dry_run",
  "task.bulk_edit.executed",
  // mt#3021 (Layer-1 defensive-gate shared override contract) — emitted
  // whenever a destructive-action guard (mass-deletion sanity gate on
  // session_commit; MERGE_HEAD/uncommitted-changes guard on session
  // delete/cleanup) was tripped AND an explicit override with a reason was
  // supplied to proceed anyway. Generic across every guard that consumes
  // `packages/domain/src/safety/destructive-override.ts` — the `guard`
  // payload field names which one fired (v1: "session-commit-mass-deletion",
  // "session-delete-git-state", "session-cleanup-git-state"; mt#3103-3106's
  // Layer-2 liveness gates are expected to add further `guard` values without
  // a schema change). Actionable: an operator should know a safety gate was
  // bypassed, in case the bypass turns out to have been wrong.
  "guard.overridden",
  // mt#3228 (bidirectional principal channel) — the principal sent the swarm a
  // message from their phone. Informational: they know they sent it, and the
  // channel agent's reply is the response they actually watch for. The
  // append-only row is what makes the inbound path auditable, restart-safe
  // (poll cursor), and replay-safe (idempotency token) at once.
  "principal.message_received",
  // mt#3228 (PR #2324 R3) — the inbound poller advanced its Telegram offset to
  // a given update id. Needed because the cursor must clear updates that
  // produce NO message row (an `edited_message`, a future update type this
  // version does not parse); deriving the cursor from message rows alone
  // re-fetches such an update forever and wedges the channel behind it.
  "principal.poll_advanced",
  // mt#4205 — `cockpit start` resolved a port conflict. Originally emitted
  // only when a wedged incumbent was terminated; mt#4800 widened it to every
  // conflict OUTCOME — a displacement, a REFUSAL to displace (the branch whose
  // silence hid the 2026-08-31 stale-build incident), or a displacement whose
  // re-bind failed — discriminated by the payload's `outcome` field (shapes
  // below). Actionable for the same reason as `guard.overridden`: a process
  // was force-terminated (or a start was turned away), and the operator should
  // be able to see that it happened and how often. A RISING count is the
  // signal that matters — each row means the port was contested, so a
  // recurrence is a wedge worth chasing rather than a recovery worth
  // celebrating.
  //
  // The FIRST daemon-lifecycle event type in this enum. Every other value is
  // emitted by an agent-driven action, which is exactly why the 2026-08-06
  // outage (mt#4154) could not be reconstructed from this table: a quiet window
  // meant "no agent was working", not "nothing happened to the daemon".
  "cockpit.port_displaced",
] as const;

/**
 * Payload shapes for the mt#2489 plant-board v2.1 event types. The table's
 * `payload` JSONB is loosely typed as `Record<string, unknown>`; these are the
 * concrete shapes the producers emit (see `system-event-emit.ts`):
 *
 *   - `memory.created` → `{ memoryId: string; memoryType: string; scope: string }`
 *       emitted by the `memory.create` command after the record is persisted.
 *   - `ask.answered`   → `{ askId: string; responder: string | null }`
 *       emitted by the `asks.respond` command after the Ask is answered + closed.
 *
 * Payload shapes for the mt#2537 plant-board v2.1 "hard bridge" event types
 * (each sourced from a non-DB-resident producer — see the cited emit site for
 * the concrete non-stub invocation path):
 *
 *   - `changeset.created` → `{ prNumber: number; taskId?: string; title?: string }`
 *       emitted from the `session_pr_create` seam
 *       (`packages/domain/src/session/session-pr-operations.ts`), mirroring the
 *       `pr.merged` emit in `session-merge-operations.ts` (mt#2487).
 *   - `hook.fired` → `{ hook: string; decision: "blocked" | "overridden"; subject?: string }`
 *       emitted from the shared `writeOutput()` deny path in
 *       `.claude/hooks/types.ts` (mt#2537). v1 covers `decision: "blocked"`
 *       only — "overridden" audit lines are per-hook free-text stdout writes
 *       with no shared choke point and are deferred (see PR body).
 *   - `mcp.disconnect` → `{ cause: string; serverName: string; uptimeMs?: number; processRole?: string }`
 *       emitted by a boot-time sweep of the disconnect-tracker JSONL
 *       (`src/mcp/disconnect-tracker.ts`) run from `src/mcp/server.ts`,
 *       HWM-gated by timestamp so repeated sweeps don't double-emit.
 *   - `retrospective.fired` → `{ note: string; taskId?: string }`
 *       emitted via the CLI path (`minsky events emit retrospective.fired`)
 *       from the `/retrospective` skill's structural-fix step.
 *   - `deploy.live` / `deploy.fail` → `{ phase: "live" | "fail"; service?: string; status: string }`
 *       emitted from the `deployment_wait-for-latest` observation path
 *       (`packages/domain/src/deployment/`, mapped by `mapDeploymentRecordToEvent`
 *       in `src/adapters/shared/commands/deployment.ts`) once the deployment
 *       reaches a terminal status.
 *   - `deploy.build` → `{ phase: "build"; service?: string; status: "BUILDING" }`
 *       (mt#2599) emitted from the SAME `deployment_wait-for-latest` execute
 *       handler via a `WaitForLatestOptions.onStatusObserved` progress
 *       callback (`makeDeployBuildObserver` in `deployment.ts`) threaded
 *       through `RailwayDeploymentAdapter.waitForLatestDeployment`
 *       (`packages/domain/src/deployment/railway/adapter.ts`), which invokes
 *       it on every observed poll — non-terminal statuses included. Fires
 *       once per wait call, on the first observed `BUILDING` status.
 *   - `deploy.smoke` → `{ phase: "smoke"; sha: string; status: "success" | "failure" }`
 *       (mt#2599) emitted by a periodic cockpit sweeper
 *       (`startDeploySmokeSweeper` in `src/cockpit/sweepers.ts`, delegating to
 *       `triggerDeploySmokeSweep` in `src/cockpit/deploy-smoke-sweep.ts`) that
 *       polls the GitHub Checks API for the `bundle-boot-smoke` check-run
 *       (CLAUDE.md `§Bundle-Boot Smoke Gate`) on the cockpit process's own
 *       deployed commit (`RAILWAY_GIT_COMMIT_SHA`). This is a poll, not a
 *       webhook — see that module's doc block for why (no webhook-receiver
 *       surface is in scope for this bridge; see mt#2599's hard boundary on
 *       `services/reviewer/**`).
 *   - `ask.policy_closed` → `{ askId: string; kind: string; citationSource: string;
 *       citationLines?: [number, number]; title: string }`
 *       (mt#2666) emitted by the `asks.create` command layer when the
 *       policy-first router closes an Ask at creation (phase-1 coverage,
 *       `routingTarget: "policy"`). Audit surfacing for the closure class
 *       that previously lived only in a `log.debug` nobody consumed — the
 *       c26eca0a incident (a disposition Ask silently policy-closed with an
 *       irrelevant citation) was indistinguishable from a missing record.
 *   - `authorization.policy_covered` → `{ action: string; citationSource: string;
 *       citationLines?: [number, number]; commitMessage?: string }`
 *       (mt#2935) emitted by detection-time policy consults at authorization
 *       emit sites (v1: `sessionCommit`) when standing policy covers the
 *       action — no Ask is created for the covered path. The suppressed-ask
 *       fallback contract: emit sites suppress the Ask ONLY when this event
 *       row actually persisted (tryEmit → true); otherwise they fall back to
 *       Ask creation so the action is never silently unrecorded.
 *
 * Payload shapes for the mt#2819 bulk-mutation event types (emitted by the
 * `tasks.bulk-edit` command; the dry-run row IS the token store the execute
 * path validates against — see `src/adapters/shared/commands/tasks/bulk-edit-command.ts`):
 *
 *   - `task.bulk_edit.dry_run`  → `{ token: string; count: number; ids: string[];
 *       edits: Record<string, string>; changeSet: Array<{ taskId, field, before, after }> }`
 *   - `task.bulk_edit.executed` → `{ token: string; count: number;
 *       outcomes: Array<{ taskId, field, outcome }> }`
 *
 * Payload shape for the mt#3021 shared destructive-override audit type:
 *
 * Payload shapes for the mt#4205 cockpit port-conflict type (widened by
 * mt#4800 — the type now records every way a port conflict ENDS, not only a
 * successful displacement; consumers discriminate on `outcome`):
 *
 *   - `cockpit.port_displaced` with `outcome: "displaced"` →
 *       `{ port: number; outcome: "displaced"; displacedPid: number;
 *       displacedCommand: string; forced: boolean }`
 *       `forced` is false on the automatic path (the incumbent answered
 *       nothing, so it was displaced without operator involvement) and true
 *       when the disposition said preserve and `--force` overrode it. Without
 *       it the row cannot tell a self-healed wedge from a manual kill, which is
 *       the distinction that makes a rising count meaningful.
 *       Emitted by `src/commands/cockpit/start-command.ts` AFTER the
 *       replacement server has successfully bound the port — not at the moment
 *       of the kill. The guard runs before this process initializes
 *       configuration or persistence, so an emit at the decision point resolves
 *       no provider and silently no-ops (mt#4154's evidence-loss shape).
 *   - `outcome: "refused"` →
 *       `{ port: number; outcome: "refused";
 *       refusal: "preserved-incumbent" | "unrecognized-holder";
 *       holderPid: number; holderCommand: string; reason?: string }`
 *       The start path found the port held and chose NOT to displace — either
 *       a recognized incumbent still answering `/api/health` (no `--force`;
 *       `reason` carries the disposition's own sentence) or a holder it could
 *       not attribute. Emitted BEFORE the refusing `process.exit(1)` and
 *       awaited with a 5s bound (a fire-and-forget dies with the process),
 *       initializing the provider on demand. mt#4800: the 2026-08-31 incident
 *       was a `preserved-incumbent` refusal loop that emitted nothing, so the
 *       stale build served silently for 25+ minutes.
 *   - `outcome: "displacement-failed"` →
 *       `{ port: number; outcome: "displacement-failed"; displacedPid: number;
 *       displacedCommand: string; forced: boolean }`
 *       The incumbent was killed and the re-bind still failed (the socket
 *       teardown race) — strictly worse than a refusal, recorded so the row is
 *       never mistaken for a successful recovery. Same pre-exit, bounded-await
 *       timing as `"refused"`.
 *       Rows predating mt#4800 carry no `outcome` field and are all
 *       displacement-shaped.
 *
 * Payload shape for the mt#3021 shared destructive-override audit type:
 *
 *   - `guard.overridden` → `{ guard: string; reason: string; [key: string]: unknown }`
 *       emitted by `recordDestructiveOverride`
 *       (`packages/domain/src/safety/destructive-override.ts`) whenever a
 *       caller supplies a valid override for a tripped destructive-action
 *       guard. `guard` names the specific guard (e.g.
 *       "session-commit-mass-deletion"); `reason` is the caller-supplied
 *       justification (never empty — see `isValidDestructiveOverride`);
 *       additional guard-specific fields (e.g. `deletionCount`, `reasonCode`,
 *       `sessionId`) are merged in verbatim by the calling guard.
 */

export type SystemEventType = (typeof SYSTEM_EVENT_TYPE_VALUES)[number];

export const systemEventTypeEnum = pgEnum("system_event_type", SYSTEM_EVENT_TYPE_VALUES);

// ---------------------------------------------------------------------------
// Event category — read-side classification (mt#2340)
// ---------------------------------------------------------------------------

/** Feed-filter categories. `actionable` is the activity feed's default view. */
export const EVENT_CATEGORY_VALUES = ["actionable", "informational"] as const;

export type EventCategory = (typeof EVENT_CATEGORY_VALUES)[number];

/**
 * The single source of truth mapping each event type to its category.
 *
 * `satisfies Record<SystemEventType, EventCategory>` gives compile-time
 * exhaustiveness: adding a value to `SYSTEM_EVENT_TYPE_VALUES` without a
 * category entry fails the typecheck. `enum-drift.test.ts` asserts the same
 * invariant at runtime as a second guard.
 *
 * Producers emit a TYPE; they never set a category. The category is resolved
 * read-side (query filter, cockpit feed) from this map.
 */
export const eventCategory = {
  "ask.created": "actionable",
  "task.auto_created": "actionable",
  "pr.review_posted": "actionable",
  "subagent.failed": "actionable",
  "embeddings.provider_degraded": "actionable",
  "task.status_changed": "informational",
  "pr.merged": "informational",
  "subagent.completed": "informational",
  "session.started": "informational",
  "memory.created": "informational",
  "ask.answered": "informational",
  "changeset.created": "informational",
  "hook.fired": "informational",
  "mcp.disconnect": "informational",
  "retrospective.fired": "informational",
  "deploy.build": "informational",
  "deploy.smoke": "informational",
  "deploy.live": "informational",
  "deploy.fail": "informational",
  "ask.policy_closed": "informational",
  "authorization.policy_covered": "informational",
  "task.bulk_edit.dry_run": "informational",
  "task.bulk_edit.executed": "informational",
  "guard.overridden": "actionable",
  "principal.message_rejected": "actionable",
  "principal.message_failed": "actionable",
  "ask.page_failed": "actionable",
  "principal.message_received": "informational",
  "principal.poll_advanced": "informational",
  "cockpit.port_displaced": "actionable",
} satisfies Record<SystemEventType, EventCategory>;

/** Return all event types belonging to a given category (for `WHERE IN` filters). */
export function eventTypesForCategory(category: EventCategory): SystemEventType[] {
  return SYSTEM_EVENT_TYPE_VALUES.filter((t) => eventCategory[t] === category);
}

/**
 * system_events table.
 *
 * Column groupings:
 *   - Identity: id, eventType
 *   - Payload: payload (JSONB)
 *   - Context: actor, relatedTaskId, relatedSessionId
 *   - Timestamp: createdAt
 */
export const systemEventsTable = pgTable(
  "system_events",
  {
    // -------------------------------------------------------------------------
    // Identity
    // -------------------------------------------------------------------------

    /** Surrogate primary key. */
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * Event type enum — exactly the values defined in SYSTEM_EVENT_TYPE_VALUES.
     * Enforced at DB level via pgEnum.
     */
    eventType: systemEventTypeEnum("event_type").notNull(),

    // -------------------------------------------------------------------------
    // Payload
    // -------------------------------------------------------------------------

    /**
     * Structured event payload — shape varies by event type.
     *
     * ask.created:                    { askId, kind, title, requestor, parentTaskId? }
     * task.auto_created:              { taskId, title, createdBy, sourceRule }
     * pr.review_posted:               { prUrl, prNumber, reviewer, state, taskId? }
     * subagent.failed:                { outcome, taskId, sessionId?, errorSummary? }
     * embeddings.provider_degraded:   { provider, errorCode, status, failureCount, degradedReason }
     * task.status_changed:            { taskId, previousStatus, newStatus }
     * pr.merged:                      { prUrl, prNumber, taskId? }
     * subagent.completed:             { agentType, taskId, outcome? }
     * session.started:                { sessionId, taskId? }
     * changeset.created:              { prNumber, taskId?, title? }
     * hook.fired:                     { hook, decision, subject? }
     * mcp.disconnect:                 { cause, serverName, uptimeMs?, processRole? }
     * retrospective.fired:            { note, taskId? }
     * deploy.build/live/fail:         { phase, service?, status }
     * deploy.smoke:                   { phase, sha, status }
     * principal.message_received:     { token, updateId, messageId, route, text?, sentAt? }
     * principal.message_rejected:     { token, updateId, messageId, route, rejectionReason, sentAt? }
     * principal.message_failed:       { token: "<base>:failed", updateId, messageId, route, failureDetail, text?, sentAt? }
     * principal.poll_advanced:        { token: "<base>:advanced", updateId, messageId: 0, route: "poll-advanced" }
     *   (mt#3228 — see PrincipalMessageEventPayload in ../../notify/principal-inbound.ts.
     *    `text` is deliberately absent on the rejected variant: an unauthorized
     *    chat must not be able to write attacker-chosen content into the feed.)
     */
    payload: jsonb("payload").notNull(),

    // -------------------------------------------------------------------------
    // Context
    // -------------------------------------------------------------------------

    /**
     * Who emitted the event, in `{kind}:{scope}:{id}` AgentId format or
     * a human-readable identifier (e.g., "adoption-sweeper", "operator").
     * Nullable — not all events have a known actor at emission time.
     */
    actor: text("actor"),

    /**
     * Related Minsky task ID (e.g. "mt#123"). Nullable — some events are
     * session-scoped or system-scoped without a specific task.
     */
    relatedTaskId: text("related_task_id"),

    /**
     * Related Minsky session ID. Nullable — some events are task-scoped or
     * system-scoped without a specific session.
     */
    relatedSessionId: text("related_session_id"),

    // -------------------------------------------------------------------------
    // Timestamp
    // -------------------------------------------------------------------------

    /** When the event was emitted. */
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Event type filtering (cockpit activity feed type filter)
    index("idx_system_events_event_type").on(table.eventType),

    // Chronological queries — DESC for most-recent-first reads
    index("idx_system_events_created_at").on(table.createdAt),

    // Related task lookup — partial index only on non-null values
    index("idx_system_events_related_task_id").on(table.relatedTaskId),
  ]
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type SystemEventRecord = typeof systemEventsTable.$inferSelect;
export type SystemEventInsert = typeof systemEventsTable.$inferInsert;

/** Domain-facing system event shape (timestamps as ISO-8601 strings). */
export interface SystemEvent {
  id: string;
  eventType: SystemEventType;
  payload: Record<string, unknown>;
  actor?: string;
  relatedTaskId?: string;
  relatedSessionId?: string;
  createdAt: string;
}

/** Input for creating a new system event. */
export interface SystemEventInput {
  eventType: SystemEventType;
  payload: Record<string, unknown>;
  actor?: string;
  relatedTaskId?: string;
  relatedSessionId?: string;
}
