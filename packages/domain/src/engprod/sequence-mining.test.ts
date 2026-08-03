/**
 * Tests for stage-1 deterministic mining (mt#3330).
 *
 * Fake DB mirrors the single query shape `mineClusters` issues:
 *   select({...}).from(t).where(timestamp >= since).orderBy(session, turn, ordinal)
 * Mirrors the "ignore the opaque WHERE object, derive from seed state"
 * convention in title-pipeline.test.ts.
 */

import { describe, test, expect } from "bun:test";
import {
  computeClusterSignature,
  mineClusters,
  selectTopClusters,
  collapseToMaximalClusters,
} from "./sequence-mining";
import {
  refineCluster,
  DEFAULT_FINGERPRINT_CONCENTRATION_THRESHOLD,
} from "./fingerprint-refinement";
import type { MinedCluster } from "./types";

interface SeedRow {
  agentSessionId: string;
  turnIndex: number;
  ordinal: number;
  toolName: string;
  timestamp: Date;
  argFingerprint: string;
}

function makeDb(seed: SeedRow[], opts: { failSelect?: boolean } = {}) {
  return {
    select(_fields?: Record<string, unknown>) {
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown) => ({
            orderBy: (..._cols: unknown[]) => {
              if (opts.failSelect) return Promise.reject(new Error("db down"));
              const sorted = [...seed].sort((a, b) => {
                if (a.agentSessionId !== b.agentSessionId) {
                  return a.agentSessionId < b.agentSessionId ? -1 : 1;
                }
                if (a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
                return a.ordinal - b.ordinal;
              });
              return Promise.resolve(sorted);
            },
          }),
        }),
      };
    },
  };
}

function row(
  sessionId: string,
  turnIndex: number,
  ordinal: number,
  toolName: string,
  argFingerprint = "fp-default"
): SeedRow {
  return {
    agentSessionId: sessionId,
    turnIndex,
    ordinal,
    toolName,
    timestamp: new Date(),
    argFingerprint,
  };
}

describe("computeClusterSignature", () => {
  test("is deterministic for the same sequence", () => {
    const a = computeClusterSignature(["Read", "Edit", "Bash"]);
    const b = computeClusterSignature(["Read", "Edit", "Bash"]);
    expect(a).toBe(b);
  });

  test("differs for different sequences", () => {
    const a = computeClusterSignature(["Read", "Edit", "Bash"]);
    const b = computeClusterSignature(["Read", "Bash", "Edit"]);
    expect(a).not.toBe(b);
  });

  test("differs for different chain lengths of the same prefix", () => {
    const a = computeClusterSignature(["Read", "Edit"]);
    const b = computeClusterSignature(["Read", "Edit", "Bash"]);
    expect(a).not.toBe(b);
  });
});

describe("mineClusters", () => {
  test("finds a recurring 2-gram across sessions meeting default thresholds", async () => {
    // "Read -> Edit" repeats 3x across 2 sessions (default min: freq>=3, sessions>=2).
    const seed: SeedRow[] = [
      row("s1", 0, 0, "Read"),
      row("s1", 1, 0, "Edit"),
      row("s1", 2, 0, "Bash"),
      row("s2", 0, 0, "Read"),
      row("s2", 1, 0, "Edit"),
      row("s3", 0, 0, "Read"),
      row("s3", 1, 0, "Edit"),
    ];
    const db = makeDb(seed);
    const result = await mineClusters(db as unknown as Parameters<typeof mineClusters>[0], {
      minChainLength: 2,
      maxChainLength: 3,
      minFrequency: 3,
      minSessions: 2,
    });

    const readEdit = result.clusters.find((c) => c.toolSequence.join(",") === "Read,Edit");
    expect(readEdit).toBeDefined();
    expect(readEdit?.frequency).toBe(3);
    expect(readEdit?.sessionCount).toBe(3);
    expect(readEdit?.chainLength).toBe(2);
    expect(readEdit?.score).toBe(3 * 3 * 2);
  });

  test("excludes clusters below the frequency/session thresholds", async () => {
    // "Bash -> Agent" occurs only once — below default minFrequency (3).
    const seed: SeedRow[] = [row("s1", 0, 0, "Bash"), row("s1", 1, 0, "Agent")];
    const db = makeDb(seed);
    const result = await mineClusters(db as unknown as Parameters<typeof mineClusters>[0], {
      minChainLength: 2,
      maxChainLength: 2,
    });
    expect(result.clusters).toHaveLength(0);
  });

  test("turnsScanned counts distinct (session, turn) pairs, not tool-call rows", async () => {
    // Two tool calls in the SAME turn (ordinal 0 and 1) — one turn.
    const seed: SeedRow[] = [row("s1", 0, 0, "Read"), row("s1", 0, 1, "Edit")];
    const db = makeDb(seed);
    const result = await mineClusters(db as unknown as Parameters<typeof mineClusters>[0]);
    expect(result.turnsScanned).toBe(1);
  });

  test("fails open (empty result) on a query error, never throws", async () => {
    const db = makeDb([], { failSelect: true });
    const result = await mineClusters(db as unknown as Parameters<typeof mineClusters>[0]);
    expect(result.clusters).toEqual([]);
    expect(result.turnsScanned).toBe(0);
  });

  test("is deterministic across repeated runs on the same input", async () => {
    const seed: SeedRow[] = [
      row("s1", 0, 0, "Read"),
      row("s1", 1, 0, "Edit"),
      row("s2", 0, 0, "Read"),
      row("s2", 1, 0, "Edit"),
      row("s3", 0, 0, "Read"),
      row("s3", 1, 0, "Edit"),
    ];
    const opts = { minChainLength: 2, maxChainLength: 2, minFrequency: 3, minSessions: 2 };
    const first = await mineClusters(
      makeDb(seed) as unknown as Parameters<typeof mineClusters>[0],
      opts
    );
    const second = await mineClusters(
      makeDb(seed) as unknown as Parameters<typeof mineClusters>[0],
      opts
    );
    expect(first.clusters.map((c) => c.signature)).toEqual(second.clusters.map((c) => c.signature));
    expect(first.clusters.map((c) => c.score)).toEqual(second.clusters.map((c) => c.score));
  });
});

