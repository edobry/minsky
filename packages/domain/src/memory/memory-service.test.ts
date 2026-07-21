/**
 * MemoryService — mem#N short id minting + collision retry (mt#2966).
 *
 * Exercises the ACTUAL production minting path
 * (`MemoryService.create()`'s select-then-insert + onConflictDoNothing +
 * bounded retry, and `supersede()`'s single-attempt in-transaction mint)
 * against a minimal fake `MemoryServiceDb` that models the real TOCTOU
 * race: a short_id proposal can collide with a row that was invisible to
 * the SELECT (not yet committed-and-visible) but IS enforced by the unique
 * index at INSERT time.
 *
 * Modeled directly after `packages/domain/src/ask/repository.test.ts`'s
 * "DrizzleAskRepository — short id minting (mt#2965)" describe block — the
 * mt#2965 sibling task's equivalent coverage for `ask#N`. The large
 * pre-existing `tests/domain/memory/memory-service.test.ts` /
 * `memory-service.integration.test.ts` suites cover the rest of
 * `MemoryService`'s behavior (search, list, update, delete, lineage, etc.)
 * with fakes not purpose-built for exercising short-id collision — this
 * file is scoped narrowly to the mint/retry contract mt#2966 adds.
 *
 * @see mt#2966 — this file's originating task
 * @see mt#2965 PR #2110 — the ask sibling this file mirrors
 */

import { describe, it, expect } from "bun:test";
import { MemoryService } from "./memory-service";
import type { MemoryServiceDb } from "./memory-service";
import { MemoryVectorStorage } from "../storage/vector/memory-vector-storage";
import type { MemoryCreateInput } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    type: "user",
    name: "Test memory",
    description: "A test memory",
    content: "This is test content",
    scope: "user",
    ...overrides,
  };
}

const mockEmbeddingService = {
  async generateEmbedding(_text: string): Promise<number[]> {
    return [0, 0, 0, 0];
  },
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0, 0]);
  },
};

// ---------------------------------------------------------------------------
// Fake MemoryServiceDb modeling the real short_id TOCTOU race.
//
// Unlike the several ad-hoc `MemoryServiceDb` fakes elsewhere in this
// codebase (which can't evaluate arbitrary raw-SQL WHERE shapes, or don't
// implement `.orderBy()`/`.limit()` at all), THIS fake implements the FULL
// targeted-query chain `.select({shortId}).from().where().orderBy().limit()`
// — mirroring `ask/repository.test.ts`'s `createFakeDrizzleAskDb` — so these
// tests exercise `nextMemoryShortId()`'s real-DB-optimized path (PR #2134
// R1), not just its unfiltered-select fallback.
// ---------------------------------------------------------------------------

interface FakeMemoryRow {
  id: string;
  shortId: string;
  [key: string]: unknown;
}

