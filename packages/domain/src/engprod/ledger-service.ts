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
import { eq, desc, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  engprodProposalLedgerTable,
  type ProposalLedgerRow,
} from "../storage/schemas/engprod-proposal-ledger-schema";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";
import type { MinedCluster } from "./types";

export type ProposalVerdict = "proposed" | "accepted" | "rejected" | "superseded" | "suppressed";

export interface ShouldProposeDecision {
  propose: boolean;
  reason?: string;
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
   * First dedupe stage (ledger, exact signature). Does NOT touch the
   * database — pure decision over the cluster's existing ledger row (or
   * lack of one).
   */
  async shouldPropose(cluster: MinedCluster): Promise<ShouldProposeDecision> {
    const existing = await this.getBySignature(cluster.signature);
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

  private async upsert(
    cluster: MinedCluster,
    verdict: ProposalVerdict,
    extra: { rejectionReason?: string; suppressedReason?: string; filedTaskId?: string } = {}
  ): Promise<void> {
    const now = new Date();
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
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: engprodProposalLedgerTable.clusterSignature,
        set: {
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
      if (status === undefined || status === "BLOCKED") continue;

      const now = new Date();
      if (status === "CLOSED") {
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
}
