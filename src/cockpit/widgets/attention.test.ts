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
import { loadCohort } from "./attention";

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
