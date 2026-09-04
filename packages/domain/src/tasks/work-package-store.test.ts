import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { findOpenPackagesReferencing, writeWorkPackageCreateRows } from "./work-package-store";

/** Fluent-chain fake: selects resolve `rows`; inserted values are captured. */
function makeFakeDb(rows: unknown[]) {
  const captured = { inserted: [] as Array<Record<string, unknown> | Record<string, unknown>[]> };
  const db = {
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        then: (
          onFulfilled: (rows: unknown[]) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) => Promise.resolve(rows).then(onFulfilled, onRejected),
      };
      return chain;
    },
    insert: () => ({
      values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
        captured.inserted.push(v);
        return Promise.resolve();
      },
    }),
    transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  } as unknown as PostgresJsDatabase;
  return { db, captured };
}

const NOW = new Date("2026-08-30T12:00:00.000Z");

describe("findOpenPackagesReferencing", () => {
  test("returns sibling hits from the joined query", async () => {
    const hit = { memberTaskId: "mt#101", siblingPackageId: "mt#900", siblingStatus: "READY" };
    const { db } = makeFakeDb([hit]);
    const hits = await findOpenPackagesReferencing(db, ["mt#101", "mt#102"], "mt#901");
    expect(hits).toEqual([hit]);
  });

  test("empty member list short-circuits without touching the db", async () => {
    const db = {} as PostgresJsDatabase; // any method call would throw
    expect(await findOpenPackagesReferencing(db, [])).toEqual([]);
  });
});

describe("writeWorkPackageCreateRows", () => {
  test("writes member rows (rank, F7 status baseline, rationale) and the seq-1 transfer", async () => {
    const { db, captured } = makeFakeDb([]);
    await writeWorkPackageCreateRows(
      db,
      {
        packageTaskId: "mt#900",
        origin: "groomed",
        members: [
          { taskId: "mt#101", rank: 1, rationale: "first" },
          { taskId: "mt#102", rank: 2, rationale: null },
        ],
        memberStatuses: new Map([
          ["mt#101", "READY"],
          ["mt#102", "IN-PROGRESS"],
        ]),
        byConversation: "conv-A",
      },
      NOW
    );
    expect(captured.inserted).toHaveLength(2);
    expect(captured.inserted[0]).toEqual([
      {
        packageTaskId: "mt#900",
        memberTaskId: "mt#101",
        rank: 1,
        statusAtWrite: "READY",
        rationale: "first",
        createdAt: NOW,
      },
      {
        packageTaskId: "mt#900",
        memberTaskId: "mt#102",
        rank: 2,
        statusAtWrite: "IN-PROGRESS",
        rationale: null,
        createdAt: NOW,
      },
    ]);
    expect(captured.inserted[1]).toMatchObject({
      packageTaskId: "mt#900",
      seq: 1,
      origin: "groomed",
      byConversation: "conv-A",
      notes: null,
    });
  });

  test("a memberless succession package writes only the transfer entry", async () => {
    const { db, captured } = makeFakeDb([]);
    await writeWorkPackageCreateRows(
      db,
      {
        packageTaskId: "mt#901",
        origin: "succession",
        members: [],
        byConversation: null,
        notes: "handoff of the doc sweep",
      },
      NOW
    );
    expect(captured.inserted).toHaveLength(1);
    expect(captured.inserted[0]).toMatchObject({
      seq: 1,
      origin: "succession",
      byConversation: null,
      notes: "handoff of the doc sweep",
    });
  });
});
