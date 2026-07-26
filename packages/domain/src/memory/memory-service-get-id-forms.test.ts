/**
 * `MemoryService.get` id-form resolution (mt#3259).
 *
 * `memories.id` is a Postgres `uuid` column, so comparing it against a
 * non-uuid string is a CAST ERROR, not an empty result. Before this change
 * `get("mem#728")` produced `invalid input syntax for type uuid` with the
 * whole failing statement echoed back — observed live through the cockpit's
 * memories-detail endpoint, which surfaced it as `state: "degraded"` carrying
 * a raw SQL dump instead of a clean miss.
 *
 * The assertions below are about WHETHER A QUERY IS ISSUED AT ALL, not just
 * about the return value. A guard that returned null by querying-and-missing
 * would satisfy a return-value-only test while still hitting the driver with
 * the bad cast — so `selectCalls` is the load-bearing assertion, and the fake
 * deliberately has no way to "succeed quietly": any query it receives is
 * counted.
 */
import { describe, test, expect } from "bun:test";
import { MemoryService, type MemoryServiceDb } from "./memory-service";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage } from "../storage/vector/types";

const UUID = "d8891fad-b156-46e1-8940-98067eb097a9";

const ROW = {
  id: UUID,
  short_id: "mem#728",
  type: "feedback",
  name: "a memory",
  description: "d",
  content: "c",
  scope: "project",
  tags: [],
  associations: {},
  access_count: 0,
};

/**
 * A db fake that COUNTS selects and records the COLUMN each `where` clause
 * targets, returning one row for any query it does receive. `update` is a
 * no-op sink for the fire-and-forget access-count bump.
 *
 * Capturing the column is what makes the positive short-id test
 * discriminating. A fake that merely returned a row for any query would let
 * `get("mem#728")` pass against the OLD `eq(memoriesTable.id, id)` code —
 * the query would still be issued, still be handed a row by the fake, and
 * the test would go green while production threw a uuid cast error. Asserting
 * `short_id` is what pins the branch actually taken.
 */
function countingDb(): {
  db: MemoryServiceDb;
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
            // Drizzle's `eq()` exposes its operands as `queryChunks`; the
            // column operand carries a `name`. Read it rather than
            // stringifying the whole condition, which would also match a
            // literal value that happened to contain the column name.
            const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
            for (const chunk of chunks) {
              if (chunk && typeof chunk === "object" && "name" in chunk) {
                columns.push(String((chunk as { name: unknown }).name));
              }
            }
            return Promise.resolve([ROW]);
          },
        }),
      };
    },
    insert: () => {
      throw new Error("not used");
    },
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    delete: () => {
      throw new Error("not used");
    },
    transaction: async () => {
      throw new Error("not used");
    },
  } as unknown as MemoryServiceDb;
  return { db, selectCalls: () => selectCalls, whereColumns: () => columns };
}

function serviceWith(db: MemoryServiceDb): MemoryService {
  return new MemoryService({
    db,
    vectorStorage: {} as VectorStorage,
    embeddingService: {} as EmbeddingService,
  });
}

describe("MemoryService.get id forms (mt#3259)", () => {
  test("a full uuid queries the table and returns the record", async () => {
    const { db, selectCalls, whereColumns } = countingDb();
    const record = await serviceWith(db).get(UUID);
    expect(record?.id).toBe(UUID);
    expect(selectCalls()).toBe(1);
    expect(whereColumns()).toEqual(["id"]);
  });

  test("a mem#N short id queries the SHORT_ID column and returns the record", async () => {
    // The regression this task fixes: previously this compared against the
    // uuid `id` column and threw a cast error at the driver.
    const { db, selectCalls, whereColumns } = countingDb();
    const record = await serviceWith(db).get("mem#728");
    expect(record?.id).toBe(UUID);
    expect(selectCalls()).toBe(1);
    expect(whereColumns()).toEqual(["short_id"]);
  });

  test("short-id prefix casing is normalized before the lookup", async () => {
    const { db, selectCalls, whereColumns } = countingDb();
    const record = await serviceWith(db).get("MEM#728");
    expect(record?.id).toBe(UUID);
    expect(selectCalls()).toBe(1);
    expect(whereColumns()).toEqual(["short_id"]);
  });

  test("a malformed id returns null WITHOUT issuing a query", async () => {
    // The core guard. If this ever regresses to querying, the count assertion
    // fails here even though the return value would still look correct.
    for (const bad of ["not-a-uuid", "mem#0", "mem#", "ask#7", "", "   "]) {
      const { db, selectCalls } = countingDb();
      const record = await serviceWith(db).get(bad);
      expect(record).toBeNull();
      expect(selectCalls()).toBe(0);
    }
  });

  test("an ask#N short id is not accepted by the MEMORY service", async () => {
    // Prefix ownership matters: `ask#7` is a well-formed short id for a
    // different entity type, and must not resolve against memories.
    const { db, selectCalls } = countingDb();
    expect(await serviceWith(db).get("ask#7")).toBeNull();
    expect(selectCalls()).toBe(0);
  });

  test("a uuid with surrounding whitespace still resolves", async () => {
    const { db } = countingDb();
    expect((await serviceWith(db).get(`  ${UUID}  `))?.id).toBe(UUID);
  });
});