describe("selectTopClusters", () => {
  function cluster(toolSequence: string[], score: number): MinedCluster {
    return {
      signature: computeClusterSignature(toolSequence),
      toolSequence,
      frequency: score,
      sessionCount: 1,
      chainLength: toolSequence.length,
      score,
      sampleRefs: [],
    };
  }

  test("caps the result at the requested count", () => {
    const clusters = [cluster(["A"], 10), cluster(["B"], 9), cluster(["C"], 8)];
    expect(selectTopClusters(clusters, 2)).toHaveLength(2);
  });

  test("skips a candidate that is a contiguous subsequence of an already-selected cluster", () => {
    const longer = cluster(["Read", "Edit", "Bash"], 100);
    const sub = cluster(["Read", "Edit"], 50); // contiguous subsequence of `longer`
    const unrelated = cluster(["Agent", "Write"], 40);
    const selected = selectTopClusters([longer, sub, unrelated], 3);
    expect(selected.map((c) => c.toolSequence.join(","))).toEqual([
      "Read,Edit,Bash",
      "Agent,Write",
    ]);
  });

  test("keeps two non-overlapping clusters of equal rank", () => {
    const a = cluster(["Read", "Edit"], 10);
    const b = cluster(["Bash", "Agent"], 10);
    const selected = selectTopClusters([a, b], 2);
    expect(selected).toHaveLength(2);
  });
});

