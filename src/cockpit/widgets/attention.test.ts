/**
 * Attention-widget cohort tests (mt#4313).
 *
 * Covers the no-active-window fallback, which read `suspended` only. Once the
 * reaper actually runs, a woken ask sits in `routed` from the moment its window
 * opens until it is answered — and windows are open 30-60 minutes a day, so
 * this branch is what the operator sees almost all the time.
 */
import { describe, expect, test } from "bun:test";
import type { Ask } from "@minsky/domain/ask/types";
import type { AskRepository } from "@minsky/domain/ask/repository";
import type { ProjectScope } from "@minsky/domain/project/scope";
import { loadCohort, pendingOperatorAsks } from "./attention";

function ask(overrides: Partial<Ask> & Pick<Ask, "id" | "state">): Ask {
  return {
    kind: "direction.decide",
    routingTarget: "operator",
    title: `ask ${overrides.id}`,
    createdAt: new Date("2026-08-20T00:00:00.000Z").toISOString(),
    ...overrides,
  } as Ask;
}

/** A repository that answers `listByState` from a fixed set and nothing else. */
function repoWith(asks: Ask[]): AskRepository {
  return {
    listByState: async (state: string) => asks.filter((a) => a.state === state),
  } as unknown as AskRepository;
}

/**
 * A repository whose `listByState` respects `projectScope` — the two-project
 * fixture for mt#4727's `loadCohort(repo, windowKey, projectScope)` param.
 * Each fixture ask carries a `projectId` (a field this fake's asks add
 * on top of the base `Ask` shape; the real `AskRepository` implementations
 * filter on the underlying `asks.project_id` column the same way).
 */
function projectScopedRepoWith(asks: Array<Ask & { projectId: string }>): AskRepository {
  return {
    listByState: async (state: string, projectScope?: ProjectScope) => {
      const byState = asks.filter((a) => a.state === state);
      if (projectScope === undefined) return byState;
      return byState.filter((a) => a.projectId === projectScope);
    },
  } as unknown as AskRepository;
}

describe("loadCohort — no active window", () => {
  test("includes an operator ask the reaper has woken to routed", async () => {
    const repo = repoWith([
      ask({ id: "woken", state: "routed" }),
      ask({ id: "waiting", state: "suspended" }),
    ]);

    const cohort = await loadCohort(repo, null);

    expect(cohort.map((a) => a.id).sort()).toEqual(["waiting", "woken"]);
  });

  test("still returns suspended asks when nothing has been woken", async () => {
    const repo = repoWith([ask({ id: "waiting", state: "suspended" })]);

    const cohort = await loadCohort(repo, null);

    expect(cohort.map((a) => a.id)).toEqual(["waiting"]);
  });

  test("excludes asks routed somewhere other than the operator", async () => {
    const repo = repoWith([
      ask({ id: "subagent", state: "routed", routingTarget: "subagent" }),
      ask({ id: "mine", state: "routed" }),
    ]);

    const cohort = await loadCohort(repo, null);

    expect(cohort.map((a) => a.id)).toEqual(["mine"]);
  });
});

/**
 * Two-project fixture for the `projectScope` param threaded through
 * `loadCohort` (mt#4727) — both the no-active-window fallback and the
 * active-window `pendingAsksForWindow` path.
 */
describe("loadCohort — project-scope wiring (mt#4727)", () => {
  const PROJECT_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROJECT_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  function twoProjectFixture(): Array<Ask & { projectId: string }> {
    return [
      { ...ask({ id: "a-suspended", state: "suspended" }), projectId: PROJECT_A_ID },
      { ...ask({ id: "b-suspended", state: "suspended" }), projectId: PROJECT_B_ID },
    ];
  }

  test("no active window + no projectScope: both projects' asks are returned", async () => {
    const repo = projectScopedRepoWith(twoProjectFixture());
    const cohort = await loadCohort(repo, null);
    expect(cohort.map((a) => a.id).sort()).toEqual(["a-suspended", "b-suspended"]);
  });

  test("no active window + projectScope=A: only project A's ask is returned", async () => {
    const repo = projectScopedRepoWith(twoProjectFixture());
    const cohort = await loadCohort(repo, null, PROJECT_A_ID);
    expect(cohort.map((a) => a.id)).toEqual(["a-suspended"]);
  });

  test("no active window + projectScope=B: only project B's ask is returned", async () => {
    const repo = projectScopedRepoWith(twoProjectFixture());
    const cohort = await loadCohort(repo, null, PROJECT_B_ID);
    expect(cohort.map((a) => a.id)).toEqual(["b-suspended"]);
  });

  test("active window + projectScope=A: pendingAsksForWindow only sees project A's routed/suspended asks", async () => {
    const windowKey = "2026-08-29T09:00";
    const fixture: Array<Ask & { projectId: string }> = [
      {
        ...ask({
          id: "a-scheduled",
          state: "suspended",
          serviceStrategy: "scheduled",
          windowKey,
        }),
        projectId: PROJECT_A_ID,
      },
      {
        ...ask({
          id: "b-scheduled",
          state: "suspended",
          serviceStrategy: "scheduled",
          windowKey,
        }),
        projectId: PROJECT_B_ID,
      },
    ];
    const repo = projectScopedRepoWith(fixture);
    const cohort = await loadCohort(repo, windowKey, PROJECT_A_ID);
    expect(cohort.map((a) => a.id)).toEqual(["a-scheduled"]);
  });
});

// ---------------------------------------------------------------------------
// Header count vs cohort list (mt#4775)
// ---------------------------------------------------------------------------

describe("pendingOperatorAsks — the header count and the cohort cannot drift", () => {
  test("a woken (routed) operator ask is COUNTED, not merely listed", async () => {
    // The seeded fixture AT3 calls for. Before the fix the header ran its own
    // `listByState("suspended")`, so it reported 2 while the cohort listed 3.
    // A fixture with no `routed` ask agrees either way and would pass against
    // the unfixed code — which is exactly why the live probe could not
    // reproduce this: production happened to hold zero routed asks.
    const repo = repoWith([
      ask({ id: "woken", state: "routed" }),
      ask({ id: "waiting-a", state: "suspended" }),
      ask({ id: "waiting-b", state: "suspended" }),
    ]);

    const cohort = await loadCohort(repo, null);
    const total = (await pendingOperatorAsks(repo)).length;

    expect(total).toBe(3);
    expect(total).toBe(cohort.length);
  });

  test("non-operator routing is excluded from the count as it is from the cohort", async () => {
    const repo = repoWith([
      ask({ id: "mine", state: "routed" }),
      ask({ id: "subagent", state: "routed", routingTarget: "subagent" }),
    ]);

    expect((await pendingOperatorAsks(repo)).length).toBe(1);
    expect((await loadCohort(repo, null)).length).toBe(1);
  });
});