function createFakeMemoryDb(opts: { preClaimedShortIds?: string[] } = {}) {
  // `visible` — short ids a SELECT can currently see (committed rows).
  const visible = new Set<string>();
  // `claimed` — short ids the unique index will reject an INSERT for,
  // including ones not yet visible to a SELECT (the race window).
  const claimed = new Set<string>(opts.preClaimedShortIds ?? []);
  let nextRowId = 0;
  let insertAttempts = 0;
  // Instrumentation (PR #2134 R1): proves nextMemoryShortId's real-DB-optimized
  // path actually ran, rather than assuming it from the (behaviorally
  // identical) result — both paths return the same shortId, so an assertion
  // on the minted value alone can't distinguish "optimized path ran" from
  // "silently fell back and still got the right answer by luck."
  let orderByLimitCalls = 0;
  const rowsById = new Map<string, FakeMemoryRow>();

  const db: MemoryServiceDb = {
    select(_fields?: unknown) {
      return {
        from(_table: unknown) {
          const allVisibleRows = () => Array.from(visible).map((shortId) => ({ shortId }));
          return {
            where(cond: unknown) {
              void cond;
              const rows = allVisibleRows();
              return {
                // Mirrors nextMemoryShortId's targeted `ORDER BY ... LIMIT 1`
                // query (PR #2134 R1): sort descending by the numeric
                // suffix — the same ordering a real
                // `(substring(short_id from 5))::bigint DESC` would
                // produce — so `top[0]` at the call site picks the max.
                orderBy(_order: unknown) {
                  const sorted = [...rows].sort((a, b) => {
                    const na = Number(a.shortId.split("#")[1]);
                    const nb = Number(b.shortId.split("#")[1]);
                    return nb - na;
                  });
                  return {
                    limit(n: number) {
                      orderByLimitCalls += 1;
                      return Promise.resolve(sorted.slice(0, n));
                    },
                  };
                },
                then(resolve: (v: unknown[]) => void, reject?: (err: unknown) => void) {
                  Promise.resolve(rows).then(resolve, reject);
                },
              };
            },
            then(resolve: (v: unknown[]) => void, reject?: (err: unknown) => void) {
              Promise.resolve(allVisibleRows()).then(resolve, reject);
            },
          };
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(row: Record<string, unknown>) {
          return {
            onConflictDoNothing(_opts?: unknown) {
              return {
                returning() {
                  insertAttempts += 1;
                  const shortId = row["shortId"] as string;
                  if (claimed.has(shortId)) {
                    // A concurrent writer already holds this short_id. By the
                    // time we retry, its commit is now visible to a fresh SELECT.
                    visible.add(shortId);
                    return Promise.resolve([]);
                  }
                  const id = (row["id"] as string | undefined) ?? `uuid-${nextRowId++}`;
                  const inserted: FakeMemoryRow = {
                    ...row,
                    id,
                    shortId,
                    type: (row["type"] as string) ?? "user",
                    name: (row["name"] as string) ?? "",
                    description: (row["description"] as string) ?? "",
                    content: (row["content"] as string) ?? "",
                    scope: (row["scope"] as string) ?? "user",
                    created_at: new Date(),
                    updated_at: new Date(),
                    associations: (row["associations"] as Record<string, string[]>) ?? {},
                  };
                  claimed.add(shortId);
                  visible.add(shortId);
                  rowsById.set(id, inserted);
                  return Promise.resolve([inserted]);
                },
              };
            },
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(_data: Record<string, unknown>) {
          return {
            where(_cond: unknown) {
              return {
                returning() {
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
    delete(_table: unknown) {
      return {
        where(_cond: unknown) {
          return Promise.resolve(undefined);
        },
      };
    },
    transaction<T>(fn: (tx: MemoryServiceDb) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };

  return {
    db,
    get insertAttempts() {
      return insertAttempts;
    },
    get orderByLimitCalls() {
      return orderByLimitCalls;
    },
  };
}

function makeService(db: MemoryServiceDb): MemoryService {
  return new MemoryService({
    db,
    vectorStorage: new MemoryVectorStorage(4),
    embeddingService: mockEmbeddingService,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryService — mem#N short id minting (mt#2966)", () => {
  it("mints mem#1 then mem#2 on sequential creates against the real minting path", async () => {
    const { db } = createFakeMemoryDb();
    const service = makeService(db);

    const a = await service.create(makeInput({ name: "First" }));
    const b = await service.create(makeInput({ name: "Second" }));

    expect(a.shortId).toBe("mem#1");
    expect(b.shortId).toBe("mem#2");
    // REGRESSION: uuid id is still the PK — unaffected by short-id minting.
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(a.shortId);
  });

  it("mints mem#3 on the third sequential create", async () => {
    const { db } = createFakeMemoryDb();
    const service = makeService(db);

    await service.create(makeInput({ name: "First" }));
    await service.create(makeInput({ name: "Second" }));
    const c = await service.create(makeInput({ name: "Third" }));

    expect(c.shortId).toBe("mem#3");
  });

  it("REGRESSION (PR #2134 R1): exercises the real-DB-optimized ORDER BY/LIMIT path, not just the fallback", async () => {
    // This fake implements the full targeted-query chain, so
    // nextMemoryShortId's optimized path (try block) should succeed on
    // every call — never falling through to the unfiltered-select
    // fallback. Asserting on `orderByLimitCalls` (not just the minted
    // shortId) proves the optimized path actually ran, since both paths
    // return the same value and a passing shortId assertion alone can't
    // distinguish "optimized path ran" from "silently fell back".
    const fake = createFakeMemoryDb();
    const service = makeService(fake.db);

    await service.create(makeInput({ name: "First" }));
    await service.create(makeInput({ name: "Second" }));

    expect(fake.orderByLimitCalls).toBe(2);
  });

  it("retries past a short_id collision invisible to the SELECT snapshot (TOCTOU race)", async () => {
    // "mem#1" is already claimed by a concurrent writer but not yet visible
    // to a fresh SELECT — the exact race the retry loop exists to handle.
    const fake = createFakeMemoryDb({ preClaimedShortIds: ["mem#1"] });
    const service = makeService(fake.db);

    const record = await service.create(makeInput());

    expect(record.shortId).toBe("mem#2");
    // Read live (a getter) AFTER the operation — destructuring it up front
    // would capture the value at construction time (0), not after retries.
    expect(fake.insertAttempts).toBe(2); // first attempt collided, second succeeded
  });

  it("throws after MAX_RETRIES exhausted when every proposed id keeps colliding", async () => {
    const { db } = createFakeMemoryDb({
      preClaimedShortIds: ["mem#1", "mem#2", "mem#3", "mem#4", "mem#5"],
    });
    const service = makeService(db);

    await expect(service.create(makeInput())).rejects.toThrow(/unique memory short id/i);
  });
});
