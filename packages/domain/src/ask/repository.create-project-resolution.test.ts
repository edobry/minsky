/**
 * mt#4848: `DrizzleAskRepository.create` resolves an Ask's project from its
 * parent task, so every writer gets it — not just the `asks.create` command.
 *
 * mt#4772 wired the resolution at the `asks.create` adapter callsite. Seven
 * writers construct `CreateAskInput` and call the repository directly, four of
 * them in `packages/domain/**` where an adapter-layer resolver taking a DI
 * container is unreachable. Measured after mt#4772 deployed: 12 of 13 new Asks
 * had a project-carrying parent and stamped NULL anyway.
 *
 * These assert at the seam every writer passes through, which is the property
 * that makes the fix cover writers that do not exist yet.
 */

import { describe, expect, test } from "bun:test";
import { DrizzleAskRepository } from "./repository";
import { tasksTable } from "../storage/schemas/task-embeddings";

const PROJECT_B = "11111111-2222-4333-8444-555555555555";
const PROJECT_A = "99999999-8888-4777-8666-555555555555";
const PARENT = "mt#4678";

/**
 * Minimal stand-in for the drizzle handle `create` uses.
 *
 * It must answer three different shapes: the short-id `select` (which
 * `nextAskShortId` orders and limits), the tasks lookup `resolveTaskProjectId`
 * issues, and the `insert` whose values we capture. Discriminating on the table
 * is load-bearing — a fake answering every `from()` with the same rows feeds a
 * TASK row to the short-id query and manufactures a plausible wrong answer
 * rather than failing.
 */
function makeDb(taskRows: unknown[]) {
  let captured: Record<string, unknown> | undefined;
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === tasksTable) {
          return { where: () => ({ limit: () => Promise.resolve(taskRows) }) };
        }
        // The short-id probe. Its chain is where -> orderBy -> limit, in that
        // order (`nextAskShortId`); an empty result means nextShortId starts
        // fresh, which is all these tests need.
        return {
          where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }),
        };
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured = v;
        return {
          onConflictDoNothing: () => ({
            returning: () =>
              Promise.resolve([
                {
                  ...v,
                  id: "00000000-0000-4000-8000-000000000000",
                  createdAt: new Date(),
                  state: v.state ?? "detected",
                },
              ]),
          }),
        };
      },
    }),
  };
  return { db, captured: () => captured };
}

function askInput(extra: Record<string, unknown> = {}) {
  return {
    kind: "quality.review",
    classifierVersion: "v1.0.0",
    requestor: "test",
    title: "T",
    question: "Q",
    ...extra,
  } as Parameters<DrizzleAskRepository["create"]>[0];
}

describe("DrizzleAskRepository.create — project resolution at the seam (mt#4848)", () => {
  test("a direct writer's Ask inherits its parent task's project", async () => {
    // This is the case every bypass writer hits: parentTaskId set, projectId
    // absent, because the writer never knew to resolve one.
    const { db, captured } = makeDb([{ id: PARENT, projectId: PROJECT_B }]);
    const repo = new DrizzleAskRepository(db as never);

    await repo.create(askInput({ parentTaskId: PARENT }));

    expect(captured()?.projectId).toBe(PROJECT_B);
  });

  test("an explicit projectId WINS over the parent's — asks.create's fallback is not overridden", async () => {
    // mt#4772's adapter path resolves the filing context and passes it down
    // explicitly. This seam must not second-guess it.
    const { db, captured } = makeDb([{ id: PARENT, projectId: PROJECT_B }]);
    const repo = new DrizzleAskRepository(db as never);

    await repo.create(askInput({ parentTaskId: PARENT, projectId: PROJECT_A }));

    expect(captured()?.projectId).toBe(PROJECT_A);
  });

  // PR #3543 R1. The first cut tested `projectId === undefined`, so an explicit
  // `null` skipped resolution and stamped NULL while the identical `undefined`
  // resolved — a divergence from `toInsert`, which collapses both via
  // `?? null`. Neither is reachable from a typed caller (`projectId?: string`);
  // both are from a JS one. `""` is the same class and is worse, since it would
  // reach a uuid column.
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
  ])("an unsupplied projectId (%s) still resolves from the parent", async (_label, supplied) => {
    const { db, captured } = makeDb([{ id: PARENT, projectId: PROJECT_B }]);
    const repo = new DrizzleAskRepository(db as never);

    await repo.create(askInput({ parentTaskId: PARENT, projectId: supplied }));

    expect(captured()?.projectId).toBe(PROJECT_B);
  });

  test("no parent, no explicit project — stamps null, unchanged behaviour", async () => {
    const { db, captured } = makeDb([]);
    const repo = new DrizzleAskRepository(db as never);

    await repo.create(askInput());

    expect(captured()?.projectId).toBeNull();
  });

  test("a parent whose own project is null falls through rather than throwing", async () => {
    const { db, captured } = makeDb([{ id: PARENT, projectId: null }]);
    const repo = new DrizzleAskRepository(db as never);

    await repo.create(askInput({ parentTaskId: PARENT }));

    expect(captured()?.projectId).toBeNull();
  });

  test("a parent task that does not exist falls through", async () => {
    const { db, captured } = makeDb([]);
    const repo = new DrizzleAskRepository(db as never);

    await repo.create(askInput({ parentTaskId: "mt#404" }));

    expect(captured()?.projectId).toBeNull();
  });

  test("fails open when the parent lookup rejects — a create must not fail because a lookup did", async () => {
    const { captured, db } = makeDb([]);
    const exploding = {
      ...db,
      select: () => ({
        from: (table: unknown) => {
          if (table === tasksTable) {
            return {
              where: () => ({ limit: () => Promise.reject(new Error("connection lost")) }),
            };
          }
          return {
            where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }),
          };
        },
      }),
    };
    const repo = new DrizzleAskRepository(exploding as never);

    // Resolving at all is half the assertion: this must not reject.
    await repo.create(askInput({ parentTaskId: PARENT }));

    expect(captured()?.projectId).toBeNull();
  });
});
