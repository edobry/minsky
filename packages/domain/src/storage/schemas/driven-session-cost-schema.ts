/**
 * Drizzle schema for driven_session_cost table (mt#2753, Rung 2D).
 *
 * Per-turn cost/usage persistence for driven sessions (mt#2750's daemon-side
 * host spawning the genuine `claude` binary). Reuses the reviewer-service
 * `review_timing` shape (mt#2288/mt#2721 — see
 * services/reviewer/src/db/schemas/review-timing-schema.ts) where sensible:
 * same nullable-token-columns-plus-numeric(12,6)-cost pattern, same
 * fire-and-forget write discipline (see
 * packages/domain/src/transcripts/driven-session-cost-writer.ts). Deliberately
 * NOT FK'd to `agent_transcripts`/`minsky_session_links` — a driven session's
 * cost record must persist independent of whether spawn-time link-writing
 * (mt#2752, task-bound sessions only) ran for this session; an untasked
 * "scratch" session has no `agent_transcripts` stub row to FK against. This
 * table is self-contained observability data, same as `review_timing`.
 *
 * One row per TURN, not per session: a driven session is multi-turn (the
 * child reads a continuous stream of user messages over stdin — see
 * ../../../../src/cockpit/driven-session-host.ts's module docblock), and each
 * turn emits its own terminal `result` event with its own cost/usage numbers.
 * `localId` + `turnIndex` together identify one row; summing/grouping by
 * `localId` (or `harnessSessionId`) yields the per-session total the mt#2753
 * spec's cockpit readout needs.
 *
 * Billing-premise note (2026-07-13, mt#2753 spec): the Agent SDK / `claude -p`
 * billing split that would have moved this spend onto a capped dollar credit
 * was PAUSED — `total_cost_usd`/`modelUsage[model].costUSD` are currently the
 * API-RATE EQUIVALENT of usage drawn from the operator's subscription at $0
 * marginal cost, not an amount actually billed. Kept for rate/consumption
 * observability and re-application readiness (see memory `2d6cdbaf`).
 *
 * @see mt#2753 — this module
 * @see mt#2750 — the driven-session host this table's data flows from
 * @see services/reviewer/src/db/schemas/review-timing-schema.ts — the reused shape
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const drivenSessionCostTable = pgTable(
  "driven_session_cost",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),

    // Session identity (mirrors DrivenSessionRecord in driven-session-host.ts).
    // localId is the daemon's spawn-time id — always present, the true owning
    // identity from spawn to exit. harnessSessionId is a secondary attribute
    // recorded once the child's system/init event yields it (always present
    // by the time a `result` event can fire, but kept nullable defensively —
    // mirrors the upstream event schema's documented thinness).
    localId: text("local_id").notNull(),
    harnessSessionId: text("harness_session_id"),
    taskId: text("task_id"),
    minskySessionId: text("minsky_session_id"),

    // 0-based ordinal of this result event within the session's lifetime.
    turnIndex: integer("turn_index").notNull().default(0),

    subtype: text("subtype"),
    isError: boolean("is_error").notNull().default(false),

    // mt#2753: per-turn cost/usage. Nullable — a malformed/absent field on the
    // upstream event yields NULL here rather than a synthesized zero (no
    // list-price estimation per the spec's "no estimation" success criterion).
    totalCostUsd: numeric("total_cost_usd", { precision: 12, scale: 6 }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),

    durationMs: integer("duration_ms"),
    durationApiMs: integer("duration_api_ms"),
    numTurns: integer("num_turns"),

    // Whole-tree per-model breakdown (the "model mix") — map of model name to
    // { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUsd }.
    modelUsage: jsonb("model_usage"),

    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    byLocalId: index("idx_dsc_local_id").on(table.localId),
    byHarnessSessionId: index("idx_dsc_harness_session_id").on(table.harnessSessionId),
    byTaskId: index("idx_dsc_task_id").on(table.taskId),
    byRecordedAt: index("idx_dsc_recorded_at").on(table.recordedAt),
  })
);

export type DrivenSessionCostRecord = typeof drivenSessionCostTable.$inferSelect;
export type DrivenSessionCostInsert = typeof drivenSessionCostTable.$inferInsert;
