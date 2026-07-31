/**
 * Orchestration-level tests for `toilMinerTick` (mt#3330).
 *
 * Covers: SC4 (budget cap + suppression recording), SC6 (per-run counters
 * + two-consecutive-zero-cluster-runs error escalation), AT4 (a simulated
 * LLM-stage failure produces an error state, not a clean empty run).
 *
 * Dependencies are injected via the `ToilMinerTickDeps` test seams
 * (`ledgerService`, `mineClustersFn`, `analyzeClustersFn`, `fileProposalFn`)
 * rather than `mock.module()`, which `eslint-rules/no-global-module-mocks.js`
 * bans — mirrors `adoptionSweeperTick`'s `deps.execAsyncFn` pattern in
 * `start-command.ts`. Only `deps.db` is real-shaped (a minimal in-memory
 * fake covering just the `engprod_miner_runs` insert/select this level
 * touches directly — mining and the ledger are fully injected away).
 */

import { describe, test, expect } from "bun:test";
import { toilMinerTick, DEFAULT_BUDGET_CAP } from "./toil-miner-tick";
import type { MinedCluster, ClusterAnalysisOutcome } from "./types";

/** Each cluster gets a DISTINCT tool sequence so `selectTopClusters`'s
 * containment-redundancy filter (tested separately in
 * sequence-mining.test.ts) never collapses these fixtures together. */
function cluster(signature: string, frequency = 5): MinedCluster {
  return {
    signature,
    toolSequence: [`Tool-${signature}-A`, `Tool-${signature}-B`],
    frequency,
    sessionCount: 2,
    chainLength: 2,
    score: frequency * 2 * 2,
    sampleRefs: [],
  };
}

/**
 * Minimal in-memory fake for the `engprod_miner_runs` table only. `insert`
 * and `select` share ONE backing array so a row written by THIS tick's own
 * run-history insert is visible to the immediately-following "last 2 runs"
 * select — matching real same-connection Postgres read-after-write
 * behavior, which the two-consecutive-zero-cluster check depends on.
 */
function makeRunsDb(priorRuns: Array<{ clustersFound: number; startedAt: Date }> = []) {
  const rows: Array<{ clustersFound: number; startedAt: Date }> = [...priorRuns];
  return {
    rows,
    insert(_table: unknown) {
      return {
        values: (row: { clustersFound: number; startedAt: Date }) => {
          rows.push(row);
          return Promise.resolve();
        },
      };
    },
    select(_fields?: Record<string, unknown>) {
      return {
        from: (_table: unknown) => ({
          orderBy: (_o: unknown) => ({
            limit: (n: number) =>
              Promise.resolve(
                [...rows].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).slice(0, n)
              ),
          }),
        }),
      };
    },
  };
}

function fakeLedgerService(
  overrides: Partial<{
    shouldPropose: (c: MinedCluster) => Promise<{ propose: boolean; reason?: string }>;
  }> = {}
) {
  return {
    reconcileVerdicts: async () => ({ accepted: 0, rejected: 0 }),
    shouldPropose: overrides.shouldPropose ?? (async () => ({ propose: true })),
    recordSuppressedByBudget: async () => {},
    recordSuperseded: async () => {},
    recordProposed: async () => {},
  };
}

function fakeTaskService() {
  let nextId = 0;
  return {
    getTask: async () => null,
    createTaskFromTitleAndSpec: async (
      title: string,
      _spec: string,
      options: Record<string, unknown>
    ) => ({
      id: `mt#fake-${nextId++}`,
      title,
      status: (options.status as string) ?? "TODO",
      tags: (options.tags as string[]) ?? [],
    }),
  };
}

const NOOP_COGNITION_PROVIDER = {
  perform: async () => ({ kind: "completed" as const, value: {} }),
  performBatch: async () => {
    throw new Error("unused");
  },
};
const NOOP_SIMILARITY_SERVICE = {
  searchByText: async () => ({ results: [], backend: "embeddings", degraded: false }),
};

describe("toilMinerTick — budget cap (SC4)", () => {
  test("files up to the cap and suppresses the rest, recording each suppression", async () => {
    const clusters = [cluster("s1"), cluster("s2"), cluster("s3")];
    const taskService = fakeTaskService();
    const suppressed: string[] = [];
    const ledgerService = {
      ...fakeLedgerService(),
      recordSuppressedByBudget: async (c: MinedCluster) => {
        suppressed.push(c.signature);
      },
    };

    const analyzeOutcomes = new Map<string, ClusterAnalysisOutcome>(
      clusters.map((c) => [
        c.signature,
        { proposedPrimitive: "x", existingToolCoverage: "y", alreadyCovered: false },
      ])
    );

    const counters = await toilMinerTick(
      {
        db: makeRunsDb() as never,
        taskService: taskService as never,
        cognitionProvider: NOOP_COGNITION_PROVIDER as never,
        taskSimilarityService: NOOP_SIMILARITY_SERVICE as never,
        ledgerService,
        mineClustersFn: async () => ({ clusters, turnsScanned: 42 }),
        analyzeClustersFn: async () => analyzeOutcomes,
      },
      { budgetCap: 2 }
    );

    expect(counters.proposalsGenerated).toBe(2);
    expect(counters.suppressedByBudget).toBe(1);
    expect(suppressed).toEqual(["s3"]);
  });

  test("default budget cap is 5", () => {
    expect(DEFAULT_BUDGET_CAP).toBe(5);
  });
});

