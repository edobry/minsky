/**
 * EngProd toil miner — orchestration (mt#3330; v2 quality pass mt#3429).
 *
 * One call = one mining run. Order of operations:
 *
 * 1. Reconcile prior `proposed` ledger rows against their filed tasks'
 *    current status ("acceptance = unblocking").
 * 2. Stage 1 (deterministic): mine clusters from the projection table
 *    (each carrying a `fingerprintProfile`, mt#3429 SC2).
 * 3. Maximal-sequence collapsing (mt#3429 SC1): suppress any cluster whose
 *    tool sequence is a contiguous run of a higher-ranked, still-surviving
 *    cluster — recorded in the ledger (`non-maximal-subsequence`), never
 *    silently dropped. Runs on the FULL population, before any cap.
 * 4. Fingerprint refinement (mt#3429 SC2): substitute each surviving
 *    cluster with its fingerprint-refined sub-cluster when concentration
 *    crosses the configurable threshold (default ~20%); otherwise exclude
 *    it from the LLM stage entirely (`low-distinctiveness`) — a generic
 *    cluster never reaches the LLM unrefined.
 * 5. Rank and cap to the top `llmCap` (default 10) after collapsing any
 *    remaining contiguous-subsequence redundancy (`selectTopClusters`).
 * 6. Ledger dedupe (first dedupe stage) — filters the top clusters BEFORE
 *    the LLM stage runs at all.
 * 7. Stage 2 (LLM, AI-as-API): analyze each surviving cluster, using
 *    representative tool-name + fingerprint samples in the prompt
 *    (mt#3429 SC3 — never raw arguments).
 * 8. Budget cap (default 5) + task-similarity dedupe (second dedupe stage)
 *    decide which survivors actually get filed as BLOCKED proposal tasks.
 * 9. Persist per-run counters + history (self-observability, and the
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

import {
  mineClusters,
  selectTopClusters,
  collapseToMaximalClusters,
  type MineClustersOptions,
} from "./sequence-mining";
import {
  refineCluster,
  DEFAULT_FINGERPRINT_CONCENTRATION_THRESHOLD,
} from "./fingerprint-refinement";
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
    | "recordSuppressedByMaximalCollapse"
    | "recordSuppressedByLowDistinctiveness"
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
  /** mt#3429 SC2: min fraction of a cluster's occurrences a single arg_fingerprint sequence must cover to be proposed as a refined cluster (default ~20%, spec). */
  fingerprintConcentrationThreshold?: number;
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

  // mt#3429 SC1: maximal-sequence collapsing — one phenomenon, one
  // candidate. Runs on the FULL mined population (before any cap), so a
  // nested family (e.g. Bash x2..x6) never crowds the llmCap with N
  // overlapping views of the same underlying pattern. Every suppressed
  // member is recorded in the ledger (never a silent drop) with a
  // distinct suppressedReason, referencing the surviving cluster.
  const { maximal, suppressed: maximalSuppressed } = collapseToMaximalClusters(clusters);
  for (const { cluster, supersededBy } of maximalSuppressed) {
    counters.suppressedByMaximalCollapse++;
    try {
      await ledgerService.recordSuppressedByMaximalCollapse(cluster, supersededBy.signature);
    } catch (err) {
      log.error("engprod_toil_miner.ledger_write_failed", {
        event: "engprod_toil_miner.ledger_write_failed",
        runId,
        phase: "maximal_collapse",
        signature: cluster.signature,
        error: getLoggableErrorSummary(err),
      });
    }
    log.info("engprod_toil_miner.suppressed_by_maximal_collapse", {
      event: "engprod_toil_miner.suppressed_by_maximal_collapse",
      runId,
      signature: cluster.signature,
      supersededBy: supersededBy.signature,
    });
  }

  // mt#3429 SC2: fingerprint refinement. For each surviving (maximal)
  // cluster, either substitute it with its fingerprint-refined sub-cluster
  // (when a concrete command sequence is concentrated enough to be the
  // real signal) or exclude it from the LLM stage entirely (when the
  // occurrences are just tool-name noise with no distinctive sub-pattern —
  // the "distinctiveness floor"). A generic cluster NEVER reaches the LLM
  // unrefined.
  const fingerprintThreshold =
    options.fingerprintConcentrationThreshold ?? DEFAULT_FINGERPRINT_CONCENTRATION_THRESHOLD;
  const refinedClusters: MinedCluster[] = [];
  for (const cluster of maximal) {
    const outcome = refineCluster(cluster, fingerprintThreshold);
    if (outcome.kind === "refined") {
      refinedClusters.push(outcome.cluster);
      log.info("engprod_toil_miner.refined_by_fingerprint", {
        event: "engprod_toil_miner.refined_by_fingerprint",
        runId,
        genericSignature: cluster.signature,
        refinedSignature: outcome.cluster.signature,
        concentration: outcome.concentration,
      });
      continue;
    }
    if (outcome.kind === "unrefined") {
      // No fingerprint measurement available at all — unreachable in the
      // real pipeline (mineClusters always populates a profile); pass the
      // cluster through unchanged rather than treating absence of data the
      // same as a measured low-distinctiveness verdict.
      refinedClusters.push(outcome.cluster);
      continue;
    }
    counters.suppressedByLowDistinctiveness++;
    try {
      await ledgerService.recordSuppressedByLowDistinctiveness(cluster, outcome.concentration);
    } catch (err) {
      log.error("engprod_toil_miner.ledger_write_failed", {
        event: "engprod_toil_miner.ledger_write_failed",
        runId,
        phase: "low_distinctiveness",
        signature: cluster.signature,
        error: getLoggableErrorSummary(err),
      });
    }
    log.info("engprod_toil_miner.suppressed_by_low_distinctiveness", {
      event: "engprod_toil_miner.suppressed_by_low_distinctiveness",
      runId,
      signature: cluster.signature,
      concentration: outcome.concentration,
    });
  }

  const llmCap = options.llmCap ?? DEFAULT_LLM_CAP;
  const topClusters = selectTopClusters(refinedClusters, llmCap);

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
  const llmStageErrored = counters.llmErrors > 0;
  let twoConsecutiveZero = false;

  // Determine twoConsecutiveZero BEFORE inserting this run's row — the
  // insert must carry the FINAL `errored` value (llmStageErrored OR
  // twoConsecutiveZero), so the query for "was the immediately-preceding
  // run also zero-cluster" has to happen first, against history that does
  // NOT yet include this run (mt#3330 review R1: writing `errored` before
  // this check meant a two-consecutive-zero-run error never made it into
  // the persisted row, leaving the ops log and the run-history table
  // disagreeing about whether the run was clean).
  try {
    const priorRun = await deps.db
      .select({ clustersFound: engprodMinerRunsTable.clustersFound })
      .from(engprodMinerRunsTable)
      .orderBy(desc(engprodMinerRunsTable.startedAt))
      .limit(1);
    twoConsecutiveZero =
      counters.clustersFound === 0 && priorRun.length === 1 && priorRun[0]?.clustersFound === 0;
  } catch (err) {
    log.error("engprod_toil_miner.run_history_error", {
      event: "engprod_toil_miner.run_history_error",
      runId,
      phase: "prior_run_lookup",
      error: getLoggableErrorSummary(err),
    });
  }

  const errored = llmStageErrored || twoConsecutiveZero;

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
  } catch (err) {
    log.error("engprod_toil_miner.run_history_error", {
      event: "engprod_toil_miner.run_history_error",
      runId,
      phase: "insert",
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

  if (llmStageErrored) {
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