describe("mineClusters — fingerprint profile (mt#3429 SC2)", () => {
  test("computes a high-concentration profile when the same fingerprint sequence dominates", async () => {
    // "git status -> git diff" (same fingerprints) repeats 4x; one noisy
    // occurrence has different fingerprints. Concentration should be 4/5.
    const seed: SeedRow[] = [
      row("s1", 0, 0, "Bash", "fp:git-status"),
      row("s1", 1, 0, "Bash", "fp:git-diff"),
      row("s2", 0, 0, "Bash", "fp:git-status"),
      row("s2", 1, 0, "Bash", "fp:git-diff"),
      row("s3", 0, 0, "Bash", "fp:git-status"),
      row("s3", 1, 0, "Bash", "fp:git-diff"),
      row("s4", 0, 0, "Bash", "fp:git-status"),
      row("s4", 1, 0, "Bash", "fp:git-diff"),
      row("s5", 0, 0, "Bash", "fp:ls-la"),
      row("s5", 1, 0, "Bash", "fp:cat-file"),
    ];
    const result = await mineClusters(
      makeDb(seed) as unknown as Parameters<typeof mineClusters>[0],
      {
        minChainLength: 2,
        maxChainLength: 2,
        minFrequency: 3,
        minSessions: 2,
      }
    );

    const bashBash = result.clusters.find((c) => c.toolSequence.join(",") === "Bash,Bash");
    expect(bashBash).toBeDefined();
    expect(bashBash?.frequency).toBe(5);
    expect(bashBash?.fingerprintProfile?.sequence).toEqual(["fp:git-status", "fp:git-diff"]);
    expect(bashBash?.fingerprintProfile?.frequency).toBe(4);
    expect(bashBash?.fingerprintProfile?.sessionCount).toBe(4);
    expect(bashBash?.fingerprintProfile?.concentration).toBeCloseTo(4 / 5);
  });

  test("computes a low-concentration profile when fingerprints are uniformly diverse", async () => {
    const seed: SeedRow[] = [
      row("s1", 0, 0, "Bash", "fp:a"),
      row("s1", 1, 0, "Bash", "fp:b"),
      row("s2", 0, 0, "Bash", "fp:c"),
      row("s2", 1, 0, "Bash", "fp:d"),
      row("s3", 0, 0, "Bash", "fp:e"),
      row("s3", 1, 0, "Bash", "fp:f"),
    ];
    const result = await mineClusters(
      makeDb(seed) as unknown as Parameters<typeof mineClusters>[0],
      {
        minChainLength: 2,
        maxChainLength: 2,
        minFrequency: 3,
        minSessions: 2,
      }
    );

    const bashBash = result.clusters.find((c) => c.toolSequence.join(",") === "Bash,Bash");
    expect(bashBash?.frequency).toBe(3);
    // No fingerprint sequence repeats — top group covers exactly 1 occurrence.
    expect(bashBash?.fingerprintProfile?.frequency).toBe(1);
    expect(bashBash?.fingerprintProfile?.concentration).toBeCloseTo(1 / 3);
  });

  test("sampleRefs carry the concrete per-position fingerprints for that occurrence", async () => {
    const seed: SeedRow[] = [
      row("s1", 0, 0, "Read", "fp:file-a"),
      row("s1", 1, 0, "Edit", "fp:edit-a"),
      row("s2", 0, 0, "Read", "fp:file-b"),
      row("s2", 1, 0, "Edit", "fp:edit-b"),
      row("s3", 0, 0, "Read", "fp:file-c"),
      row("s3", 1, 0, "Edit", "fp:edit-c"),
    ];
    const result = await mineClusters(
      makeDb(seed) as unknown as Parameters<typeof mineClusters>[0],
      {
        minChainLength: 2,
        maxChainLength: 2,
        minFrequency: 3,
        minSessions: 2,
      }
    );
    const readEdit = result.clusters.find((c) => c.toolSequence.join(",") === "Read,Edit");
    expect(readEdit?.sampleRefs.length).toBeGreaterThan(0);
    for (const ref of readEdit?.sampleRefs ?? []) {
      expect(ref.argFingerprints).toHaveLength(2);
    }
  });
});

