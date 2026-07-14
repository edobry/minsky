/**
 * Tests for the raw-SQL pooler guard (mt#2773).
 *
 * The guard bounds in-flight `.unsafe()` queries at the pool's max —
 * zero-bind queries submitted beyond pool capacity wedge the Supavisor
 * transaction pooler and postgres-js never settles some of the destroyed
 * connection's promises.
 */
import { describe, test, expect, mock } from "bun:test";
import { guardRawSqlAgainstPoolerWedge } from "./raw-sql-pooler-guard";

/** Build a minimal postgres-js-like callable with a mocked .unsafe. */
function fakeSql(opts?: { max?: number; delayMs?: number; failEvery?: number }) {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const unsafe = mock(async (_q: string, _p?: unknown[], _o?: Record<string, unknown>) => {
    const call = ++calls;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, opts?.delayMs ?? 2));
    inFlight--;
    if (opts?.failEvery && call % opts.failEvery === 0) {
      throw new Error("CONNECTION_DESTROYED");
    }
    return [{ one: call }];
  });
  const tagged = mock((..._args: unknown[]) => Promise.resolve([{ tagged: true }]));
  const sql = ((...args: unknown[]) => tagged(...args)) as unknown as Record<string, unknown> &
    ((...args: unknown[]) => unknown);
  sql.unsafe = unsafe;
  sql.end = mock(() => Promise.resolve());
  sql.options = { max: opts?.max ?? 15 };
  return { sql, unsafe, tagged, stats: () => ({ maxInFlight }) };
}

describe("guardRawSqlAgainstPoolerWedge (mt#2773)", () => {
  test("in-flight queries never exceed the pool max; all callers settle", async () => {
    const { sql, unsafe, stats } = fakeSql({ max: 4 });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);

    const results = await Promise.all(
      Array.from({ length: 30 }, () => guarded.unsafe("SELECT 1 AS one"))
    );

    expect(unsafe).toHaveBeenCalledTimes(30);
    expect(stats().maxInFlight).toBeLessThanOrEqual(4);
    expect(results).toHaveLength(30);
  });

  test("a rejecting query releases its slot — the queue keeps draining", async () => {
    const { sql, unsafe } = fakeSql({ max: 2, failEvery: 3 });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () => guarded.unsafe("SELECT 1 AS one"))
    );

    expect(unsafe).toHaveBeenCalledTimes(12);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(4);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(8);
  });

  test("params and options forward verbatim; params default to []", async () => {
    const { sql, unsafe } = fakeSql();
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);

    await guarded.unsafe("SELECT $1::int AS one", [7] as never, { simple: true } as never);
    await guarded.unsafe("SELECT 1 AS one");

    expect(unsafe.mock.calls).toHaveLength(2);
    const [, params1, options1] = unsafe.mock.calls[0] ?? [];
    expect(params1).toEqual([7]);
    expect(options1).toEqual({ simple: true });
    const [, params2, options2] = unsafe.mock.calls[1] ?? [];
    expect(params2).toEqual([]);
    expect(options2).toEqual({});
  });

  test("explicit limit override beats options.max; missing options.max falls back", async () => {
    const { sql, stats } = fakeSql({ max: 15 });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never, 2);
    await Promise.all(Array.from({ length: 10 }, () => guarded.unsafe("SELECT 1")));
    expect(stats().maxInFlight).toBeLessThanOrEqual(2);

    const bare = fakeSql();
    delete (bare.sql as Record<string, unknown>).options;
    const guardedBare = guardRawSqlAgainstPoolerWedge(bare.sql as never);
    await guardedBare.unsafe("SELECT 1");
    expect(bare.unsafe).toHaveBeenCalledTimes(1);
  });

  test("tagged-template invocation and other properties forward to the underlying instance", async () => {
    const { sql, tagged } = fakeSql();
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);

    await (guarded as unknown as (...args: unknown[]) => Promise<unknown>)(["SELECT 1"], []);

    expect(tagged).toHaveBeenCalledTimes(1);
    expect((guarded as unknown as { options: { max: number } }).options.max).toBe(15);
    expect(typeof (guarded as unknown as { end: unknown }).end).toBe("function");
  });
});
