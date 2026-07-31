/**
 * Tests for driven-session-cost-writer (mt#2753 — per-turn `driven_session_cost`
 * writer).
 *
 * Uses an in-memory fake for the DB — no real Postgres access (mirrors
 * driven-link-writer.test.ts's fake convention, simplified to one table since
 * this writer, unlike driven-link-writer, is deliberately NOT FK-ordered
 * against another table — see the schema module's docblock).
 *
 * @see ./driven-session-cost-writer.ts
 * @see mt#2753
 */

import { describe, test, expect } from "bun:test";

import {
  writeDrivenSessionCost,
  type DrivenSessionCostWriteInput,
} from "./driven-session-cost-writer";
import { drivenSessionCostTable } from "../storage/schemas/driven-session-cost-schema";

interface FakeCostRow {
  localId: string;
  harnessSessionId: string | null;
  taskId: string | null;
  minskySessionId: string | null;
  turnIndex: number;
  subtype: string | null;
  isError: boolean;
  totalCostUsd: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  numTurns: number | null;
  modelUsage: unknown;
}

interface FakeStores {
  rows: FakeCostRow[];
}

function makeStores(): FakeStores {
  return { rows: [] };
}

/** Routes inserts by the TABLE OBJECT IDENTITY the writer passes, so the test
 * verifies the writer targets the real imported schema object. */
function makeDb(stores: FakeStores, opts?: { throwOnInsert?: boolean }) {
  return {
    insert(table: unknown) {
      return {
        values(v: Record<string, unknown>): Promise<void> {
          if (table !== drivenSessionCostTable) {
            return Promise.reject(new Error("insert against an unexpected table"));
          }
          if (opts?.throwOnInsert) {
            return Promise.reject(new Error("simulated insert error"));
          }
          stores.rows.push(v as unknown as FakeCostRow);
          return Promise.resolve();
        },
      };
    },
  };
}

type FakeDb = ReturnType<typeof makeDb>;
function asPg(db: FakeDb) {
  return db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;
}

const BASE_INPUT: DrivenSessionCostWriteInput = {
  localId: "local-abc",
  harnessSessionId: "harness-xyz",
  taskId: "mt#2753",
  minskySessionId: "session-123",
  turnIndex: 0,
  subtype: "success",
  isError: false,
  totalCostUsd: 0.254156,
  inputTokens: 2,
  outputTokens: 26,
  cacheCreationInputTokens: 11861,
  cacheReadInputTokens: 15008,
  durationMs: 7008,
  durationApiMs: 6500,
  numTurns: 1,
  modelUsage: {
    "claude-fable-5": {
      inputTokens: 2,
      outputTokens: 26,
      cacheCreationInputTokens: 11861,
      cacheReadInputTokens: 15008,
      costUsd: 0.254156,
    },
  },
};

describe("writeDrivenSessionCost", () => {
  test("writes a row with all fields, converting totalCostUsd to a fixed-6dp string", async () => {
    const stores = makeStores();
    const outcome = await writeDrivenSessionCost(asPg(makeDb(stores)), BASE_INPUT);

    expect(outcome).toBe("written");
    expect(stores.rows.length).toBe(1);
    const row = stores.rows[0];
    expect(row).toBeDefined();
    expect(row?.localId).toBe("local-abc");
    expect(row?.harnessSessionId).toBe("harness-xyz");
    expect(row?.taskId).toBe("mt#2753");
    expect(row?.totalCostUsd).toBe("0.254156");
    expect(row?.inputTokens).toBe(2);
    expect(row?.cacheReadInputTokens).toBe(15008);
    expect(row?.modelUsage).toEqual(BASE_INPUT.modelUsage);
  });

  test("writes NULL totalCostUsd (not a coerced '0.000000' string) when the input is null", async () => {
    const stores = makeStores();
    await writeDrivenSessionCost(asPg(makeDb(stores)), { ...BASE_INPUT, totalCostUsd: null });
    expect(stores.rows[0]?.totalCostUsd).toBeNull();
  });

  test("preserves a null taskId/minskySessionId (scratch, untasked session)", async () => {
    const stores = makeStores();
    await writeDrivenSessionCost(asPg(makeDb(stores)), {
      ...BASE_INPUT,
      taskId: null,
      minskySessionId: null,
    });
    expect(stores.rows[0]?.taskId).toBeNull();
    expect(stores.rows[0]?.minskySessionId).toBeNull();
  });

  test("preserves turnIndex across multiple turns of the same session", async () => {
    const stores = makeStores();
    await writeDrivenSessionCost(asPg(makeDb(stores)), { ...BASE_INPUT, turnIndex: 0 });
    await writeDrivenSessionCost(asPg(makeDb(stores)), { ...BASE_INPUT, turnIndex: 1 });
    expect(stores.rows.map((r) => r.turnIndex)).toEqual([0, 1]);
    expect(stores.rows.length).toBe(2);
  });

  test("returns 'error' (never throws) when the insert fails", async () => {
    const stores = makeStores();
    const outcome = await writeDrivenSessionCost(
      asPg(makeDb(stores, { throwOnInsert: true })),
      BASE_INPUT
    );
    expect(outcome).toBe("error");
    expect(stores.rows.length).toBe(0);
  });
});
