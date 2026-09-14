import { describe, expect, test } from "bun:test";

import {
  buildAncestorLookup,
  hasIncidentLineage,
  isEmptyPointingQuery,
  isPointingCandidateRow,
  normalizePointingQuery,
  readinessOf,
  selectCandidates,
  taskMatchesPointingQuery,
  CANDIDATE_CAP_MAX,
  type CandidateSignals,
  type PointingTaskRow,
} from "./pointings";

const NOW_MS = Date.UTC(2026, 8, 13, 9, 0, 0);
const DAY_MS = 86_400_000;

function row(id: string, over: Partial<PointingTaskRow> = {}): PointingTaskRow {
  return {
    id,
    title: `Task ${id}`,
    status: "TODO",
    kind: "implementation",
    tags: [],
    parentId: null,
    updatedAtMs: NOW_MS - 3 * DAY_MS,
    originLine: null,
    origin: null,
    ...over,
  };
}

const noSignals: CandidateSignals = {
  dependsOn: new Map(),
  statusOf: new Map(),
  openDependents: new Map(),
};

describe("pointing queries", () => {
  test("normalize trims, dedupes, and drops empty fields", () => {
    const q = normalizePointingQuery({
      tags: [" cockpit ", "cockpit", ""],
      parentIds: [],
      taskIds: ["mt#1", " mt#1"],
    });
    expect(q).toEqual({ tags: ["cockpit"], taskIds: ["mt#1"] });
  });

  test("AT4: an empty query is refused", () => {
    expect(isEmptyPointingQuery({})).toBe(true);
    expect(isEmptyPointingQuery({ tags: [" "], parentIds: [], taskIds: [] })).toBe(true);
    expect(isEmptyPointingQuery({ tags: ["x"] })).toBe(false);
  });

  test("union semantics: any tag, any ancestor in the subtree, or an explicit id", () => {
    // mt#10 is a child of mt#1, which is a child of mt#0.
    const parentOf = new Map([
      ["mt#1", "mt#0"],
      ["mt#10", "mt#1"],
    ]);
    const ancestorsOf = buildAncestorLookup(parentOf);
    expect(ancestorsOf("mt#10")).toEqual(["mt#1", "mt#0"]);

    const byTag = row("mt#5", { tags: ["cockpit"] });
    const grandchild = row("mt#10");
    const explicit = row("mt#77");
    const stranger = row("mt#99", { tags: ["other"] });

    const query = { tags: ["cockpit"], parentIds: ["mt#0"], taskIds: ["mt#77"] };
    expect(taskMatchesPointingQuery(byTag, query, ancestorsOf)).toBe(true);
    expect(taskMatchesPointingQuery(grandchild, query, ancestorsOf)).toBe(true);
    expect(taskMatchesPointingQuery(explicit, query, ancestorsOf)).toBe(true);
    expect(taskMatchesPointingQuery(stranger, query, ancestorsOf)).toBe(false);
  });

  test("a parent cycle terminates the ancestor walk", () => {
    const parentOf = new Map([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(buildAncestorLookup(parentOf)("a")).toEqual(["b"]);
  });

  test("AT3: work packages, BLOCKED, and terminal rows are never candidates", () => {
    expect(isPointingCandidateRow(row("x", { kind: "work-package" }))).toBe(false);
    expect(isPointingCandidateRow(row("x", { status: "BLOCKED" }))).toBe(false);
    expect(isPointingCandidateRow(row("x", { status: "DONE" }))).toBe(false);
    expect(isPointingCandidateRow(row("x", { status: "CLOSED" }))).toBe(false);
    expect(isPointingCandidateRow(row("x", { status: "TODO" }))).toBe(true);
    expect(isPointingCandidateRow(row("x", { status: "IN-PROGRESS" }))).toBe(true);
  });
});

describe("candidate signals", () => {
  test("readiness matches tasks_available's formula: terminal deps over all deps, 1 with none", () => {
    const dependsOn = new Map<string, string[]>([
      ["mt#1", ["mt#a", "mt#b", "mt#c"]],
      ["mt#2", []],
    ]);
    const statusOf = new Map([
      ["mt#a", "DONE"],
      ["mt#b", "CLOSED"],
      ["mt#c", "TODO"],
    ]);
    expect(readinessOf("mt#1", dependsOn, statusOf)).toBeCloseTo(2 / 3, 10);
    expect(readinessOf("mt#2", dependsOn, statusOf)).toBe(1);
    expect(readinessOf("mt#none", dependsOn, statusOf)).toBe(1);
  });

  test("incident lineage is the tag or an Origin line, never free text", () => {
    expect(hasIncidentLineage(row("x", { tags: ["incident"] }))).toBe(true);
    expect(
      hasIncidentLineage(row("x", { originLine: "Origin: incident response (mt#4840)" }))
    ).toBe(true);
    expect(hasIncidentLineage(row("x", { originLine: "Origin: succession" }))).toBe(false);
    expect(hasIncidentLineage(row("x", { tags: ["cockpit"] }))).toBe(false);
  });
});

describe("selectCandidates", () => {
  test("AT1: caps at 10, reports matched and truncated, and labels the order arbitrary", () => {
    const matched = Array.from({ length: 25 }, (_, i) => row(`mt#${i}`));
    const set = selectCandidates(matched, noSignals, { seed: 1, nowMs: NOW_MS });
    expect(set.items).toHaveLength(CANDIDATE_CAP_MAX);
    expect(set.matched).toBe(25);
    expect(set.truncated).toBe(true);
    expect(set.ordering).toBe("arbitrary");
  });

  test("AT1: two seeds yield the same id set in different orders", () => {
    const matched = Array.from({ length: 10 }, (_, i) => row(`mt#${i}`));
    const a = selectCandidates(matched, noSignals, { seed: 1, nowMs: NOW_MS, cap: 10 });
    const b = selectCandidates(matched, noSignals, { seed: 2, nowMs: NOW_MS, cap: 10 });
    const idsA = a.items.map((i) => i.id);
    const idsB = b.items.map((i) => i.id);
    expect([...idsA].sort()).toEqual([...idsB].sort());
    expect(idsA).not.toEqual(idsB);
  });

  test("AT2: the four flags are computed per item", () => {
    const matched = [
      row("mt#1", { updatedAtMs: NOW_MS - 12 * DAY_MS }),
      row("mt#2", { tags: ["incident"] }),
      row("mt#3"),
    ];
    const signals: CandidateSignals = {
      dependsOn: new Map([["mt#1", ["mt#d1", "mt#d2"]]]),
      statusOf: new Map([
        ["mt#d1", "DONE"],
        ["mt#d2", "TODO"],
      ]),
      openDependents: new Map([["mt#3", 2]]),
    };
    const set = selectCandidates(matched, signals, { seed: 7, nowMs: NOW_MS, cap: 10 });
    const byId = new Map(set.items.map((i) => [i.id, i]));
    expect(byId.get("mt#1")?.readiness).toBe(0.5);
    expect(byId.get("mt#1")?.daysSinceTouched).toBe(12);
    expect(byId.get("mt#2")?.incidentLineage).toBe(true);
    expect(byId.get("mt#3")?.unblockCount).toBe(2);
    expect(byId.get("mt#3")?.readiness).toBe(1);
    expect(set.truncated).toBe(false);
    expect(set.matched).toBe(3);
  });

  test("an empty match returns an empty set, not an error — the RFC's 'pointing is done' signal", () => {
    const set = selectCandidates([], noSignals, { seed: 1, nowMs: NOW_MS });
    expect(set.items).toEqual([]);
    expect(set.matched).toBe(0);
    expect(set.truncated).toBe(false);
  });

  test("no field named score, rank, or priority appears on an item", () => {
    const set = selectCandidates([row("mt#1")], noSignals, { seed: 1, nowMs: NOW_MS });
    const keys = Object.keys(set.items[0] ?? {});
    expect(keys.some((k) => /score|rank|priority/i.test(k))).toBe(false);
  });

  test("the cap is clamped to the maximum", () => {
    const matched = Array.from({ length: 15 }, (_, i) => row(`mt#${i}`));
    const set = selectCandidates(matched, noSignals, { seed: 1, nowMs: NOW_MS, cap: 50 });
    expect(set.cap).toBe(CANDIDATE_CAP_MAX);
    expect(set.items).toHaveLength(CANDIDATE_CAP_MAX);
  });
});
