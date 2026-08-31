/**
 * mt#4772: an Ask's project comes from its PARENT TASK, not the filing context.
 *
 * The defect these pin, reproduced live before the fix: ask#10990 carried
 * `parentTaskId: "mt#4678"` (a Peezombie task) and `projectId` = the Minsky
 * project, because `asks.create` derived the project from
 * `resolveCurrentProjectScope` and nothing else. `/asks` scopes on the ask's
 * own `projectId` while the activity feed scopes on `relatedTaskId`, so one
 * entity rendered under two different project filters depending on the page.
 *
 * Third and last call site of the root mt#4758 fixed for `session_start` and
 * mt#4808 for `tasks_create`.
 *
 * ## What the fallback assertions rest on
 *
 * The fallback leg calls `resolveCurrentProjectScope`, which issues its own
 * query against the `projects` table. The fake below answers that query with
 * `[]` (see `dbWithTaskRows`), so the filing context resolves to `undefined`
 * and each fallback case asserts exactly that — a stronger claim than "not the
 * parent's project", and one that also pins the fail-open contract: an
 * unresolvable project yields an unscoped Ask rather than an error.
 */

import { describe, expect, test } from "bun:test";
import { tasksTable } from "@minsky/domain/storage/schemas/task-embeddings";
import { resolveNewAskProjectId } from "./asks-project-resolution";
import { asksCreateParams } from "./asks";

/**
 * Synthetic — deliberately NOT a real project uuid, so the filing-context
 * fallback can never coincidentally produce it. See the header note.
 */
const PROJECT_B = "11111111-2222-4333-8444-555555555555";

const PARENT_TASK = "mt#4678";

/**
 * A db handle that answers the TASKS query and nothing else.
 *
 * Discriminating on the table is load-bearing, not tidiness. The fallback leg
 * (`resolveCurrentProjectScope`) issues its own query against `projects`, and a
 * fake that returns the same rows for every `from()` answers it with a TASK
 * row — which is how the first cut of these tests saw a filing-context result
 * of `"mt#4678"`, a task id standing in for a project uuid. Nothing errored:
 * the fake manufactured a plausible value for a query it was never given data
 * for. Returning `[]` for every other table makes the fallback resolve to
 * `undefined`, which is what an unidentified project actually produces.
 */
function dbWithTaskRows(rows: unknown[]) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({ limit: () => Promise.resolve(table === tasksTable ? rows : []) }),
      }),
    }),
  };
}

/** Container satisfying the `has("persistence")` / `get("persistence")` usage. */
function containerWithDb(db: unknown) {
  return {
    has: (key: string) => key === "persistence",
    get: (_key: string) => ({ getDatabaseConnection: async () => db }),
  } as never;
}

describe("resolveNewAskProjectId — parent task beats filing context (mt#4772)", () => {
  test("AT1: a parent belonging to another project wins over the filing context", async () => {
    const container = containerWithDb(dbWithTaskRows([{ id: PARENT_TASK, projectId: PROJECT_B }]));

    const resolved = await resolveNewAskProjectId(container, PARENT_TASK, "test");

    expect(resolved).toBe(PROJECT_B);
  });

  test("AT2: with no parent, the filing context still decides", async () => {
    const container = containerWithDb(dbWithTaskRows([{ id: PARENT_TASK, projectId: PROJECT_B }]));

    // The row is present and would resolve to B — but no parentTaskId was
    // given, so the parent leg must not be consulted at all.
    const resolved = await resolveNewAskProjectId(container, undefined, "test");

    expect(resolved).toBeUndefined();
  });

  test("a parent whose project_id is NULL falls through rather than clearing the stamp", async () => {
    const container = containerWithDb(dbWithTaskRows([{ id: PARENT_TASK, projectId: null }]));

    const resolved = await resolveNewAskProjectId(container, PARENT_TASK, "test");

    expect(resolved).toBeUndefined();
  });

  test("a parent task that does not exist falls through", async () => {
    const container = containerWithDb(dbWithTaskRows([]));

    const resolved = await resolveNewAskProjectId(container, "mt#404", "test");

    expect(resolved).toBeUndefined();
  });

  test("fails open on a broken db handle rather than throwing — a create must not fail", async () => {
    const container = containerWithDb({ notADb: true });

    // Resolving at all is half the assertion: the contract is that this never
    // rejects, because a rejection here would fail the whole ask creation.
    const resolved = await resolveNewAskProjectId(container, PARENT_TASK, "test");

    expect(resolved).toBeUndefined();
  });

  test("fails open when the query rejects", async () => {
    const exploding = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.reject(new Error("connection lost")) }),
        }),
      }),
    };

    const resolved = await resolveNewAskProjectId(containerWithDb(exploding), PARENT_TASK, "test");

    expect(resolved).toBeUndefined();
  });

  test("fails open when no persistence is registered", async () => {
    const container = { has: () => false, get: () => undefined } as never;

    const resolved = await resolveNewAskProjectId(container, PARENT_TASK, "test");

    expect(resolved).toBeUndefined();
  });
});

/**
 * The production-wiring half. `asks.create` passes `params.parentTaskId` into
 * the resolver, so a `parentTaskId` missing from the command's own params map
 * would make the parent leg permanently dead — reachable in tests and never in
 * production, with nothing failing to say so.
 *
 * This is the exact shape PR #3525 R1 raised against the sibling fix (there it
 * did not hold: the param was declared, in a file the finding did not read).
 * Pinning it here makes the question answerable mechanically rather than by
 * re-reading.
 */
describe("asks_create declares the param the precedence reads (mt#4772)", () => {
  test("asksCreateParams exposes `parentTaskId`", () => {
    expect(asksCreateParams).toHaveProperty("parentTaskId");
  });

  test("`parentTaskId` is optional and accepts a qualified task id", () => {
    expect(asksCreateParams.parentTaskId.required).toBeFalsy();
    expect(asksCreateParams.parentTaskId.schema.safeParse("mt#4678").success).toBe(true);
  });
});
