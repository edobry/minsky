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
 * Records the column each write's WHERE clause targets, how many statements
 * were issued at all, and which id the VECTOR store was asked to delete.
 *
 * `queries()` staying at 0 is what proves a malformed id never reached the
 * driver. `vectorDeletes()` is what proves the embedding was removed by the
 * canonical uuid rather than the caller's alias — a short-id delete that left
 * the vector behind would otherwise look completely successful.
 */
function recordingDb(opts: { deleteReturns?: Record<string, unknown>[] } = {}): {
  db: MemoryServiceDb;
  queries: () => number;
  whereColumns: () => string[];
  vectorDeletes: () => string[];
  vectorStorage: VectorStorage;
} {
  let queries = 0;
  const columns: string[] = [];
  const vectorDeleted: string[] = [];
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
        return { returning: () => Promise.resolve(opts.deleteReturns ?? [ROW]) };
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

  const vectorStorage = {
    delete: async (id: string) => {
      vectorDeleted.push(id);
    },
    store: async () => {},
  } as unknown as VectorStorage;

  return {
    db,
    queries: () => queries,
    whereColumns: () => columns,
    vectorDeletes: () => vectorDeleted,
    vectorStorage,
  };
}

function serviceWith(db: MemoryServiceDb, vectorStorage?: VectorStorage): MemoryService {
  return new MemoryService({
    db,
    vectorStorage:
      vectorStorage ??
      ({ delete: async () => {}, store: async () => {} } as unknown as VectorStorage),
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

  test("delete() removes the embedding by the CANONICAL uuid, not the alias", async () => {
    // The regression this task would otherwise have introduced (PR #2348 R1):
    // making the row deletion work for short ids means the vector deletion is
    // now reached with whatever the caller passed. Keyed by uuid, a `mem#728`
    // there matches nothing and silently orphans the embedding — while both
    // operations report success.
    const { db, vectorDeletes, vectorStorage } = recordingDb();
    await serviceWith(db, vectorStorage).delete("mem#728");
    expect(vectorDeletes()).toEqual([UUID]);
    expect(vectorDeletes()).not.toContain("mem#728");
  });

  test("delete() skips the embedding entirely when no row matched", async () => {
    // No deleted row means no id to delete a vector by — and nothing to delete.
    const { db, vectorDeletes, vectorStorage } = recordingDb({ deleteReturns: [] });
    await serviceWith(db, vectorStorage).delete(UUID);
    expect(vectorDeletes()).toEqual([]);
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

  test("supersede() names the problem when the old row does not exist", async () => {
    // A well-formed id that matches nothing previously fell through to
    // rowToRecord(undefined) — an error about reading properties of undefined,
    // saying nothing about the actual cause (PR #2348 R1). The transaction
    // rolls back, so the already-inserted replacement is not left behind.
    const emptySelectDb = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([ROW]),
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([ROW]) }),
        }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
      delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
      transaction: async (fn: (tx: MemoryServiceDb) => Promise<unknown>) =>
        fn(emptySelectDb as unknown as MemoryServiceDb),
    };

    await expect(
      serviceWith(emptySelectDb as unknown as MemoryServiceDb).supersede(UUID, {
        type: "feedback",
        name: "n",
        description: "d",
        content: "c",
        scope: "project",
      })
    ).rejects.toThrow(/Memory not found: .* nothing to supersede/);
  });
});
