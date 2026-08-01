/**
 * Proposal ledger service (mt#3330) — the curation gate's memory.
 *
 * Read/write API over `engprod_proposal_ledger`, keyed on the deterministic
 * cluster signature (see `sequence-mining.ts`). Implements:
 *
 * - The FIRST dedupe stage ("ledger, exact signature" per spec SC5):
 *   `shouldPropose` decides whether a mined cluster is even worth sending
 *   to the LLM stage, based on its prior verdict.
 * - The re-surface threshold (SC2): a `rejected` cluster is not re-proposed
 *   unless its new frequency is at least double the evidence snapshot that
 *   was rejected.
 * - Verdict recording for the three post-LLM outcomes: proposed (task
 *   filed), superseded (matched an existing human task — the SECOND dedupe
 *   stage), suppressed (cut by the per-run budget cap).
 * - Reconciliation of "acceptance = unblocking" (spec SC3): a previously
 *   `proposed` cluster whose filed task moved out of BLOCKED is recorded
 *   `accepted`; one that was CLOSED without ever leaving BLOCKED is
 *   recorded `rejected`. Both are terminal within the ledger's own state
 *   machine — once set, a signature is not re-checked against its task
 *   again (matches the spec's literal "acceptance = unblocking," a
 *   one-time signal).
 */

import { injectable } from "tsyringe";
import { eq, desc, sql, inArray, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  engprodProposalLedgerTable,
  type ProposalLedgerRow,
} from "../storage/schemas/engprod-proposal-ledger-schema";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";
import type { MinedCluster } from "./types";

export type ProposalVerdict = "proposed" | "accepted" | "rejected" | "superseded" | "suppressed";

/**
 * ON CONFLICT set-expression that keeps the TARGET row's existing value when
 * that row has ever been proposed, and otherwise takes the incoming one
 * (mt#3510).
 *
 * Used by the suppression upsert for `verdict` and every column bound to it.
 * `column` is the drizzle column (drizzle renders it table-qualified, which
 * inside `ON CONFLICT DO UPDATE` resolves to the pre-update target row);
 * `excludedColumn` is that same column's snake_case DB name, needed because
 * `EXCLUDED.<name>` is raw SQL with no drizzle-side representation.
 *
 * The two arguments must name the SAME column — passing mismatched ones would
 * silently write one column's incoming value over another's existing value.
 * The resulting behavior of both suppression write paths is asserted against a
 * real Postgres in
 * `tests/integration/engprod-ledger-suppression-verdict.integration.test.ts`.
 */
function preserveWhenProposed(column: AnyPgColumn, excludedColumn: string): SQL {
  return sql`CASE WHEN ${engprodProposalLedgerTable.everProposed} THEN ${column} ELSE EXCLUDED.${sql.raw(excludedColumn)} END`;
}

export interface ShouldProposeDecision {
  propose: boolean;
  reason?: string;
}

/**
 * Pure decision function for the first dedupe stage (ledger, exact
 * signature). Extracted from `ProposalLedgerService.shouldPropose` so the
 * curation-gate DECISION logic is testable without a database — the only
 * inputs are the cluster's current evidence and its (possibly absent) prior
 * ledger row.
 */
export function decideShouldPropose(
  existing: ProposalLedgerRow | null,
  cluster: Pick<MinedCluster, "frequency">
): ShouldProposeDecision {
  if (!existing) return { propose: true };

  switch (existing.verdict) {
    case "accepted":
      return { propose: false, reason: "cluster already accepted (task unblocked)" };
    case "superseded":
      return { propose: false, reason: "cluster superseded by an existing task" };
    case "proposed":
      return { propose: false, reason: "cluster already proposed and pending triage" };
    case "suppressed":
      // Budget-cap suppression is mechanical, not a rejection of the idea —
      // always eligible to compete again on the next run.
      return { propose: true };
    case "rejected": {
      const doubleThreshold = existing.evidenceFrequency * 2;
      if (cluster.frequency >= doubleThreshold) return { propose: true };
      return {
        propose: false,
        reason: `re-surface threshold not met (need >= ${doubleThreshold}, have ${cluster.frequency})`,
      };
    }
    default:
      return { propose: true };
  }
}

