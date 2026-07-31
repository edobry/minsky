/**
 * EngProd toil miner — orchestration (mt#3330).
 *
 * One call = one mining run. Order of operations:
 *
 * 1. Reconcile prior `proposed` ledger rows against their filed tasks'
 *    current status ("acceptance = unblocking").
 * 2. Stage 1 (deterministic): mine clusters from the projection table,
 *    rank, and cap to the top `llmCap` (default 10) after collapsing
 *    contiguous-subsequence redundancy.
 * 3. Ledger dedupe (first dedupe stage) — filters the top clusters BEFORE
 *    the LLM stage runs at all.
 * 4. Stage 2 (LLM, AI-as-API): analyze each surviving cluster.
 * 5. Budget cap (default 5) + task-similarity dedupe (second dedupe stage)
 *    decide which survivors actually get filed as BLOCKED proposal tasks.
 * 6. Persist per-run counters + history (self-observability, and the
 *    durable state needed for "two consecutive zero-cluster runs" —
 *    an in-memory counter would not survive an ops-service restart).
 *
 * Error semantics: an LLM-stage failure on ANY cluster, or two consecutive
 * zero-cluster runs, makes this function THROW after logging + persisting
 * the run — the ops loop registry (`registerLoop` in
 * `src/commands/ops/start-command.ts`) records this as a loop error
 * (`errorCount`/`lastErrorAt`), never a clean tick, per spec SC6 / AT4.
 */

