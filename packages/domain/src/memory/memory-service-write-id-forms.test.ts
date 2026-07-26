/**
 * Write-path id-form resolution for `MemoryService` (mt#3108).
 *
 * mt#3259 fixed `get`; this covers the three WRITE methods, which had the
 * same bare `eq(memoriesTable.id, id)`. Because `memories.id` is a Postgres
 * `uuid` column, a `mem#N` there was not a miss but a cast error with the
 * failing statement echoed back — observed live on `memory_update` while
 * updating mem#736.
 *
 * As in the sibling read-path test, the fake records the WHERE clause's
 * COLUMN. Asserting only on the return value would pass against the old
 * uuid-only code, since the fake answers whatever query it is given.
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

function columnsOf(cond: unknown): string[] {
  const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
  const out: string[] = [];
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object" && "name" in chunk) {
      out.push(String((chunk as { name: unknown }).name));
    }
  }
  return out;
}

/**
 * Records the column each write's WHERE clause targets, and how many
 * statements were issued at all. `queries()` staying at 0 is what proves a
 * malformed id never reached the driver.
 */
function recordingDb(): {
  db: MemoryServiceDb;
  queries: () => number;
  whereColumns: () => string[];
} {
  let queries = 0;
  const columns: string[] = [];
  const track = (cond: unknown) => {
    queries++;
    columns.push(...columnsOf(cond));
  };

  const db = {
    select: () => ({
      from: () => ({
        where: (c: unknown) => {
          track(c);
          return Promise.resolve([ROW]);
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: (c: unknown) => {
          track(c);
          return { returning: () => Promise.resolve([ROW]) };
        },
      }),
    }),
    delete: () => ({
      where: (c: unknown) => {
        track(c);
        return Promise.resolve([]);
      },
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([ROW]),
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([ROW]) }),
      }),
    }),
    transaction: async (fn: (tx: MemoryServiceDb) => Promise<unknown>) => fn(db),
  } as unknown as MemoryServiceDb;

  return { db, queries: () => queries, whereColumns: () => columns };
}

function serviceWith(db: MemoryServiceDb): MemoryService {
  return new MemoryService({
    db,
    vectorStorage: { delete: async () => {}, store: async () => {} } as unknown as VectorStorage,
    embeddingService: {
      generateEmbedding: async () => [0, 0, 0, 0],
    } as unknown as EmbeddingService,
  });
}

describe("MemoryService write paths accept mem#N (mt#3108)", () => {
  test("update() resolves a short id against short_id", async () => {
    const { db, whereColumns } = recordingDb();
    const record = await serviceWith(db).update("mem#728", { name: "renamed" });
    expect(record?.id).toBe(UUID);
    expect(whereColumns()).toContain("short_id");
    expect(whereColumns()).not.toContain("id");
  });

  test("update() with a uuid still targets the id column", async () => {
    const { db, whereColumns } = recordingDb();
    expect((await serviceWith(db).update(UUID, { name: "renamed" }))?.id).toBe(UUID);
    expect(whereColumns()).toContain("id");
    expect(whereColumns()).not.toContain("short_id");
  });

  test("delete() resolves a short id against short_id", async () => {
    const { db, whereColumns } = recordingDb();
    await serviceWith(db).delete("mem#728");
    expect(whereColumns()).toContain("short_id");
  });

  test("supersede() resolves the old id against short_id", async () => {
    const { db, whereColumns } = recordingDb();
    await serviceWith(db).supersede("mem#728", {
      type: "feedback",
      name: "n",
      description: "d",
      content: "c",
      scope: "project",
    });
    expect(whereColumns()).toContain("short_id");
  });
});

describe("write paths refuse a malformed id without querying (mt#3108)", () => {
  test("update() returns null and issues no statement", async () => {
    for (const bad of ["not-a-uuid", "mem#0", "ask#7", ""]) {
      const { db, queries } = recordingDb();
      expect(await serviceWith(db).update(bad, { name: "x" })).toBeNull();
      expect(queries()).toBe(0);
    }
  });

  test("delete() is a no-op and issues no statement", async () => {
    const { db, queries } = recordingDb();
    await serviceWith(db).delete("not-a-uuid");
    expect(queries()).toBe(0);
  });

  test("supersede() throws a NAMED error before opening the transaction", async () => {
    // It cannot return a not-found value (the signature promises a record
    // pair), so the contract here is a readable error rather than a uuid cast
    // — and critically, it must fire BEFORE the replacement row is inserted.
    const { db, queries } = recordingDb();
    await expect(
      serviceWith(db).supersede("not-a-uuid", {
        type: "feedback",
        name: "n",
        description: "d",
        content: "c",
        scope: "project",
      })
    ).rejects.toThrow(/Invalid memory id .* expected a full uuid or a mem#N short id/);
    expect(queries()).toBe(0);
  });
});
