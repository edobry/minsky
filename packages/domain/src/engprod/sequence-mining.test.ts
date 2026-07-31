/**
 * Tests for stage-1 deterministic mining (mt#3330).
 *
 * Fake DB mirrors the single query shape `mineClusters` issues:
 *   select({...}).from(t).where(timestamp >= since).orderBy(session, turn, ordinal)
 * Mirrors the "ignore the opaque WHERE object, derive from seed state"
 * convention in title-pipeline.test.ts.
 */

import { describe, test, expect } from "bun:test";
import { computeClusterSignature, mineClusters, selectTopClusters } from "./sequence-mining";
import type { MinedCluster } from "./types";

interface SeedRow {
  agentSessionId: string;
  turnIndex: number;
  ordinal: number;
  toolName: string;
  timestamp: Date;
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

function row(sessionId: string, turnIndex: number, ordinal: number, toolName: string): SeedRow {
  return { agentSessionId: sessionId, turnIndex, ordinal, toolName, timestamp: new Date() };
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