export type ReconciliationDecision = "accepted" | "rejected" | "no-change";

/**
 * Pure decision function for ledger reconciliation ("acceptance =
 * unblocking", spec SC3). `status` is the filed task's CURRENT status, or
 * `undefined` if the task could not be found this run.
 */
export function decideReconciliation(status: string | undefined): ReconciliationDecision {
  if (status === undefined || status === "BLOCKED") return "no-change";
  if (status === "CLOSED") return "rejected";
  return "accepted";
}

@injectable()
export class ProposalLedgerService {
  constructor(private readonly db: PostgresJsDatabase) {}

  async getBySignature(signature: string): Promise<ProposalLedgerRow | null> {
    const rows = await this.db
      .select()
      .from(engprodProposalLedgerTable)
      .where(eq(engprodProposalLedgerTable.clusterSignature, signature))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * First dedupe stage (ledger, exact signature). Reads the cluster's
   * existing ledger row via `getBySignature` (one DB `select`); the actual
   * DECISION over that row is delegated to the pure, DB-free
   * `decideShouldPropose` function below (mt#3330 review R1 — the prior
   * version of this comment claimed "does NOT touch the database," which
   * was true only of the delegated decision logic, not of this method).
   */
  async shouldPropose(cluster: MinedCluster): Promise<ShouldProposeDecision> {
    const existing = await this.getBySignature(cluster.signature);
    return decideShouldPropose(existing, cluster);
  }

  private async upsert(
    cluster: MinedCluster,
    verdict: ProposalVerdict,
    extra: { rejectionReason?: string; suppressedReason?: string; filedTaskId?: string } = {}
  ): Promise<void> {
    const now = new Date();
    const isSuppression = verdict === "suppressed";
    await this.db
      .insert(engprodProposalLedgerTable)
      .values({
        clusterSignature: cluster.signature,
        verdict,
        rejectionReason: extra.rejectionReason ?? null,
        suppressedReason: extra.suppressedReason ?? null,
        toolSequence: cluster.toolSequence,
        evidenceFrequency: cluster.frequency,
        evidenceSessions: cluster.sessionCount,
        evidenceChainLength: cluster.chainLength,
        evidenceSnapshot: {
          sampleRefs: cluster.sampleRefs,
          score: cluster.score,
          capturedAt: now.toISOString(),
        },
        filedTaskId: extra.filedTaskId ?? null,
        everProposed: verdict === "proposed",
        lastSuppressedAt: isSuppression ? now : null,
        suppressionCount: isSuppression ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: engprodProposalLedgerTable.clusterSignature,
        set: {
          // mt#3510: `recordSuppressedByBudget` reaches this path with
          // verdict="suppressed", so it carries the SAME defect the batch
          // path did — a budget-cap suppression of an already-filed
          // signature would overwrite its verdict. Only the batched
          // collapse pass happened to fire in production; this path is the
          // sibling site, fixed in the same round rather than left for the
          // next incident. `proposed` and `superseded` are unaffected:
          // both are deliberate verdict transitions, not incidental
          // side-effects of a suppression sweep.
          verdict: isSuppression
            ? preserveWhenProposed(engprodProposalLedgerTable.verdict, "verdict")
            : verdict,
          rejectionReason: isSuppression
            ? preserveWhenProposed(engprodProposalLedgerTable.rejectionReason, "rejection_reason")
            : (extra.rejectionReason ?? null),
          suppressedReason: extra.suppressedReason ?? null,
          toolSequence: isSuppression
            ? preserveWhenProposed(engprodProposalLedgerTable.toolSequence, "tool_sequence")
            : cluster.toolSequence,
          evidenceFrequency: isSuppression
            ? preserveWhenProposed(
                engprodProposalLedgerTable.evidenceFrequency,
                "evidence_frequency"
              )
            : cluster.frequency,
          evidenceSessions: isSuppression
            ? preserveWhenProposed(engprodProposalLedgerTable.evidenceSessions, "evidence_sessions")
            : cluster.sessionCount,
          evidenceChainLength: isSuppression
            ? preserveWhenProposed(
                engprodProposalLedgerTable.evidenceChainLength,
                "evidence_chain_length"
              )
            : cluster.chainLength,
          evidenceSnapshot: isSuppression
            ? preserveWhenProposed(engprodProposalLedgerTable.evidenceSnapshot, "evidence_snapshot")
            : {
                sampleRefs: cluster.sampleRefs,
                score: cluster.score,
                capturedAt: now.toISOString(),
              },
          ...(isSuppression
            ? {
                lastSuppressedAt: now,
                suppressionCount: sql`${engprodProposalLedgerTable.suppressionCount} + 1`,
              }
            : {}),
          // Preserve the prior filedTaskId when this call doesn't supply one
          // (e.g. a suppressed/superseded verdict on a signature that was
          // previously proposed) — never clobber the audit trail.
          filedTaskId: extra.filedTaskId
            ? extra.filedTaskId
            : sql`${engprodProposalLedgerTable.filedTaskId}`,
          everProposed:
            verdict === "proposed" ? true : sql`${engprodProposalLedgerTable.everProposed}`,
          updatedAt: now,
        },
      });
  }

  async recordProposed(cluster: MinedCluster, filedTaskId: string): Promise<void> {
    await this.upsert(cluster, "proposed", { filedTaskId });
  }

  async recordSuperseded(cluster: MinedCluster, matchedTaskId: string): Promise<void> {
    await this.upsert(cluster, "superseded", {
      rejectionReason: `matched existing task ${matchedTaskId} (task-similarity dedupe)`,
      suppressedReason: "dedupe-similarity",
    });
  }

  async recordSuppressedByBudget(cluster: MinedCluster): Promise<void> {
    await this.upsert(cluster, "suppressed", { suppressedReason: "budget-cap" });
  }

  /**
   * mt#3429 SC1: record a cluster suppressed by maximal-sequence collapsing
   * — its tool sequence is a contiguous run of a higher-ranked, currently
   * surviving cluster (`supersededBySignature`), so it is the SAME
   * phenomenon at a coarser/finer grain, not a distinct one. Additive
   * `suppressedReason` value; no schema change (the column is free-text).
   */
  async recordSuppressedByMaximalCollapse(
    cluster: MinedCluster,
    supersededBySignature: string
  ): Promise<void> {
    await this.upsert(cluster, "suppressed", {
      suppressedReason: "non-maximal-subsequence",
      rejectionReason: `contiguous subsequence of higher-ranked cluster ${supersededBySignature}`,
    });
  }

  /**
   * mt#3429 SC2 (AT2): record a generic name-level cluster excluded from
   * the LLM stage for lacking a concentrated arg_fingerprint sub-pattern —
   * every occurrence sharing only the tool-name shape, not a repeated
   * concrete command, so the cluster carries no primitive-level signal.
   */
  async recordSuppressedByLowDistinctiveness(
    cluster: MinedCluster,
    concentration: number
  ): Promise<void> {
    await this.upsert(cluster, "suppressed", {
      suppressedReason: "low-distinctiveness",
      rejectionReason: `no arg_fingerprint sub-pattern reached the concentration threshold (top concentration ${(concentration * 100).toFixed(1)}%)`,
    });
  }

  /**
   * Bulk upsert for the "suppressed" verdict (mt#3432 perf fix).
   *
   * `collapseToMaximalClusters` runs on the FULL mined population (mt#3429
   * SC1) — against the live corpus this is ~11k+ suppressed clusters per
   * run, each of which mt#3429 required to be recorded (never a silent
   * drop). The original per-cluster `await recordSuppressedByMaximalCollapse(...)`
   * / `recordSuppressedByLowDistinctiveness(...)` loop issued one
   * sequential network round-trip PER cluster to Postgres; measured
   * against the live corpus (mt#3432), that round-trip averages ~166ms,
   * so ~11,220 sequential writes alone project to ~31 minutes — this,
   * not the O(n^2) collapse CPU cost (measured at <100ms even at 12.7k
   * clusters against the live corpus), is the actual mt#3432 hang.
   *
   * This method collapses the whole batch into ONE (or a few, chunked)
   * multi-row `INSERT ... ON CONFLICT DO UPDATE` statements — the same
   * bulk-upsert shape already established for the projection table in
   * `tool-call-projection-pipeline.ts` (`EXCLUDED.<column>` in the SET
   * clause) — turning ~11k round-trips into a small, fixed number.
   *
   * Chunked at `CHUNK_SIZE` rows per statement to keep any single
   * statement's parameter count and payload size bounded.
   *
   * **Narrowing fallback on chunk failure (mt#3432 PR #2456 R1).** A single
   * poisoned row in a 500-row multi-row `INSERT` fails the WHOLE statement
   * — mt#3429's "never silently drop a suppressed cluster" guarantee would
   * otherwise regress from "one bad row costs one row" (v1's per-row
   * writes) to "one bad row costs up to 500 rows." When a chunk's bulk
   * upsert throws, this method retries that chunk ONE ROW AT A TIME: every
   * good row in the chunk still lands (each is its own 1-row upsert), and
   * only the genuinely poisoned row(s) are logged and skipped — narrowed
   * to the finest possible granularity, not bisected in log2(n) steps,
   * since a 1-row retry is already the cheapest unit of isolation. Each
   * row that fails even on its OWN gets a structured
   * `engprod_ledger.suppressed_write_failed` event carrying its cluster
   * signature and the underlying error, so a reviewer/operator can see
   * exactly which signatures were lost — never a bare chunk-level count.
   * The happy path (the overwhelming common case) is unaffected: the
   * fallback only executes inside the `catch` block, so a clean chunk
   * costs exactly the one bulk statement it always did.
   */
  async recordSuppressedBatch(
    entries: readonly {
      cluster: MinedCluster;
      suppressedReason: string;
      rejectionReason: string;
    }[]
  ): Promise<void> {
    if (entries.length === 0) return;
    const CHUNK_SIZE = 500;
    const now = new Date();

    for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
      const chunk = entries.slice(i, i + CHUNK_SIZE);
      try {
        await this.upsertSuppressedChunk(chunk, now);
      } catch (err) {
        log.warn("engprod_ledger.suppressed_batch_chunk_failed", {
          event: "engprod_ledger.suppressed_batch_chunk_failed",
          chunkSize: chunk.length,
          chunkStartIndex: i,
          error: getLoggableErrorSummary(err),
        });
        for (const entry of chunk) {
          try {
            await this.upsertSuppressedChunk([entry], now);
          } catch (rowErr) {
            log.error("engprod_ledger.suppressed_write_failed", {
              event: "engprod_ledger.suppressed_write_failed",
              signature: entry.cluster.signature,
              suppressedReason: entry.suppressedReason,
              error: getLoggableErrorSummary(rowErr),
            });
          }
        }
      }
    }
  }

