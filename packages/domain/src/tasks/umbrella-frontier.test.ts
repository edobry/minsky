/**
 * Tests for the shared umbrella frontier (mt#4571).
 *
 * The interesting cases are the ones where "is this child blocked?" can go
 * wrong quietly: an unwired or unresolvable dependency, a child outside the
 * status filter, and a dependency that is itself a sibling. Each of those, read
 * the wrong way, produces a confident `ready: true` on blocked work — which
 * under the supervisor means dispatching it unattended.
 */
import { describe, test, expect } from "bun:test";
import { computeUmbrellaFrontier, type UmbrellaFrontierDeps } from "./umbrella-frontier";

interface FixtureTask {
  id: string;
  title?: string;
  status?: string;
  parent?: string;
  dependsOn?: string[];
}

function deps(tasks: FixtureTask[]): UmbrellaFrontierDeps & { getTasksCalls: string[][] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const getTasksCalls: string[][] = [];
  return {
    getTasksCalls,
    listChildren: async (parentTaskId) =>
      tasks.filter((t) => t.parent === parentTaskId).map((t) => t.id),
    getDependsRelationships: async (taskIds) => {
      const wanted = new Set(taskIds);
      const out: Array<{ fromTaskId: string; toTaskId: string }> = [];
      for (const t of tasks) {
        if (!wanted.has(t.id)) continue;
        for (const dep of t.dependsOn ?? []) out.push({ fromTaskId: t.id, toTaskId: dep });
      }
      return out;
    },
    getTasks: async (taskIds) => {
      getTasksCalls.push([...taskIds]);
      return taskIds
        .map((id) => byId.get(id))
        .filter((t): t is FixtureTask => t !== undefined)
        .map((t) => ({ id: t.id, title: t.title, status: t.status }));
    },
  };
}

describe("computeUmbrellaFrontier", () => {
  test("splits children into dispatchable and blocked by unmet dependency status", async () => {
    const d = deps([
      { id: "U", parent: undefined },
      { id: "A", title: "a", status: "READY", parent: "U" },
      { id: "B", title: "b", status: "READY", parent: "U", dependsOn: ["A"] },
    ]);

    const frontier = await computeUmbrellaFrontier("U", ["READY"], d);

    expect(frontier.dispatchable.map((c) => c.taskId)).toEqual(["A"]);
    expect(frontier.blocked.map((c) => c.taskId)).toEqual(["B"]);
    expect(frontier.blocked[0]?.blockedBy).toEqual(["A"]);
    expect(frontier.total).toBe(2);
  });

  test("a terminal dependency stops blocking", async () => {
    const d = deps([
      { id: "A", title: "a", status: "DONE", parent: "U" },
      { id: "B", title: "b", status: "READY", parent: "U", dependsOn: ["A"] },
    ]);

    const frontier = await computeUmbrellaFrontier("U", ["READY"], d);
    expect(frontier.dispatchable.map((c) => c.taskId)).toEqual(["B"]);
  });

  test("an UNRESOLVABLE dependency blocks rather than being treated as satisfied", async () => {
    // The alternative — "I could not read it, so assume it is done" — is the
    // exact false-positive that makes an unwired graph expensive: it dispatches
    // blocked work with nobody watching.
    const d = deps([{ id: "B", title: "b", status: "READY", parent: "U", dependsOn: ["GHOST"] }]);

    const frontier = await computeUmbrellaFrontier("U", ["READY"], d);
    expect(frontier.dispatchable).toEqual([]);
    expect(frontier.blocked[0]?.blockedBy).toEqual(["GHOST"]);
  });

  test("counts children outside the status filter separately from the considered set", async () => {
    const d = deps([
      { id: "A", title: "a", status: "READY", parent: "U" },
      { id: "B", title: "b", status: "DONE", parent: "U" },
      { id: "C", title: "c", status: "IN-REVIEW", parent: "U" },
    ]);

    const frontier = await computeUmbrellaFrontier("U", ["READY"], d);
    expect(frontier.total).toBe(1);
    expect(frontier.filteredOut).toBe(2);
  });

  test("a child whose task row is missing gets UNKNOWN status and is filtered out by default", async () => {
    const d = deps([{ id: "A", parent: "U" }]);
    // `A` exists as a child edge but the fixture gives it no status.
    const frontier = await computeUmbrellaFrontier("U", ["READY"], d);
    expect(frontier.total).toBe(0);
    expect(frontier.filteredOut).toBe(1);
  });

  test("returns an empty frontier for an umbrella with no children, without further reads", async () => {
    const d = deps([{ id: "A", status: "READY", parent: "OTHER" }]);
    const frontier = await computeUmbrellaFrontier("U", ["READY"], d);
    expect(frontier).toEqual({
      parentTaskId: "U",
      dispatchable: [],
      blocked: [],
      total: 0,
      filteredOut: 0,
    });
    expect(d.getTasksCalls).toEqual([]);
  });

  test("reads tasks in bulk — one call for the children, one for out-of-set dependencies", async () => {
    // The command this was extracted from issued one getTask per child plus one
    // per dependency edge. At a 60s sweeper cadence that is the N+1 shape
    // `efficient-database-queries.mdc` exists to prevent.
    const d = deps([
      { id: "A", title: "a", status: "READY", parent: "U", dependsOn: ["X"] },
      { id: "B", title: "b", status: "READY", parent: "U", dependsOn: ["Y"] },
      { id: "X", title: "x", status: "DONE" },
      { id: "Y", title: "y", status: "IN-PROGRESS" },
    ]);

    await computeUmbrellaFrontier("U", ["READY"], d);

    expect(d.getTasksCalls).toHaveLength(2);
    expect(d.getTasksCalls[0]).toEqual(["A", "B"]);
    expect([...(d.getTasksCalls[1] ?? [])].sort()).toEqual(["X", "Y"]);
  });

  test("a dependency that is also a sibling costs no extra read", async () => {
    const d = deps([
      { id: "A", title: "a", status: "READY", parent: "U" },
      { id: "B", title: "b", status: "READY", parent: "U", dependsOn: ["A"] },
    ]);

    await computeUmbrellaFrontier("U", ["READY"], d);
    // Only the children read — `A` was already resolved as a child.
    expect(d.getTasksCalls).toHaveLength(1);
  });
});
