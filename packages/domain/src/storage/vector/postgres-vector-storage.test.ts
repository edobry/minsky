/**
 * PostgresVectorStorage — filtered-search recall fix (mt#4937).
 *
 * Two things are asserted here, and they are deliberately separate:
 *
 *  1. `buildFilterConditions` renders the right predicates. It is a pure
 *     function over a plain object, so this needs no database and no spy on a
 *     collaborator the class reaches itself.
 *  2. `search()` DISPATCHES correctly — a filtered query runs inside a
 *     transaction that first issues `SET LOCAL hnsw.iterative_scan =
 *     strict_order`, an unfiltered one does not open a transaction at all.
 *     Both collaborators (`sql`, `db`) are constructor parameters, so these are
 *     injected fakes rather than patched modules
 *     (`testing-standards.mdc §Testable Design`).
 *
 * What these tests do NOT establish: that pgvector actually returns a full page
 * under `iterative_scan`. That is a property of the database, measured on the
 * transcripts path in mt#4919 and recorded in `searchFiltered`'s docblock. A
 * fake `db` cannot exhibit HNSW recall, and a test that pretended to would be
 * the substitute-runtime failure `/implement-task` §7a names — so the claim
 * here is bounded to "the setting is issued on the same connection, inside the
 * transaction, before the query."
 */
import { describe, test, expect } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { buildFilterConditions, PostgresVectorStorage } from "./postgres-vector-storage";

const dialect = new PgDialect();

/** Render a drizzle SQL fragment to its `{ sql, params }` pair. */
function render(fragment: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment);
  return { sql: query.sql, params: query.params };
}

