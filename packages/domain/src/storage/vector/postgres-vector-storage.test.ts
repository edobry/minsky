/**
 * PostgresVectorStorage — filtered-search recall fix (mt#4937).
 *
 * Two things are asserted here, and they are deliberately separate:
 *
 *  1. `buildFilterConditions` renders the right predicates, and REFUSES a
 *     filter key that is not a plain identifier. It is a pure function over a
 *     plain object, so this needs no database and no spy on a collaborator the
 *     class reaches itself.
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

  test("a scalar filter renders an equality predicate with the value BOUND, not inlined", () => {
    const conditions = buildFilterConditions({ status: "TODO" });
    expect(conditions).toHaveLength(1);

    const { sql, params } = render(at(conditions, 0));
    expect(sql).toContain("status =");
    // The value is a placeholder in the SQL and lives in params — it is never
    // interpolated as a literal.
    expect(sql).not.toContain("TODO");
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

  test("an empty *Exclude array emits NO predicate — it excludes nothing", () => {
    // PR #3598 R1, BLOCKING. The test that stood here asserted the OLD
    // fall-through (`statusExclude = $1`) as correct — a test written after the
    // code and shaped to it, which is the mem#704 shape: it passed whether or
    // not the behavior was right. An empty exclusion list excludes nothing, so
    // the correct rendering is no condition at all, which also routes the
    // search to the unfiltered path.
    expect(buildFilterConditions({ statusExclude: [] })).toEqual([]);
  });

  test("a filter key that is not a plain identifier is REFUSED, not quoted", () => {
    // Filter keys become SQL TEXT — a column name cannot be a placeholder — and
    // `filters` is `Record<string, unknown>` on a public interface, so the type
    // permits a caller to forward user input as a KEY. Refusing is deliberate:
    // quoting would accept the attempt and turn it into a lookup of an absurd
    // column name. PR #3598 R1, BLOCKING.
    expect(() => buildFilterConditions({ "status; DROP TABLE tasks_embeddings --": "x" })).toThrow(
      /refusing to render/
    );
    expect(() => buildFilterConditions({ "metadata->>'sourceName'": "x" })).toThrow(
      /refusing to render/
    );
    expect(() => buildFilterConditions({ "": "x" })).toThrow(/refusing to render/);
    expect(() => buildFilterConditions({ "1status": "x" })).toThrow(/refusing to render/);
  });

  test("the *Exclude branch validates the STRIPPED column name, not the raw key", () => {
    // The suffix is removed before rendering, so the guard has to run on what
    // is actually emitted. `a b Exclude` strips to `a b `, which is not an
    // identifier.
    expect(() => buildFilterConditions({ "a b Exclude": ["x"] })).toThrow(/refusing to render/);
  });

  test("legitimate identifiers still pass, including underscored and mixed-case ones", () => {
    expect(buildFilterConditions({ status: "TODO" })).toHaveLength(1);
    expect(buildFilterConditions({ source_name: "x" })).toHaveLength(1);
    expect(buildFilterConditions({ sourceName: "x" })).toHaveLength(1);
    expect(buildFilterConditions({ _private: "x" })).toHaveLength(1);
    expect(buildFilterConditions({ col2: "x" })).toHaveLength(1);
  });

  test("multiple filters produce one condition each, in insertion order", () => {
    const conditions = buildFilterConditions({ status: "TODO", backend: "minsky" });
    expect(conditions).toHaveLength(2);
    expect(render(at(conditions, 0)).params).toEqual(["TODO"]);
    expect(render(at(conditions, 1)).params).toEqual(["minsky"]);
  });

  test("a bare identifier still renders UNQUOTED — the mt#4937 choice, guarded here", () => {
    // `dsql.raw(key)` renders a bare key unquoted, which Postgres folds to
    // lowercase; `dsql.identifier(key)` would quote it and preserve case.
    // mt#4937 kept the historical unquoted rendering deliberately, and mt#4944
    // resolved the knowledge caller at the CALLER (it now names the JSONB
    // member) rather than by changing this. If someone "cleans this up", this
    // test is the tripwire.
    const { sql } = render(at(buildFilterConditions({ sourceName: "minsky-design" }), 0));
    expect(sql).toContain("sourceName =");
    expect(sql).not.toContain('"sourceName"');
  });
});

describe("buildFilterConditions — JSONB member targets (mt#4944)", () => {
  test("a dotted key targets a JSONB member, with the member name BOUND not interpolated", () => {
    // The whole defect: `sourceName` is a member of `metadata`, not a column.
    // Naming it bare rendered `sourceName = $1`, folded to `sourcename`, and
    // raised 42703 on every call.
    const { sql, params } = render(
      at(buildFilterConditions({ "metadata.sourceName": "minsky-design" }), 0)
    );

    expect(sql).toContain("metadata->>");
    // The member name is a PARAMETER, so it never reaches the statement as
    // text and cannot be case-folded or injected.
    expect(sql).not.toContain("sourceName");
    expect(params).toEqual(["sourceName", "minsky-design"]);
  });

  test("the column half of a dotted key is still identifier-validated", () => {
    expect(() => buildFilterConditions({ "meta data.sourceName": "x" })).toThrow(
      /refusing to render/
    );
    expect(() => buildFilterConditions({ "metadata;DROP TABLE x--.k": "v" })).toThrow(
      /refusing to render/
    );
  });

  test("a key with more than one dot, or an empty member, is refused rather than guessed at", () => {
    // Nested access needs `#>>` and a path array; inventing a second syntax
    // with no caller for it is speculative, so this fails loudly instead.
    expect(() => buildFilterConditions({ "metadata.a.b": "x" })).toThrow(
      /exactly one JSONB member/
    );
    expect(() => buildFilterConditions({ "metadata.": "x" })).toThrow(/exactly one JSONB member/);
  });
});

describe("buildFilterConditions — array set membership (mt#4944)", () => {
  test("an array value renders IN, not a scalar equality against an array", () => {
    // Before mt#4944 this rendered `sources = $1` with the whole array bound to
    // a scalar comparison — it matches nothing and reports no error, which is
    // the silent-zero shape this task removes.
    const { sql, params } = render(at(buildFilterConditions({ sources: ["a", "b"] }), 0));

    expect(sql).toContain("sources IN (");
    expect(sql).not.toContain("sources =");
    expect(params).toEqual(["a", "b"]);
  });

  test("set membership composes with a JSONB member target — the real knowledge shape", () => {
    const { sql, params } = render(
      at(buildFilterConditions({ "metadata.sourceName": ["minsky-design", "other"] }), 0)
    );

    expect(sql).toContain("metadata->>");
    expect(sql).toContain(" IN (");
    expect(params).toEqual(["sourceName", "minsky-design", "other"]);
  });

  test("a single-element array still uses IN, so one and many behave the same way", () => {
    const { sql, params } = render(at(buildFilterConditions({ sources: ["only"] }), 0));
    expect(sql).toContain("sources IN (");
    expect(params).toEqual(["only"]);
  });

  test("an empty array emits no predicate, symmetric with the *Exclude branch", () => {
    // `IN ()` is a syntax error, and a CLI array flag yields `undefined` rather
    // than `[]` when omitted — so an empty list is a degenerate input, not a
    // request to match nothing.
    expect(buildFilterConditions({ sources: [] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dispatch: which path a search takes, and what the transaction issues first
// ---------------------------------------------------------------------------

interface Rendered {
  sql: string;
  params: unknown[];
}

interface Recorder {
  unsafeCalls: Array<{ query: string; params: unknown[] }>;
  txStatements: Rendered[];
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
          recorder.txStatements.push(render(fragment));
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
    expect(at(recorder.txStatements, 0).sql).toBe("SET LOCAL hnsw.iterative_scan = strict_order");
    expect(at(recorder.txStatements, 1).sql).toContain("WHERE status =");
    expect(at(recorder.txStatements, 1).sql).toContain("ORDER BY vector <->");
  });

  test("the filtered query BINDS the vector, the limit, and the filter value", async () => {
    // PR #3598 R1, NON-BLOCKING, asserted rather than argued: drizzle's `sql`
    // template parameterizes every interpolated VALUE. Only `dsql.raw()` — used
    // solely for identifiers, which cannot be placeholders — reaches the SQL as
    // text. So the filtered path is parameterized to the same degree the
    // unfiltered one is; it just carries its placeholders in drizzle's numbering
    // rather than a hand-built `$1`/`$2`.
    const recorder = newRecorder();
    const storage = makeStorage(recorder);

    await storage.search([0.1, 0.2, 0.3], { limit: 5, filters: { status: "TODO" } });

    const query = at(recorder.txStatements, 1);
    expect(query.params).toEqual(["[0.1,0.2,0.3]", "TODO", "[0.1,0.2,0.3]", 5]);
    // None of those values appear as literals in the SQL text.
    expect(query.sql).not.toContain("TODO");
    expect(query.sql).not.toContain("0.1,0.2,0.3");
  });

  test("a filters bag with only null values takes the unfiltered path", async () => {
    const recorder = newRecorder();
    const storage = makeStorage(recorder);

    await storage.search([0.1, 0.2, 0.3], { limit: 5, filters: { status: null } });

    expect(recorder.transactionCount).toBe(0);
    expect(recorder.unsafeCalls).toHaveLength(1);
  });

  test("an empty *Exclude bag takes the unfiltered path rather than a broken filtered one", async () => {
    // The dispatch consequence of the R1 BLOCKING fix above: with no condition
    // produced, there is nothing to filter on, so the search must not open a
    // transaction at all.
    const recorder = newRecorder();
    const storage = makeStorage(recorder);

    await storage.search([0.1, 0.2, 0.3], { limit: 5, filters: { statusExclude: [] } });

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