  /**
   * Shared bulk-upsert statement used by both the happy path (a full
   * `CHUNK_SIZE`-row chunk) and the per-row narrowing fallback (a
   * single-entry "chunk") in `recordSuppressedBatch` above — one
   * implementation of the `EXCLUDED.<column>` upsert shape, exercised at
   * either granularity.
   *
   * Because both paths share this one statement, the mt#3510 verdict-
   * preservation below covers the fallback too; a fix applied only to the
   * bulk path would silently leave the narrowing retry corrupting rows.
   */
  private async upsertSuppressedChunk(
    chunk: readonly {
      cluster: MinedCluster;
      suppressedReason: string;
      rejectionReason: string;
    }[],
    now: Date
  ): Promise<void> {
    const values = chunk.map(({ cluster, suppressedReason, rejectionReason }) => ({
      clusterSignature: cluster.signature,
      verdict: "suppressed" as const,
      rejectionReason,
      suppressedReason,
      toolSequence: cluster.toolSequence,
      evidenceFrequency: cluster.frequency,
      evidenceSessions: cluster.sessionCount,
      evidenceChainLength: cluster.chainLength,
      evidenceSnapshot: {
        sampleRefs: cluster.sampleRefs,
        score: cluster.score,
        capturedAt: now.toISOString(),
      },
      filedTaskId: null,
      everProposed: false,
      lastSuppressedAt: now,
      suppressionCount: 1,
      createdAt: now,
      updatedAt: now,
    }));

    await this.db
      .insert(engprodProposalLedgerTable)
      .values(values)
      .onConflictDoUpdate({
        target: engprodProposalLedgerTable.clusterSignature,
        set: {
          // A suppression pass may legitimately match a signature an
          // EARLIER run already filed a proposal for — the cluster recurred
          // and was collapsed into a higher-ranked one. When that happens
          // the suppression is real signal, but it must NOT land on the
          // row's verdict or on the evidence bound to that verdict.
          //
          // mt#3510: this set clause previously took `verdict` straight
          // from EXCLUDED, which overwrote 10 live filed proposals
          // (mt#3419-mt#3428) to "suppressed" while their tasks were still
          // BLOCKED. That destroys the gate's memory of the proposal, and
          // would destroy an `accepted`/`rejected` verdict exactly the same
          // way — which is what would make rejection non-durable.
          //
          // `everProposed` is the discriminator: true for any row ever
          // filed, false for a pure suppression row. It is reliable here
          // precisely BECAUSE it is preserved unconditionally below (as it
          // already was before this fix).
          verdict: preserveWhenProposed(engprodProposalLedgerTable.verdict, "verdict"),

          // Bound to `verdict` and preserved with it. The schema documents
          // the evidence quartet as "the window that produced the CURRENT
          // verdict", and the re-surface threshold re-proposes a rejected
          // cluster once frequency at least DOUBLES against this snapshot.
          // Re-baselining it on every suppression would silently raise that
          // bar to match current evidence, so the threshold could never
          // fire — and mt#3331's digest would show a pending proposal's
          // numbers drifting with no change to the proposal itself.
          rejectionReason: preserveWhenProposed(
            engprodProposalLedgerTable.rejectionReason,
            "rejection_reason"
          ),
          toolSequence: preserveWhenProposed(
            engprodProposalLedgerTable.toolSequence,
            "tool_sequence"
          ),
          evidenceFrequency: preserveWhenProposed(
            engprodProposalLedgerTable.evidenceFrequency,
            "evidence_frequency"
          ),
          evidenceSessions: preserveWhenProposed(
            engprodProposalLedgerTable.evidenceSessions,
            "evidence_sessions"
          ),
          evidenceChainLength: preserveWhenProposed(
            engprodProposalLedgerTable.evidenceChainLength,
            "evidence_chain_length"
          ),
          evidenceSnapshot: preserveWhenProposed(
            engprodProposalLedgerTable.evidenceSnapshot,
            "evidence_snapshot"
          ),

          // Recorded unconditionally — this is HOW a suppression against an
          // already-filed row survives without touching the verdict.
          suppressedReason: sql`EXCLUDED.suppressed_reason`,
          lastSuppressedAt: sql`EXCLUDED.last_suppressed_at`,
          suppressionCount: sql`${engprodProposalLedgerTable.suppressionCount} + 1`,

          // Same discipline as the single-row `upsert` above: never
          // clobber a prior filedTaskId / everProposed=true when this
          // batch's verdict is always "suppressed" — reference the
          // TARGET table's own current value rather than EXCLUDED's.
          filedTaskId: sql`${engprodProposalLedgerTable.filedTaskId}`,
          everProposed: sql`${engprodProposalLedgerTable.everProposed}`,
          updatedAt: sql`EXCLUDED.updated_at`,
        },
      });
  }