/**
 * Index into an array, failing with a readable message instead of a non-null
 * assertion. The repo's lint gate is zero-tolerance on WARNINGS (mt#1097, no
 * override) and `@typescript-eslint/no-non-null-assertion` is one — so
 * `conditions[0]!` is not available here, even in test code.
 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an element at index ${index}, got ${items.length} item(s)`);
  }
  return item;
}

describe("buildFilterConditions", () => {
  test("no filters object yields no conditions, so search takes the unfiltered path", () => {
    expect(buildFilterConditions(undefined)).toEqual([]);
    expect(buildFilterConditions({})).toEqual([]);
  });

  test("null and undefined values are skipped, matching the pre-mt#4937 behavior", () => {
    // Behavior preservation: a filters bag whose every value is null produced
    // an empty WHERE clause before this change, and must still route to the
    // unfiltered path rather than emitting `WHERE` with nothing after it.
    expect(buildFilterConditions({ status: null, backend: undefined })).toEqual([]);
  });

  test("a scalar filter renders an equality predicate with the value bound", () => {
    const conditions = buildFilterConditions({ status: "TODO" });
    expect(conditions).toHaveLength(1);

    const { sql, params } = render(at(conditions, 0));
    expect(sql).toContain("status =");
    expect(params).toEqual(["TODO"]);
  });

  test("an *Exclude filter renders NOT IN with every value bound separately", () => {
    const conditions = buildFilterConditions({ statusExclude: ["DONE", "CLOSED"] });
    expect(conditions).toHaveLength(1);

    const { sql, params } = render(at(conditions, 0));
    expect(sql).toContain("status NOT IN");
    // Two bound placeholders, not a single array literal — and the column name
    // has the "Exclude" suffix stripped.
    expect(params).toEqual(["DONE", "CLOSED"]);
    expect(sql).not.toContain("statusExclude");
  });

  test("an empty *Exclude array falls through to equality rather than emitting NOT IN ()", () => {
    // `NOT IN ()` is a syntax error; the pre-mt#4937 code guarded on
    // `value.length > 0` and this must keep doing so.
    const { sql } = render(at(buildFilterConditions({ statusExclude: [] }), 0));
    expect(sql).not.toContain("NOT IN ()");
  });

  test("multiple filters produce one condition each, in insertion order", () => {
    const conditions = buildFilterConditions({ status: "TODO", backend: "minsky" });
    expect(conditions).toHaveLength(2);
    expect(render(at(conditions, 0)).params).toEqual(["TODO"]);
    expect(render(at(conditions, 1)).params).toEqual(["minsky"]);
  });

  test("identifiers render UNQUOTED — the deliberate mt#4937 choice, guarded here", () => {
    // This is the line mt#4944 is about. `dsql.raw(key)` renders `sourceName`
    // bare, which Postgres folds to `sourcename`; `dsql.identifier(key)` would
    // render `"sourceName"` and preserve the case. Both are wrong for today's
    // knowledge caller (no such column exists either way), but they are wrong
    // DIFFERENTLY, and mt#4937 deliberately kept the historical rendering so
    // that mt#4944 changes one thing at a time. If someone "cleans this up",
    // this test is the tripwire.
    const { sql } = render(at(buildFilterConditions({ sourceName: "minsky-design" }), 0));
    expect(sql).toContain("sourceName =");
    expect(sql).not.toContain('"sourceName"');
  });
});

// ---------------------------------------------------------------------------
// Dispatch: which path a search takes, and what the transaction issues first
// ---------------------------------------------------------------------------

interface Recorder {
  unsafeCalls: Array<{ query: string; params: unknown[] }>;
  txStatements: string[];
  transactionCount: number;
}

function newRecorder(): Recorder {
  return { unsafeCalls: [], txStatements: [], transactionCount: 0 };
}

function makeStorage(recorder: Recorder) {
  const fakeSql = {
    unsafe: (query: string, params: unknown[]) => {
      recorder.unsafeCalls.push({ query, params });
      return Promise.resolve([{ id: "row-1", score: 0.25 }]);
    },
  };

  const fakeDb = {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      recorder.transactionCount += 1;
      const tx = {
        execute: (fragment: SQL) => {
          recorder.txStatements.push(render(fragment).sql);
          return Promise.resolve([{ id: "row-1", score: 0.25 }]);
        },
      };
      return run(tx);
    },
  };

  return new PostgresVectorStorage(
    fakeSql as unknown as ConstructorParameters<typeof PostgresVectorStorage>[0],
    fakeDb as unknown as ConstructorParameters<typeof PostgresVectorStorage>[1],
    3,
    {
      tableName: "tasks_embeddings",
      idColumn: "task_id",
      embeddingColumn: "vector",
    }
  );
}

describe("PostgresVectorStorage.search — dispatch", () => {
  test("an UNFILTERED search opens no transaction and issues no SET LOCAL", async () => {
    const recorder = newRecorder();
    const storage = makeStorage(recorder);

    const results = await storage.search([0.1, 0.2, 0.3], { limit: 5 });

    expect(recorder.transactionCount).toBe(0);
    expect(recorder.txStatements).toEqual([]);
    expect(recorder.unsafeCalls).toHaveLength(1);
    expect(at(recorder.unsafeCalls, 0).query).not.toContain("WHERE");
    expect(at(recorder.unsafeCalls, 0).query).toContain("ORDER BY vector <-> $1::vector");
    expect(at(recorder.unsafeCalls, 0).params).toEqual(["[0.1,0.2,0.3]", 5]);
    expect(results).toEqual([{ id: "row-1", score: 0.25 }]);
  });

  test("a FILTERED search runs in a transaction that issues SET LOCAL before the query", async () => {
    const recorder = newRecorder();
    const storage = makeStorage(recorder);

    await storage.search([0.1, 0.2, 0.3], { limit: 5, filters: { status: "TODO" } });

    expect(recorder.transactionCount).toBe(1);
    // The raw `.unsafe()` path must NOT also fire — a filtered search runs
    // entirely inside the transaction, or the SET LOCAL applies to a different
    // connection than the query and buys nothing.
    expect(recorder.unsafeCalls).toEqual([]);

    expect(recorder.txStatements).toHaveLength(2);
    // Order is load-bearing: SET LOCAL must precede the query it governs.
    expect(at(recorder.txStatements, 0)).toBe("SET LOCAL hnsw.iterative_scan = strict_order");
    expect(at(recorder.txStatements, 1)).toContain("WHERE status =");
    expect(at(recorder.txStatements, 1)).toContain("ORDER BY vector <->");
  });

  test("a filters bag with only null values takes the unfiltered path", async () => {
    const recorder = newRecorder();
    const storage = makeStorage(recorder);

    await storage.search([0.1, 0.2, 0.3], { limit: 5, filters: { status: null } });

    expect(recorder.transactionCount).toBe(0);
    expect(recorder.unsafeCalls).toHaveLength(1);
  });

  test("the threshold filter still applies on the filtered path", async () => {
    const recorder = newRecorder();
    const storage = makeStorage(recorder);

    // The fake returns a single row scoring 0.25; a threshold below that drops it.
    const results = await storage.search([0.1, 0.2, 0.3], {
      limit: 5,
      filters: { status: "TODO" },
      threshold: 0.1,
    });

    expect(results).toEqual([]);
  });
});