import { desc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { randomUUID } from "node:crypto";

import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";
import type { TaskServiceInterface } from "../tasks/taskService";
import type { TaskSimilarityService } from "../tasks/task-similarity-service";
import type { CognitionProvider } from "../cognition/types";
import { engprodMinerRunsTable } from "../storage/schemas/engprod-proposal-ledger-schema";

import { mineClusters, selectTopClusters, type MineClustersOptions } from "./sequence-mining";
import { analyzeClusters } from "./cluster-analysis";
import { ProposalLedgerService } from "./ledger-service";
import { fileProposal } from "./proposal-filing-service";
import {
  emptyRunCounters,
  isClusterAnalysisError,
  type MinedCluster,
  type ToilMinerRunCounters,
} from "./types";

export const DEFAULT_LLM_CAP = 10;
export const DEFAULT_BUDGET_CAP = 5;

export interface ToilMinerTickDeps {
  db: PostgresJsDatabase;
  taskService: TaskServiceInterface;
  cognitionProvider: CognitionProvider;
  taskSimilarityService: TaskSimilarityService;
  /**
   * Test seams (mirrors `adoptionSweeperTick`'s `deps.execAsyncFn` pattern
   * in `start-command.ts`) — DI rather than module-mocking, per
   * `eslint-rules/no-global-module-mocks.js`. Production callers omit all
   * of these; only `toil-miner-tick.test.ts` supplies them, to exercise the
   * orchestration logic (budget cap, counters, error escalation) without a
   * real database or LLM provider.
   */
  ledgerService?: Pick<
    ProposalLedgerService,
    | "reconcileVerdicts"
    | "shouldPropose"
    | "recordSuppressedByBudget"
    | "recordSuperseded"
    | "recordProposed"
  >;
  mineClustersFn?: typeof mineClusters;
  analyzeClustersFn?: typeof analyzeClusters;
  fileProposalFn?: typeof fileProposal;
}

export interface ToilMinerTickOptions extends MineClustersOptions {
  llmCap?: number;
  budgetCap?: number;
  similarityThreshold?: number;
}

export async function toilMinerTick(
  deps: ToilMinerTickDeps,
  options: ToilMinerTickOptions = {}
): Promise<ToilMinerRunCounters> {
  const runId = randomUUID();
  const startedAt = new Date();
  const counters = emptyRunCounters();

  let ledgerService: NonNullable<ToilMinerTickDeps["ledgerService"]>;
  if (deps.ledgerService) {
    ledgerService = deps.ledgerService;
  } else {
    ledgerService = new ProposalLedgerService(deps.db);
  }
  const mine = deps.mineClustersFn ?? mineClusters;
  const analyze = deps.analyzeClustersFn ?? analyzeClusters;
  const file = deps.fileProposalFn ?? fileProposal;

  log.info("engprod_toil_miner.run_started", {
    event: "engprod_toil_miner.run_started",
    runId,
    startedAt: startedAt.toISOString(),
  });

  try {
    const reconciled = await ledgerService.reconcileVerdicts((id) =>
      deps.taskService.getTask(id).then((t) => t?.status)
    );
    log.info("engprod_toil_miner.reconciled", {
      event: "engprod_toil_miner.reconciled",
      runId,
      ...reconciled,
    });
  } catch (err) {
    log.warn("engprod_toil_miner.reconcile_failed", {
      event: "engprod_toil_miner.reconcile_failed",
      runId,
      error: getLoggableErrorSummary(err),
    });
  }

  // Stage 1: deterministic mining.
  const { clusters, turnsScanned } = await mine(deps.db, options);
  counters.turnsScanned = turnsScanned;
  counters.clustersFound = clusters.length;

  const llmCap = options.llmCap ?? DEFAULT_LLM_CAP;
  const topClusters = selectTopClusters(clusters, llmCap);

  // First dedupe stage: ledger (exact signature) — BEFORE the LLM stage.
  const llmCandidates: MinedCluster[] = [];
  for (const cluster of topClusters) {
    const decision = await ledgerService.shouldPropose(cluster);
    if (!decision.propose) {
      counters.suppressedByDedupe++;
      log.info("engprod_toil_miner.suppressed_by_ledger", {
        event: "engprod_toil_miner.suppressed_by_ledger",
        runId,
        signature: cluster.signature,
        reason: decision.reason,
      });
      continue;
    }
    llmCandidates.push(cluster);
  }
  counters.clustersSentToLlm = llmCandidates.length;

  // Stage 2: LLM cluster analysis (AI-as-API, direct provider call).
  const analyses = await analyze(deps.cognitionProvider, llmCandidates);

  const budgetCap = options.budgetCap ?? DEFAULT_BUDGET_CAP;
  let filedCount = 0;
  for (const cluster of llmCandidates) {
    const outcome = analyses.get(cluster.signature);
    if (!outcome) continue; // should not happen — every candidate gets an outcome

    if (isClusterAnalysisError(outcome)) {
      counters.llmErrors++;
      log.error("engprod_toil_miner.llm_error", {
        event: "engprod_toil_miner.llm_error",
        runId,
        signature: cluster.signature,
        error: outcome.error,
      });
      continue;
    }

    if (filedCount >= budgetCap) {
      counters.suppressedByBudget++;
      await ledgerService.recordSuppressedByBudget(cluster);
      log.info("engprod_toil_miner.suppressed_by_budget", {
        event: "engprod_toil_miner.suppressed_by_budget",
        runId,
        signature: cluster.signature,
      });
      continue;
    }

    // Second dedupe stage (task-similarity) happens inside fileProposal.
    const result = await file(
      {
        taskService: deps.taskService,
        taskSimilarityService: deps.taskSimilarityService,
        ledgerService,
        similarityThreshold: options.similarityThreshold,
      },
      cluster,
      outcome
    );

    if (result.filed) {
      filedCount++;
      counters.proposalsGenerated++;
      log.info("engprod_toil_miner.proposal_filed", {
        event: "engprod_toil_miner.proposal_filed",
        runId,
        signature: cluster.signature,
        taskId: result.taskId,
      });
    } else {
      counters.suppressedByDedupe++;
      log.info("engprod_toil_miner.suppressed_by_similarity", {
        event: "engprod_toil_miner.suppressed_by_similarity",
        runId,
        signature: cluster.signature,
        matchedTaskId: result.matchedTaskId,
      });
    }
  }

  const finishedAt = new Date();
  const errored = counters.llmErrors > 0;
  let twoConsecutiveZero = false;

  try {
    await deps.db.insert(engprodMinerRunsTable).values({
      id: runId,
      startedAt,
      finishedAt,
      turnsScanned: counters.turnsScanned,
      clustersFound: counters.clustersFound,
      clustersSentToLlm: counters.clustersSentToLlm,
      proposalsGenerated: counters.proposalsGenerated,
      suppressedByDedupe: counters.suppressedByDedupe,
      suppressedByBudget: counters.suppressedByBudget,
      llmErrors: counters.llmErrors,
      errored,
    });

    const priorRuns = await deps.db
      .select({
        clustersFound: engprodMinerRunsTable.clustersFound,
        startedAt: engprodMinerRunsTable.startedAt,
      })
      .from(engprodMinerRunsTable)
      .orderBy(desc(engprodMinerRunsTable.startedAt))
      .limit(2);
    twoConsecutiveZero = priorRuns.length === 2 && priorRuns.every((r) => r.clustersFound === 0);
  } catch (err) {
    log.error("engprod_toil_miner.run_history_error", {
      event: "engprod_toil_miner.run_history_error",
      runId,
      error: getLoggableErrorSummary(err),
    });
  }

  log.info("engprod_toil_miner.run_completed", {
    event: "engprod_toil_miner.run_completed",
    runId,
    ...counters,
    errored,
    twoConsecutiveZero,
  });

  if (errored) {
    throw new Error(
      `engprod_toil_miner: ${counters.llmErrors} LLM-stage error(s) this run (runId=${runId}) — see engprod_toil_miner.llm_error logs`
    );
  }
  if (twoConsecutiveZero) {
    throw new Error(
      `engprod_toil_miner: two consecutive zero-cluster runs (runId=${runId}) — mining may be broken (empty projection window, or thresholds too strict)`
    );
  }

  return counters;
}