  /**
   * Reconcile every `proposed` ledger row against its filed task's CURRENT
   * status. `getTaskStatus` is injected so callers can pass a plain
   * `taskId => status` lookup (typically `taskService.getTask(id).then(t
   * => t?.status)`) without this service depending on the task domain
   * directly.
   *
   * - status === "BLOCKED" (or task not found): no change — still pending,
   *   or a transient lookup gap; left for the next run rather than guessed.
   * - status === "CLOSED": rejected (closed without ever being unblocked).
   * - anything else (TODO/PLANNING/READY/IN-PROGRESS/IN-REVIEW/DONE):
   *   accepted — the task left BLOCKED at some point, which per spec SC3
   *   IS acceptance, regardless of what happened to it afterward.
   */
  async reconcileVerdicts(
    getTaskStatus: (taskId: string) => Promise<string | undefined>
  ): Promise<{ accepted: number; rejected: number }> {
    let rows: ProposalLedgerRow[];
    try {
      rows = await this.db
        .select()
        .from(engprodProposalLedgerTable)
        .where(eq(engprodProposalLedgerTable.verdict, "proposed"));
    } catch (err) {
      log.error("engprod ledger: failed to load proposed rows for reconciliation", {
        error: getLoggableErrorSummary(err),
      });
      return { accepted: 0, rejected: 0 };
    }

    let accepted = 0;
    let rejected = 0;
    for (const row of rows) {
      if (!row.filedTaskId) continue;
      let status: string | undefined;
      try {
        status = await getTaskStatus(row.filedTaskId);
      } catch (err) {
        log.warn(`engprod ledger: status lookup failed for ${row.filedTaskId}`, {
          error: getLoggableErrorSummary(err),
        });
        continue;
      }
      const decision = decideReconciliation(status);
      if (decision === "no-change") continue;

      const now = new Date();
      if (decision === "rejected") {
        await this.db
          .update(engprodProposalLedgerTable)
          .set({
            verdict: "rejected",
            rejectionReason: "task closed without ever being unblocked",
            updatedAt: now,
          })
          .where(eq(engprodProposalLedgerTable.clusterSignature, row.clusterSignature));
        rejected++;
      } else {
        await this.db
          .update(engprodProposalLedgerTable)
          .set({ verdict: "accepted", updatedAt: now })
          .where(eq(engprodProposalLedgerTable.clusterSignature, row.clusterSignature));
        accepted++;
      }
    }

    return { accepted, rejected };
  }

