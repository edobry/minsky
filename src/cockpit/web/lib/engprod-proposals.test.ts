/**
 * Tests for the pure EngProd proposal-digest derivation (mt#3331):
 * disposition, run assignment, grouping/ranking, and the healthy-vs-errored
 * empty-run distinction (spec SC3 / AT2).
 */
import { describe, test, expect } from "bun:test";
import {
  deriveDisposition,
  assignRun,
  groupProposalsByRun,
  runEmptyState,
  type EngprodRunSummary,
  type EngprodProposalRow,
} from "./engprod-proposals";

function run(overrides: Partial<EngprodRunSummary> = {}): EngprodRunSummary {
  return {
    id: "run-1",
    startedAt: "2026-07-31T01:30:01.000Z",
    finishedAt: "2026-07-31T01:30:20.000Z",
    turnsScanned: 100,
    clustersFound: 10,
    clustersSentToLlm: 5,
    proposalsGenerated: 2,
    suppressedByDedupe: 0,
    suppressedByBudget: 0,
    suppressedByMaximalCollapse: 0,
    suppressedByLowDistinctiveness: 0,
    llmErrors: 0,
    errored: false,
    ...overrides,
  };
}

function proposal(overrides: Partial<EngprodProposalRow> = {}): EngprodProposalRow {
  return {
    taskId: "mt#1",
    title: "EngProd proposal: Bash -> Bash",
    status: "BLOCKED",
    clusterSignature: "sig-1",
    toolSequence: ["Bash", "Bash"],
    evidenceFrequency: 100,
    evidenceSessions: 50,
    evidenceChainLength: 2,
    score: 10000,
    rejectionReason: null,
    createdAt: "2026-07-31T01:30:10.000Z",
    ...overrides,
  };
}

describe("deriveDisposition", () => {
  test("BLOCKED -> pending", () => {
    expect(deriveDisposition("BLOCKED")).toBe("pending");
  });
  test("CLOSED -> rejected", () => {
    expect(deriveDisposition("CLOSED")).toBe("rejected");
  });
  test("TODO -> accepted (left BLOCKED = accepted, per decideReconciliation)", () => {
    expect(deriveDisposition("TODO")).toBe("accepted");
  });
  test("DONE -> accepted", () => {
    expect(deriveDisposition("DONE")).toBe("accepted");
  });
});

describe("assignRun", () => {
  test("assigns a proposal whose createdAt falls inside a run's window", () => {
    const r = run({
      startedAt: "2026-07-31T01:30:01.000Z",
      finishedAt: "2026-07-31T01:30:20.000Z",
    });
    const assigned = assignRun("2026-07-31T01:30:10.000Z", [r]);
    expect(assigned?.id).toBe("run-1");
  });

  test("returns null for a createdAt before every run's startedAt (mt#3419 case: an untracked, presumably-crashed tick)", () => {
    const r = run({
      startedAt: "2026-07-31T01:30:01.000Z",
      finishedAt: "2026-07-31T01:30:20.000Z",
    });
    const assigned = assignRun("2026-07-31T01:29:30.000Z", [r]);
    expect(assigned).toBeNull();
  });

  test("treats a null finishedAt as still-open (+Infinity)", () => {
    const r = run({ startedAt: "2026-07-31T01:30:01.000Z", finishedAt: null });
    const assigned = assignRun("2026-07-31T05:00:00.000Z", [r]);
    expect(assigned?.id).toBe("run-1");
  });

  test("picks the run with the latest startedAt when windows overlap", () => {
    const early = run({
      id: "early",
      startedAt: "2026-07-31T01:00:00.000Z",
      finishedAt: "2026-07-31T02:00:00.000Z",
    });
    const late = run({
      id: "late",
      startedAt: "2026-07-31T01:30:00.000Z",
      finishedAt: "2026-07-31T01:45:00.000Z",
    });
    const assigned = assignRun("2026-07-31T01:35:00.000Z", [early, late]);
    expect(assigned?.id).toBe("late");
  });
});

describe("groupProposalsByRun", () => {
  test("groups proposals into their assigned run and sorts runs most-recent-first", () => {
    const runA = run({
      id: "a",
      startedAt: "2026-07-31T01:00:00.000Z",
      finishedAt: "2026-07-31T01:10:00.000Z",
    });
    const runB = run({
      id: "b",
      startedAt: "2026-07-31T06:00:00.000Z",
      finishedAt: "2026-07-31T06:10:00.000Z",
    });
    const p1 = proposal({ taskId: "mt#1", createdAt: "2026-07-31T01:05:00.000Z" });
    const p2 = proposal({ taskId: "mt#2", createdAt: "2026-07-31T06:05:00.000Z" });

    const groups = groupProposalsByRun([runA, runB], [p1, p2]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.run?.id).toBe("b"); // most recent run first
    expect(groups[0]?.proposals.map((p) => p.taskId)).toEqual(["mt#2"]);
    expect(groups[1]?.run?.id).toBe("a");
    expect(groups[1]?.proposals.map((p) => p.taskId)).toEqual(["mt#1"]);
  });

  test("every run appears even with zero assigned proposals (AT2: run-level context always visible)", () => {
    const runA = run({ id: "a", proposalsGenerated: 0 });
    const groups = groupProposalsByRun([runA], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.run?.id).toBe("a");
    expect(groups[0]?.proposals).toEqual([]);
  });

  test("proposals matching no run window land in a trailing unassigned bucket (run: null)", () => {
    const runA = run({
      id: "a",
      startedAt: "2026-07-31T06:00:00.000Z",
      finishedAt: "2026-07-31T06:10:00.000Z",
    });
    const orphan = proposal({ taskId: "mt#3419", createdAt: "2026-07-31T01:29:30.000Z" });
    const groups = groupProposalsByRun([runA], [orphan]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.run?.id).toBe("a");
    expect(groups[1]?.run).toBeNull();
    expect(groups[1]?.proposals.map((p) => p.taskId)).toEqual(["mt#3419"]);
  });

  test("ranks proposals within a run by score descending", () => {
    const runA = run({ id: "a" });
    const low = proposal({ taskId: "mt#low", score: 100, createdAt: "2026-07-31T01:30:11.000Z" });
    const high = proposal({
      taskId: "mt#high",
      score: 9999,
      createdAt: "2026-07-31T01:30:12.000Z",
    });
    const groups = groupProposalsByRun([runA], [low, high]);
    expect(groups[0]?.proposals.map((p) => p.taskId)).toEqual(["mt#high", "mt#low"]);
  });

  test("empty runs and empty proposals -> empty groups", () => {
    expect(groupProposalsByRun([], [])).toEqual([]);
  });
});

describe("runEmptyState (AT2: healthy-empty vs errored)", () => {
  test("a run with proposals has no empty-state framing", () => {
    expect(runEmptyState(run({ proposalsGenerated: 5 }))).toBeNull();
  });

  test("zero proposals + no errors -> healthy-empty", () => {
    expect(runEmptyState(run({ proposalsGenerated: 0, errored: false, llmErrors: 0 }))).toBe(
      "healthy-empty"
    );
  });

  test("zero proposals + errored flag -> errored", () => {
    expect(runEmptyState(run({ proposalsGenerated: 0, errored: true }))).toBe("errored");
  });

  test("zero proposals + llmErrors > 0 -> errored, even if errored flag is false", () => {
    expect(runEmptyState(run({ proposalsGenerated: 0, errored: false, llmErrors: 3 }))).toBe(
      "errored"
    );
  });
});
