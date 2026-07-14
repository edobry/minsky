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
  const startedOrder: number[] = [];
  const unsafe = mock(async (q: string, _p?: unknown[], _o?: Record<string, unknown>) => {
    const call = ++calls;
    const tagMatch = /--#(\d+)$/.exec(q);
    if (tagMatch) startedOrder.push(Number(tagMatch[1]));
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
  const begin = mock(async (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true }));
  const listen = mock(async () => ({ unlisten: () => {} }));
  const sql = ((...args: unknown[]) => tagged(...args)) as unknown as Record<string, unknown> &
    ((...args: unknown[]) => unknown);
  sql.unsafe = unsafe;
  sql.end = mock(() => Promise.resolve());
  sql.begin = begin;
  sql.listen = listen;
  sql.options = { max: opts?.max ?? 15 };
  return { sql, unsafe, tagged, begin, listen, stats: () => ({ maxInFlight, startedOrder }) };
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

  test("begin() and listen() pass through to the underlying instance (PR #1922 R1)", async () => {
    const { sql, begin, listen } = fakeSql();
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);

    const txResult = await (
      guarded as unknown as { begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }
    ).begin(async (tx) => tx);
    await (guarded as unknown as { listen: () => Promise<unknown> }).listen();

    expect(begin).toHaveBeenCalledTimes(1);
    expect(txResult).toEqual({ tx: true });
    expect(listen).toHaveBeenCalledTimes(1);
  });

  test("waiters drain in FIFO submission order, including past clustered rejections (PR #1922 R1)", async () => {
    const { sql, stats } = fakeSql({ max: 2, failEvery: 2, delayMs: 1 });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never, 2);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => guarded.unsafe(`SELECT 1 AS one --#${i}`))
    );

    // Every query was submitted despite every-other-one rejecting...
    expect(stats().startedOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // ...and rejections surfaced without stalling the queue.
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(5);
  });

  test("PendingQuery chaining methods exist but throw loudly with a pointer (PR #1922 R1)", async () => {
    const { sql } = fakeSql();
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);

    const rows = guarded.unsafe("SELECT 1 AS one");
    const asChainable = rows as unknown as { cursor: () => unknown; stream: () => unknown };

    expect(() => asChainable.cursor()).toThrow(/pooler-guarded .unsafe\(\)/);
    expect(() => asChainable.stream()).toThrow(/mt#2773/);
    await rows; // the promise itself still resolves normally
  });
});
