/**
 * `DrizzleAskRepository.getById` id-form resolution (mt#3259).
 *
 * The exact sibling of `../memory/memory-service-get-id-forms.test.ts`.
 * `asks.id` is a Postgres `uuid` column (`storage/schemas/ask-schema.ts`), so
 * before this change an `ask#N` route param was not a miss but a cast error —
 * `invalid input syntax for type uuid`, with the failing statement echoed
 * back. That is the same defect confirmed live on the memory surface; this
 * repository was the second instance of it, found by scanning for the class
 * rather than waiting for it to be reported.
 *
 * As in the memory test, the fake records the WHERE clause's COLUMN. Asserting
 * only "a row came back" would pass against the old uuid-only code, because
 * the fake answers any query — the column assertion is what actually pins the
 * branch taken.
 */
import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DrizzleAskRepository } from "./repository";

const UUID = "0a1b2c3d-1111-2222-3333-444455556666";

const ROW = {
  id: UUID,
  shortId: "ask#3346",
  kind: "direction.decide",
  classifierVersion: 1,
  state: "pending",
  requestor: "agent",
  title: "an ask",
  question: "?",
  windowMissedCount: 0,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

function countingDb(): {
  db: PostgresJsDatabase;
  selectCalls: () => number;
  whereColumns: () => string[];
} {
  let selectCalls = 0;
  const columns: string[] = [];
  const db = {
    select: () => {
      selectCalls++;
      return {
        from: () => ({
          where: (cond: unknown) => {
            const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
            for (const chunk of chunks) {
              if (chunk && typeof chunk === "object" && "name" in chunk) {
                columns.push(String((chunk as { name: unknown }).name));
              }
            }
            return { limit: () => Promise.resolve([ROW]) };
          },
        }),
      };
    },
  } as unknown as PostgresJsDatabase;
  return { db, selectCalls: () => selectCalls, whereColumns: () => columns };
}

describe("DrizzleAskRepository.getById id forms (mt#3259)", () => {
  test("a full uuid queries the id column and returns the ask", async () => {
    const { db, selectCalls, whereColumns } = countingDb();
    const ask = await new DrizzleAskRepository(db).getById(UUID);
    expect(ask?.id).toBe(UUID);
    expect(selectCalls()).toBe(1);
    expect(whereColumns()).toEqual(["id"]);
  });

  test("an ask#N short id queries the SHORT_ID column and returns the ask", async () => {
    const { db, selectCalls, whereColumns } = countingDb();
    const ask = await new DrizzleAskRepository(db).getById("ask#3346");
    expect(ask?.id).toBe(UUID);
    expect(selectCalls()).toBe(1);
    expect(whereColumns()).toEqual(["short_id"]);
  });

  test("short-id prefix casing is normalized before the lookup", async () => {
    const { db, whereColumns } = countingDb();
    expect((await new DrizzleAskRepository(db).getById("ASK#3346"))?.id).toBe(UUID);
    expect(whereColumns()).toEqual(["short_id"]);
  });

  test("a malformed id returns null WITHOUT issuing a query", async () => {
    for (const bad of ["not-a-uuid", "ask#0", "ask#", "", "   "]) {
      const { db, selectCalls } = countingDb();
      expect(await new DrizzleAskRepository(db).getById(bad)).toBeNull();
      expect(selectCalls()).toBe(0);
    }
  });

  test("a mem#N short id is not accepted by the ASK repository", async () => {
    // Prefix ownership: `mem#728` is a well-formed short id for a different
    // entity type and must not resolve against asks.
    const { db, selectCalls } = countingDb();
    expect(await new DrizzleAskRepository(db).getById("mem#728")).toBeNull();
    expect(selectCalls()).toBe(0);
  });
});
