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

interface FakeRunRow {
  clustersFound: number;
  startedAt: Date;
  errored?: boolean;
}

/**
 * Minimal in-memory fake for the `engprod_miner_runs` table only. The
 * prior-run lookup (`.limit(1)`) runs BEFORE this tick's own insert, so it
 * only ever sees seeded `priorRuns` — matching the production code's
 * ordering fix (mt#3330 review R1): `twoConsecutiveZero` must be known
 * before the row carrying `errored` is written, not derived afterward.
 */
function makeRunsDb(priorRuns: FakeRunRow[] = []) {
  const rows: FakeRunRow[] = [...priorRuns];
  return {
    rows,
    insert(_table: unknown) {
      return {
        values: (row: FakeRunRow) => {
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
    recordSuppressedByMaximalCollapse: async () => {},
    recordSuppressedByLowDistinctiveness: async () => {},
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
    const db = makeRunsDb();

    await expect(
      toilMinerTick(
        {
          db: db as never,
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

    // mt#3330 review R1: the persisted run-history row must agree with the
    // thrown error — `errored` is not just a log-line claim.
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]?.errored).toBe(true);
  });
});

describe("toilMinerTick — two consecutive zero-cluster runs (SC6)", () => {
  test("throws when the immediately preceding run was ALSO zero-cluster", async () => {
    const priorRun = { clustersFound: 0, startedAt: new Date("2026-01-01T00:00:00Z") };
    const db = makeRunsDb([priorRun]);

    await expect(
      toilMinerTick(
        {
          db: db as never,
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

    // mt#3330 review R1: the persisted row for THIS run must also carry
    // errored=true — the two-consecutive-zero-run error is not just thrown
    // and logged, it must be visible in the run-history table too.
    expect(db.rows).toHaveLength(2); // seeded priorRun + this run's new row
    expect(db.rows[1]?.errored).toBe(true);
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

describe("toilMinerTick — v2 quality pass against a live-ledger-shaped fixture (mt#3429)", () => {
  /**
   * Mirrors the ACTUAL live ledger state this task must respect:
   * engprod_proposal_ledger currently holds 10 `proposed` rows
   * (mt#3419-mt#3428) for exactly these ten name-level clusters, each
   * already filed as a real BLOCKED task. v2's collapsing/refinement must
   * NOT re-propose these phenomena as-is on the next run — the six
   * non-maximal members collapse into their two families' survivors
   * (Bash x2, session_exec x2), and ALL FOUR surviving maximal clusters
   * are deliberately built with diverse (low-concentration) fingerprints
   * — the real corpus shape for "any two Bash calls in a row," which
   * carries no repeated-command signal — so every one of the ten lands
   * suppressed (either non-maximal-subsequence or low-distinctiveness)
   * and ZERO new proposals are filed for this run.
   */
  function nameCluster(
    toolSequence: string[],
    frequency: number,
    sessionCount: number
  ): MinedCluster {
    const chainLength = toolSequence.length;
    // Diverse (low-concentration) fingerprints: every occurrence's
    // fingerprint sequence is unique, so the top group covers exactly one
    // occurrence — mirrors "the same tool, unrelated commands."
    const topGroupFrequency = 1;
    return {
      signature: `${toolSequence.join("-")}-sig`,
      toolSequence,
      frequency,
      sessionCount,
      chainLength,
      score: frequency * sessionCount * chainLength,
      sampleRefs: [],
      fingerprintProfile: {
        sequence: toolSequence.map((_, i) => `fp:unique-${i}`),
        frequency: topGroupFrequency,
        sessionCount: 1,
        concentration: topGroupFrequency / frequency,
        sampleRefs: [],
      },
    };
  }

  function liveShapedClusters(): MinedCluster[] {
    return [
      nameCluster(["Bash", "Bash"], 6628, 407),
      nameCluster(["Bash", "Bash", "Bash"], 4117, 353),
      nameCluster(["Bash", "Bash", "Bash", "Bash"], 2772, 291),
      nameCluster(["session_exec", "session_exec"], 4427, 299),
      nameCluster(["Bash", "Bash", "Bash", "Bash", "Bash"], 1966, 231),
      nameCluster(["session_exec", "session_exec", "session_exec"], 2293, 249),
      nameCluster(["Bash", "Bash", "Bash", "Bash", "Bash", "Bash"], 1447, 190),
      nameCluster(["Bash", "Read"], 2057, 347),
      nameCluster(["Read", "Read"], 1773, 315),
      nameCluster(["session_exec", "session_exec", "session_exec", "session_exec"], 1335, 197),
    ].sort((a, b) => b.score - a.score);
  }

  /** Pre-seeds a fake ledger as if every one of the ten clusters above was
   * ALREADY `proposed` (a real BLOCKED task filed) prior to this run — the
   * live state this task must respect. */
  function fakeLedgerWithLiveProposedRows(clusters: MinedCluster[]) {
    const proposedSignatures = new Set(clusters.map((c) => c.signature));
    const maximalCollapseCalls: Array<{ signature: string; supersededBy: string }> = [];
    const lowDistinctivenessCalls: Array<{ signature: string; concentration: number }> = [];
    const proposedCalls: string[] = [];

    return {
      proposedSignatures,
      maximalCollapseCalls,
      lowDistinctivenessCalls,
      proposedCalls,
      ledgerService: {
        reconcileVerdicts: async () => ({ accepted: 0, rejected: 0 }),
        // Every one of the ten signatures already has a `proposed` row
        // pending triage — the ledger's own first dedupe stage would
        // refuse to re-propose it. This run's clusters never even reach
        // this check (v2's collapse/refinement stages exclude them all
        // first), so this is here to prove that too: if it WERE consulted
        // for one of the ten, it must refuse.
        shouldPropose: async (c: MinedCluster) =>
          proposedSignatures.has(c.signature)
            ? { propose: false, reason: "cluster already proposed and pending triage" }
            : { propose: true },
        recordSuppressedByBudget: async () => {},
        recordSuppressedByMaximalCollapse: async (c: MinedCluster, supersededBy: string) => {
          maximalCollapseCalls.push({ signature: c.signature, supersededBy });
        },
        recordSuppressedByLowDistinctiveness: async (c: MinedCluster, concentration: number) => {
          lowDistinctivenessCalls.push({ signature: c.signature, concentration });
        },
        recordSuperseded: async () => {},
        recordProposed: async (c: MinedCluster) => {
          proposedCalls.push(c.signature);
        },
      },
    };
  }

  test("collapses the ten live-shaped clusters to zero new proposals; every one lands suppressed", async () => {
    const clusters = liveShapedClusters();
    const fake = fakeLedgerWithLiveProposedRows(clusters);
    const db = makeRunsDb();

    const counters = await toilMinerTick(
      {
        db: db as never,
        taskService: fakeTaskService() as never,
        cognitionProvider: NOOP_COGNITION_PROVIDER as never,
        taskSimilarityService: NOOP_SIMILARITY_SERVICE as never,
        ledgerService: fake.ledgerService,
        mineClustersFn: async () => ({ clusters, turnsScanned: 60628 }),
        analyzeClustersFn: async () => new Map(),
      },
      {}
    );

    // Must NOT re-propose any of the ten phenomena as-is this run.
    expect(fake.proposedCalls).toHaveLength(0);
    expect(counters.proposalsGenerated).toBe(0);
    expect(counters.clustersSentToLlm).toBe(0);

    // SC1: the six non-maximal family members (Bash x3/x4/x5/x6,
    // session_exec x3/x4) are suppressed as non-maximal-subsequence.
    expect(fake.maximalCollapseCalls).toHaveLength(6);
    expect(counters.suppressedByMaximalCollapse).toBe(6);
    const bash2Sig = "Bash-Bash-sig";
    const sessionExec2Sig = "session_exec-session_exec-sig";
    for (const call of fake.maximalCollapseCalls) {
      expect([bash2Sig, sessionExec2Sig]).toContain(call.supersededBy);
    }

    // SC2: the four surviving maximal clusters (Bash x2, session_exec x2,
    // Bash->Read, Read->Read) all carry diverse fingerprints in this
    // fixture — none reaches the concentration threshold — so all four
    // are excluded as low-distinctiveness. None reaches the LLM stage.
    expect(fake.lowDistinctivenessCalls).toHaveLength(4);
    expect(counters.suppressedByLowDistinctiveness).toBe(4);
    const lowDistinctivenessSignatures = fake.lowDistinctivenessCalls
      .map((c) => c.signature)
      .sort();
    expect(lowDistinctivenessSignatures).toEqual(
      [bash2Sig, sessionExec2Sig, "Bash-Read-sig", "Read-Read-sig"].sort()
    );

    // Every one of the ten clusters was accounted for (6 + 4 = 10) — none
    // silently dropped.
    expect(fake.maximalCollapseCalls.length + fake.lowDistinctivenessCalls.length).toBe(10);

    // The two new counters are PERSISTED in the run-history row, not just
    // returned/logged — parity with every other counter (mt#3429 R1: a
    // reviewer finding on the first round of this PR).
    expect(db.rows).toHaveLength(1);
    expect((db.rows[0] as unknown as Record<string, number>).suppressedByMaximalCollapse).toBe(6);
    expect((db.rows[0] as unknown as Record<string, number>).suppressedByLowDistinctiveness).toBe(
      4
    );
  });

  test("a concentrated fingerprint sub-pattern on the surviving maximal cluster reaches the LLM as a REFINED cluster", async () => {
    // Same shape as above, but the Bash x2 survivor has a genuinely
    // concentrated fingerprint pattern this time (e.g. "git status" then
    // "git diff" repeated) — it should be REFINED and reach the LLM,
    // while the rest of the family and the OTHER three maximal clusters
    // are still suppressed as before.
    const clusters = liveShapedClusters().map((c) =>
      c.toolSequence.join(",") === "Bash,Bash"
        ? {
            ...c,
            fingerprintProfile: {
              sequence: ["fp:git-status", "fp:git-diff"],
              frequency: Math.ceil(c.frequency * 0.3),
              sessionCount: Math.ceil(c.sessionCount * 0.3),
              concentration: 0.3,
              sampleRefs: [
                {
                  sessionId: "s1",
                  turnIndex: 0,
                  argFingerprints: ["fp:git-status", "fp:git-diff"],
                },
              ],
            },
          }
        : c
    );
    const fake = fakeLedgerWithLiveProposedRows(clusters);
    const refinedSignature = clusters
      .find((c) => c.toolSequence.join(",") === "Bash,Bash")
      ?.fingerprintProfile?.sequence.join(",");
    expect(refinedSignature).toBeDefined();

    const analyzeOutcomes = new Map<string, ClusterAnalysisOutcome>();
    const counters = await toilMinerTick(
      {
        db: makeRunsDb() as never,
        taskService: fakeTaskService() as never,
        cognitionProvider: NOOP_COGNITION_PROVIDER as never,
        taskSimilarityService: NOOP_SIMILARITY_SERVICE as never,
        ledgerService: fake.ledgerService,
        mineClustersFn: async () => ({ clusters, turnsScanned: 60628 }),
        analyzeClustersFn: async (_provider: unknown, candidates: readonly MinedCluster[]) => {
          for (const c of candidates) {
            analyzeOutcomes.set(c.signature, {
              proposedPrimitive: "x",
              existingToolCoverage: "y",
              alreadyCovered: false,
            });
          }
          return analyzeOutcomes;
        },
      },
      {}
    );

    expect(counters.clustersSentToLlm).toBe(1);
    expect(counters.proposalsGenerated).toBe(1);
    // The refined cluster's signature must differ from the generic Bash x2
    // signature — it never collides with (or clobbers) the parent's row.
    expect(fake.proposedCalls).toHaveLength(1);
    expect(fake.proposedCalls[0]).not.toBe("Bash-Bash-sig");
    // The other three maximal survivors are still excluded as generic.
    expect(fake.lowDistinctivenessCalls).toHaveLength(3);
  });
});