describe("collapseToMaximalClusters (mt#3429 SC1)", () => {
  function cluster(toolSequence: string[], frequency: number, sessionCount: number): MinedCluster {
    const chainLength = toolSequence.length;
    return {
      signature: computeClusterSignature(toolSequence),
      toolSequence,
      frequency,
      sessionCount,
      chainLength,
      score: frequency * sessionCount * chainLength,
      sampleRefs: [],
    };
  }

  test(
    "collapses a nested Bash-repeat family to its single highest-ranked member " +
      "(production fixture: v1's Bash x2..x6 five-way split, mt#3419/3420/3421/3423/3425)",
    () => {
      // Mirrors the ACTUAL v1 production gate-run numbers (mt#3330 Outcome):
      // shorter members score highest because n-gram frequency is
      // anti-monotonic in chain length — this is exactly the shape v1's
      // one-directional selectTopClusters failed to collapse.
      const bash2 = cluster(["Bash", "Bash"], 6628, 407); // score 5,394,992 (highest)
      const bash3 = cluster(["Bash", "Bash", "Bash"], 4117, 353); // 4,359,903
      const bash4 = cluster(["Bash", "Bash", "Bash", "Bash"], 2772, 291); // 3,226,608
      const bash5 = cluster(["Bash", "Bash", "Bash", "Bash", "Bash"], 1966, 231); // 2,270,730
      const bash6 = cluster(["Bash", "Bash", "Bash", "Bash", "Bash", "Bash"], 1447, 190); // 1,649,580 (lowest)
      const clusters = [bash2, bash3, bash4, bash5, bash6].sort((a, b) => b.score - a.score);

      const { maximal, suppressed } = collapseToMaximalClusters(clusters);

      expect(maximal).toHaveLength(1);
      expect(maximal[0]?.signature).toBe(bash2.signature);
      expect(suppressed).toHaveLength(4);
      for (const { cluster: suppressedCluster, supersededBy } of suppressed) {
        expect(supersededBy.signature).toBe(bash2.signature);
        expect([bash3, bash4, bash5, bash6].map((c) => c.signature)).toContain(
          suppressedCluster.signature
        );
      }
    }
  );

  test("collapses a second, independent nested family in the same run (session_exec x2..x4)", () => {
    const bash2 = cluster(["Bash", "Bash"], 6628, 407);
    const sessionExec2 = cluster(["session_exec", "session_exec"], 4427, 299);
    const sessionExec3 = cluster(["session_exec", "session_exec", "session_exec"], 2293, 249);
    const sessionExec4 = cluster(
      ["session_exec", "session_exec", "session_exec", "session_exec"],
      1335,
      197
    );
    const bashRead = cluster(["Bash", "Read"], 2057, 347);
    const readRead = cluster(["Read", "Read"], 1773, 315);
    const clusters = [bash2, sessionExec2, sessionExec3, sessionExec4, bashRead, readRead].sort(
      (a, b) => b.score - a.score
    );

    const { maximal, suppressed } = collapseToMaximalClusters(clusters);

    const maximalSignatures = maximal.map((c) => c.signature).sort();
    expect(maximalSignatures).toEqual(
      [bash2, sessionExec2, bashRead, readRead].map((c) => c.signature).sort()
    );
    expect(suppressed).toHaveLength(2); // sessionExec3, sessionExec4
    for (const { supersededBy } of suppressed) {
      expect(supersededBy.signature).toBe(sessionExec2.signature);
    }
  });

  test("does not collapse two distinct same-length sequences", () => {
    const readEdit = cluster(["Read", "Edit"], 10, 5);
    const bashAgent = cluster(["Bash", "Agent"], 10, 5);
    const { maximal, suppressed } = collapseToMaximalClusters([readEdit, bashAgent]);
    expect(maximal).toHaveLength(2);
    expect(suppressed).toHaveLength(0);
  });

  test("also collapses the easy case: a longer sequence scoring higher than its sub-sequence", () => {
    const longer = cluster(["Read", "Edit", "Bash"], 100, 10);
    const sub = cluster(["Read", "Edit"], 50, 5);
    const { maximal, suppressed } = collapseToMaximalClusters([longer, sub]);
    expect(maximal.map((c) => c.signature)).toEqual([longer.signature]);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.supersededBy.signature).toBe(longer.signature);
  });

  test(
    "mt#3432 AT1: collapses + refines a >=10k synthetic cluster population (worst-case " +
      "shape) in bounded time — guards against a reintroduced O(n^2) blowup",
    () => {
      // Worst case for collapseToMaximalClusters: every cluster carries a
      // UNIQUE tool-name vocabulary per position, so essentially none
      // nests inside another — the `maximal` list grows close to n and
      // every candidate is compared against nearly all prior survivors.
      // Measured against this exact shape during mt#3432 profiling:
      // ~1.4s for 12,704 clusters (all becoming maximal). That measured
      // cost, and the identical live-corpus run (12,694 real clusters,
      // collapse=49ms), together falsify mt#3432's hypothesis 1 as the
      // actual cause of the reported 25min+ hang — see
      // toil-miner-tick.ts's docstring for the real root cause (N
      // sequential per-cluster ledger writes, now batched). This test
      // still guards the O(n^2) CPU shape of collapse+refinement
      // independently of that fix, per this task's AT1.
      const N = 12704;
      const clusters: MinedCluster[] = [];
      for (let i = 0; i < N; i++) {
        const len = 2 + (i % 5); // 2..6
        const toolSequence = Array.from({ length: len }, (_, j) => `tok${i}_${j}`);
        clusters.push({
          signature: computeClusterSignature(toolSequence),
          toolSequence,
          frequency: N - i,
          sessionCount: N - i,
          chainLength: len,
          score: (N - i) * (N - i) * len,
          sampleRefs: [],
          fingerprintProfile: {
            sequence: toolSequence.map((t, j) => `fp:${t}:${j}`),
            frequency: Math.max(1, Math.floor((N - i) * 0.1)),
            sessionCount: Math.max(1, Math.floor((N - i) * 0.1)),
            concentration: 0.1,
            sampleRefs: [],
          },
        });
      }

      const { maximal, suppressed, comparisons } = collapseToMaximalClusters(clusters);
      let refinedCount = 0;
      let excludedCount = 0;
      for (const c of maximal) {
        const outcome = refineCluster(c, DEFAULT_FINGERPRINT_CONCENTRATION_THRESHOLD);
        if (outcome.kind === "excluded") excludedCount++;
        else refinedCount++;
      }

      // Every candidate accounted for — collapse never silently drops one.
      expect(maximal.length + suppressed.length).toBe(N);
      expect(refinedCount + excludedCount).toBe(maximal.length);

      // The complexity signal, asserted directly (mt#3494).
      //
      // This assertion replaces `expect(elapsed).toBeLessThan(10000)`. That
      // bound measured the HOST as much as the algorithm: this exact fixture
      // was observed at 1406ms and 5032ms in two runs minutes apart on one
      // idle machine, and at ~10.3-10.6s inside the full 769-file suite —
      // tripping the 10s bound and failing the fail-closed pre-push gate on
      // branches that touch nothing near this code. A count is a function of
      // the input alone: same clusters, same number, every machine, every
      // load, standalone or in-suite.
      //
      // Shape of THIS fixture: every cluster carries a unique token
      // vocabulary, so nothing nests, nothing is suppressed, and `maximal`
      // grows to N. That is the genuine worst case, and it pins the count
      // exactly — each candidate is compared against every already-kept
      // cluster and nothing more, so the loop performs precisely N(N-1)/2
      // comparisons. Any redundant re-scan (a second pass, a lost
      // short-circuit on a shape where matches DO occur, a nested loop added
      // above this one) moves the number off this value.
      expect(suppressed.length).toBe(0);
      expect(maximal.length).toBe(N);
      expect(comparisons).toBe((N * (N - 1)) / 2);
    },
    20000
  );

  test("mt#3494: the collapse scan short-circuits on the first match — comparisons stay bounded by N x |maximal| when clusters DO nest", () => {
    // The companion to the worst-case fixture above. There, nothing nests, so
    // the short-circuit never fires and its loss would be invisible. Here most
    // candidates ARE suppressed — the shape the live corpus actually has
    // (mt#3432 measured ~11,220 suppressions of 12,694 real clusters) — so the
    // early exit is load-bearing and its removal is observable.
    const N = 12704;
    const FAMILIES = 50;
    const clusters: MinedCluster[] = [];
    for (let i = 0; i < N; i++) {
      const fam = i % FAMILIES;
      // The first FAMILIES entries are long family heads; every later cluster
      // is a prefix of its family's head, so it nests and is suppressed.
      const len = i < FAMILIES ? 6 : 2 + (i % 4);
      const toolSequence = Array.from({ length: len }, (_, j) => `fam${fam}_${j}`);
      clusters.push({
        signature: computeClusterSignature(toolSequence),
        toolSequence,
        frequency: N - i,
        sessionCount: N - i,
        chainLength: len,
        score: (N - i) * (N - i) * len,
        sampleRefs: [],
        fingerprintProfile: {
          sequence: toolSequence.map((t, j) => `fp:${t}:${j}`),
          frequency: Math.max(1, Math.floor((N - i) * 0.1)),
          sessionCount: Math.max(1, Math.floor((N - i) * 0.1)),
          concentration: 0.1,
          sampleRefs: [],
        },
      });
    }

    const { maximal, suppressed, comparisons } = collapseToMaximalClusters(clusters);

    // Collapse actually collapsed: one survivor per family.
    expect(maximal.length).toBe(FAMILIES);
    expect(suppressed.length).toBe(N - FAMILIES);

    // Exact expected count, derived from the fixture's structure rather than
    // picked as a threshold.
    //
    // Family heads are inserted into `maximal` in family order, so candidate i
    // (i >= FAMILIES) finds its head at index i % FAMILIES and stops there —
    // costing (i % FAMILIES) + 1 comparisons. Head j itself scans the j heads
    // already kept, matching none, costing j.
    //
    //   heads:      sum(j for j in 0..49)                      =   1,225
    //   candidates: 253 whole cycles x sum(k+1 for k in 0..49)
    //               = 253 x 1,275                              = 322,575
    //               + 4 leftover candidates (k = 0..3)         =      10
    //                                                            -------
    //                                                            323,810
    //
    // Asserting the exact value rather than an upper bound is what makes this
    // a guard: removing the `break` makes each of the 12,654 suppressed
    // candidates scan all 50 survivors, giving 12,654 x 50 + 1,225 = 633,925.
    // Verified by running it both ways (mt#3494).
    const HEAD_SCANS = (FAMILIES * (FAMILIES - 1)) / 2;
    expect(comparisons).toBe(323810);
    expect(comparisons).toBeLessThan(N * FAMILIES + HEAD_SCANS);
  }, 20000);
});
