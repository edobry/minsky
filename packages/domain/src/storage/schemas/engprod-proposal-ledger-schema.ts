import { pgTable, text, integer, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Proposal ledger — the EngProd toil miner's curation-gate memory (mt#3330).
 *
 * One row per mined cluster signature (see `sequence-mining.ts`'s
 * `computeClusterSignature`). The signature is a stable hash of the
 * cluster's normalized tool-name sequence, so the SAME recurring toil
 * pattern always maps to the SAME row across runs — this is what makes
 * "don't re-propose a rejected cluster" and "re-surface once evidence
 * doubles" possible without re-deriving history from scratch each run.
 *
 * Verdict lifecycle (`verdict` column):
 * - `proposed`   — a BLOCKED task was filed for this cluster and is still
 *                  BLOCKED (awaiting principal triage).
 * - `accepted`   — the principal unblocked the filed task (moved it out of
 *                  BLOCKED) — per spec: "acceptance = unblocking."
 * - `rejected`   — the principal closed the filed task without unblocking
 *                  it, or explicitly rejected the cluster. Not re-proposed
 *                  unless `evidenceFrequency` at least doubles vs the
 *                  snapshot stored here (the "re-surface threshold").
 * - `superseded` — the cluster's proposal text matched an existing
 *                  human-authored task closely enough that filing a new
 *                  proposal would duplicate it (task-similarity dedupe).
 * - `suppressed` — the cluster passed the ledger + similarity dedupe checks
 *                  but was cut by the per-run budget cap (`suppressedReason`
 *                  = "budget-cap"). Recorded, never silently dropped.
 *
 * `verdict` and `suppressedReason` are plain `text()` columns (app-level
 * validated), matching this codebase's existing convention for small
 * lifecycle-status columns (e.g. `detector_dismissals`, `tasks.status`)
 * rather than a Postgres enum type — cheaper to extend across an additive
 * migration if a new verdict value is ever needed.
 *
 * @see mt#3330 — this table
 * @see packages/domain/src/engprod/ledger-service.ts — read/write API
 * @see packages/domain/src/engprod/sequence-mining.ts — signature derivation
 */
export const engprodProposalLedgerTable = pgTable("engprod_proposal_ledger", {
  /** Stable hash of the cluster's normalized tool-name sequence. Ledger key. */
  clusterSignature: text("cluster_signature").primaryKey(),

  /** proposed | accepted | rejected | superseded | suppressed */
  verdict: text("verdict").notNull().default("proposed"),

  /** Why a `rejected` or `suppressed` verdict was recorded. Null otherwise. */
  rejectionReason: text("rejection_reason"),

  /**
   * budget-cap | dedupe-similarity | non-maximal-subsequence |
   * low-distinctiveness — set only when suppressed. The last two are
   * additive mt#3429 values: `non-maximal-subsequence` (SC1) marks a
   * cluster whose tool sequence is a contiguous run of a higher-ranked,
   * still-surviving cluster; `low-distinctiveness` (SC2) marks a generic
   * name-level cluster excluded from the LLM stage for lacking a
   * concentrated arg_fingerprint sub-pattern. Both are plain text, like
   * every value here — no migration needed to add them.
   */
  suppressedReason: text("suppressed_reason"),

  /** Normalized tool-name sequence, e.g. ["Read", "Edit", "Bash"]. */
  toolSequence: jsonb("tool_sequence").notNull().$type<string[]>(),

  /** Occurrence count in the window that produced the CURRENT verdict. */
  evidenceFrequency: integer("evidence_frequency").notNull(),

  /** Distinct session count in the window that produced the CURRENT verdict. */
  evidenceSessions: integer("evidence_sessions").notNull(),

  /** Chain length (tool sequence length) — same as toolSequence.length, stored for cheap ranking reads. */
  evidenceChainLength: integer("evidence_chain_length").notNull(),

  /**
   * Full evidence snapshot for audit/debug: sample (sessionId, turnIndex)
   * refs, the mining window bounds, and the rank score at time of capture.
   * NOT re-derived from raw transcripts — only projection-table refs.
   */
  evidenceSnapshot: jsonb("evidence_snapshot").notNull().$type<Record<string, unknown>>(),

  /** Task id filed for this cluster, once proposed. Null until then. */
  filedTaskId: text("filed_task_id"),

  /** True once this signature has been proposed at least once. */
  everProposed: boolean("ever_proposed").notNull().default(false),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ProposalLedgerRow = typeof engprodProposalLedgerTable.$inferSelect;
export type ProposalLedgerInsert = typeof engprodProposalLedgerTable.$inferInsert;

/**
 * Per-run history for the EngProd toil miner (mt#3330).
 *
 * One row per ops-loop tick. Two purposes:
 * 1. Self-observability: the per-run counters the spec requires ("turns
 *    scanned, clusters found, clusters sent to LLM, proposals generated,
 *    suppressed-by-dedupe, suppressed-by-budget") are logged as structured
 *    events (see `toil-miner-tick.ts`) AND persisted here, so they survive
 *    process restarts and are queryable without a log search.
 * 2. Cross-run state for "two consecutive zero-cluster runs raise a loop
 *    error": the tick reads the immediately-preceding row from this table,
 *    which an in-memory counter cannot do across an ops-service restart.
 */
export const engprodMinerRunsTable = pgTable("engprod_miner_runs", {
  id: text("id").primaryKey(), // uuid, generated by the tick (crypto.randomUUID())

  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),

  turnsScanned: integer("turns_scanned").notNull(),
  clustersFound: integer("clusters_found").notNull(),
  clustersSentToLlm: integer("clusters_sent_to_llm").notNull(),
  proposalsGenerated: integer("proposals_generated").notNull(),
  suppressedByDedupe: integer("suppressed_by_dedupe").notNull(),
  suppressedByBudget: integer("suppressed_by_budget").notNull(),

  /** Number of stage-2 (LLM) calls that errored this run. >0 triggers a loop error. */
  llmErrors: integer("llm_errors").notNull().default(0),

  /** Whether this run ended in an error state (llmErrors > 0, or a hard mining failure). */
  errored: boolean("errored").notNull().default(false),
});

export type EngprodMinerRunRow = typeof engprodMinerRunsTable.$inferSelect;
export type EngprodMinerRunInsert = typeof engprodMinerRunsTable.$inferInsert;
