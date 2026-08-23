/**
 * Adapter-layer tests for `asks.repair` (mt#4305).
 *
 * `repairAskGraph`'s behaviour is covered in
 * `packages/domain/src/ask/repair.test.ts`. What this file covers is the part
 * that lives HERE and cannot be asserted there: the parameter boundary, and the
 * container-backed collaborators the command injects.
 *
 * The first describe block is the load-bearing one. The design's central claim
 * is that no caller can name a routing target — the value is re-derived from
 * the router, and `repairRoutingTarget` is a boolean. That claim is only true so
 * long as the params object stays free of a target-shaped field, and nothing
 * about adding one would break a behavioural test: a new optional param that the
 * execute callback happened to forward would pass every test in the domain suite
 * while re-opening the exact hole the verb was shaped to close. So it is
 * asserted structurally, against the schema itself.
 *
 * Its own file rather than an addition to `asks.test.ts`, which is at the
 * 1500-line cap — the same reason `asks.cancel.test.ts` gives.
 */

import { describe, expect, test } from "bun:test";

import { asksRepairParams, buildRepairDeps } from "./asks-repair";

// ---------------------------------------------------------------------------
// The authority rule, asserted at the parameter boundary
// ---------------------------------------------------------------------------

describe("asksRepairParams — no caller can name a routing target", () => {
  test("exposes exactly the four intended params", () => {
    expect(Object.keys(asksRepairParams).sort()).toEqual([
      "editor",
      "id",
      "parentTaskId",
      "repairRoutingTarget",
    ]);
  });

  test("carries no field whose name could carry a routing-target VALUE", () => {
    // `repairRoutingTarget` is the boolean switch and is expected; anything else
    // matching /routing|target/ would be a value-carrying param, which is the
    // regression this guards. An agent able to pass `routingTarget: "agent:me"`
    // could address an ask to itself and route around the operator entirely.
    const targetShaped = Object.keys(asksRepairParams).filter(
      (k) => /routing|target/i.test(k) && k !== "repairRoutingTarget"
    );
    expect(targetShaped).toEqual([]);
  });

  test("repairRoutingTarget is a boolean switch, not a value", () => {
    const schema = asksRepairParams.repairRoutingTarget.schema;
    expect(schema.safeParse(true).success).toBe(true);
    // A string target is rejected by the schema itself — the boundary refuses
    // it before any domain code runs.
    expect(schema.safeParse("operator").success).toBe(false);
  });

  test("id is the only required param", () => {
    const required = Object.entries(asksRepairParams)
      .filter(([, def]) => def.required)
      .map(([name]) => name);
    expect(required).toEqual(["id"]);
  });
});

// ---------------------------------------------------------------------------
// taskExists — the container-backed collaborator
// ---------------------------------------------------------------------------

/** Minimal container standing in for the DI container's two reads. */
function fakeContainer(taskService: { getTask(id: string): Promise<unknown> } | null) {
  return {
    has: (token: string) => token === "taskService" && taskService !== null,
    get: () => taskService,
  } as unknown as Parameters<typeof buildRepairDeps>[0];
}

describe("buildRepairDeps().taskExists", () => {
  test("is true when the task service resolves the task", async () => {
    const deps = buildRepairDeps(
      fakeContainer({ getTask: async () => ({ id: "mt#0002", status: "TODO" }) })
    );
    expect(await deps.taskExists("mt#0002")).toBe(true);
  });

  test("is false when the task service resolves nothing", async () => {
    // The discriminating case: `getTask` returns null rather than throwing for
    // an unknown id, so a truthiness check on the service call would report
    // every id as existing. This asserts the null is read.
    const deps = buildRepairDeps(fakeContainer({ getTask: async () => null }));
    expect(await deps.taskExists("mt#9999")).toBe(false);
  });

  test("throws rather than silently allowing when the container has no task service", async () => {
    // Fail loud, not open. A missing task service must not degrade into
    // "assume the parent exists" — that would reparent an ask onto an id
    // nothing resolves, which is worse than leaving it where it was.
    const deps = buildRepairDeps(fakeContainer(null));
    await expect(deps.taskExists("mt#0002")).rejects.toThrow(/task service unavailable/);
  });
});