  /** Most recent N run summaries — exposed for the miner's own diagnostics/tests. */
  async recentSignatures(limit = 50): Promise<ProposalLedgerRow[]> {
    return this.db
      .select()
      .from(engprodProposalLedgerTable)
      .orderBy(desc(engprodProposalLedgerTable.updatedAt))
      .limit(limit);
  }

  /**
   * Bulk read: ledger rows for a batch of filed task ids (mt#3331 cockpit
   * proposal digest). Used to join the EVIDENCE block (tool sequence,
   * frequency, sessions, chain length, rank score) onto each `engprod-proposal`
   * task the digest lists.
   *
   * Deliberately NOT used to derive accepted/rejected/pending disposition —
   * the digest reads the TASK's own current status for that (mirroring
   * `decideReconciliation` above exactly), not this row's `verdict` column.
   *
   * That started as a WORKAROUND: the suppression upsert used to set
   * `verdict: EXCLUDED.verdict` unconditionally, so a signature previously
   * `proposed` (or `accepted`/`rejected`) that recurred in a later run's
   * suppression sweep had its verdict silently overwritten. Observed live
   * 2026-07-31 on mt#3419-3428, whose tasks were still BLOCKED.
   *
   * mt#3510 FIXED that write path (suppression now preserves the verdict of
   * any `everProposed` row) and repaired the ten corrupted rows, so the
   * verdict column is trustworthy again. Reading task status is KEPT
   * anyway, as defense in depth: task status is the source of truth for
   * "has the principal triaged this", and deriving from it means the digest
   * cannot be wrong even if some future write path regresses the same way.
   */
  async getByFiledTaskIds(taskIds: readonly string[]): Promise<ProposalLedgerRow[]> {
    if (taskIds.length === 0) return [];
    return this.db
      .select()
      .from(engprodProposalLedgerTable)
      .where(inArray(engprodProposalLedgerTable.filedTaskId, [...taskIds]));
  }
}