describe("toilMinerTick — counters (SC6)", () => {
  test("reports turnsScanned, clustersFound, clustersSentToLlm, proposalsGenerated, suppressedByDedupe", async () => {
    const clusters = [cluster("keep"), cluster("dedupe-me")];
    const analyzeOutcomes = new Map<string, ClusterAnalysisOutcome>([
      ["keep", { proposedPrimitive: "x", existingToolCoverage: "y", alreadyCovered: false }],
    ]);

    const counters = await toilMinerTick(
      {
        db: makeRunsDb() as never,
        taskService: fakeTaskService() as never,
        cognitionProvider: NOOP_COGNITION_PROVIDER as never,
        taskSimilarityService: NOOP_SIMILARITY_SERVICE as never,
        // "dedupe-me" is rejected by the ledger's first dedupe stage —
        // never reaches the LLM at all.
        ledgerService: fakeLedgerService({
          shouldPropose: async (c: MinedCluster) =>
            c.signature === "dedupe-me"
              ? { propose: false, reason: "already proposed" }
              : { propose: true },
        }),
        mineClustersFn: async () => ({ clusters, turnsScanned: 17 }),
        analyzeClustersFn: async () => analyzeOutcomes,
      },
      {}
    );

    expect(counters.turnsScanned).toBe(17);
    expect(counters.clustersFound).toBe(2);
    expect(counters.clustersSentToLlm).toBe(1); // only "keep" passed the ledger check
    expect(counters.suppressedByDedupe).toBe(1); // "dedupe-me"
    expect(counters.proposalsGenerated).toBe(1);
  });
});

describe("toilMinerTick — LLM-stage failure (AT4)", () => {
  test("a failing cluster analysis makes the tick throw (error state, not a clean empty run)", async () => {
    const clusters = [cluster("will-fail")];
    const analyzeOutcomes = new Map<string, ClusterAnalysisOutcome>([
      ["will-fail", { error: "simulated LLM provider failure" }],
    ]);

    await expect(
      toilMinerTick(
        {
          db: makeRunsDb() as never,
          taskService: fakeTaskService() as never,
          cognitionProvider: NOOP_COGNITION_PROVIDER as never,
          taskSimilarityService: NOOP_SIMILARITY_SERVICE as never,
          ledgerService: fakeLedgerService(),
          mineClustersFn: async () => ({ clusters, turnsScanned: 5 }),
          analyzeClustersFn: async () => analyzeOutcomes,
        },
        {}
      )
    ).rejects.toThrow(/LLM-stage error/);
  });
});

describe("toilMinerTick — two consecutive zero-cluster runs (SC6)", () => {
  test("throws when the immediately preceding run was ALSO zero-cluster", async () => {
    const priorRun = { clustersFound: 0, startedAt: new Date("2026-01-01T00:00:00Z") };

    await expect(
      toilMinerTick(
        {
          db: makeRunsDb([priorRun]) as never,
          taskService: fakeTaskService() as never,
          cognitionProvider: NOOP_COGNITION_PROVIDER as never,
          taskSimilarityService: NOOP_SIMILARITY_SERVICE as never,
          ledgerService: fakeLedgerService(),
          mineClustersFn: async () => ({ clusters: [], turnsScanned: 0 }),
          analyzeClustersFn: async () => new Map(),
        },
        {}
      )
    ).rejects.toThrow(/two consecutive zero-cluster runs/);
  });

  test("does NOT throw on a single zero-cluster run with no prior zero-cluster history", async () => {
    const priorRun = { clustersFound: 3, startedAt: new Date("2026-01-01T00:00:00Z") };

    const counters = await toilMinerTick(
      {
        db: makeRunsDb([priorRun]) as never,
        taskService: fakeTaskService() as never,
        cognitionProvider: NOOP_COGNITION_PROVIDER as never,
        taskSimilarityService: NOOP_SIMILARITY_SERVICE as never,
        ledgerService: fakeLedgerService(),
        mineClustersFn: async () => ({ clusters: [], turnsScanned: 0 }),
        analyzeClustersFn: async () => new Map(),
      },
      {}
    );

    expect(counters.clustersFound).toBe(0);
  });
});
