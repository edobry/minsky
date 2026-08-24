/**
 * Tests for the raw-SQL pooler guard (mt#2773).
 *
 * The guard bounds in-flight `.unsafe()` queries at the pool's max —
 * zero-bind queries submitted beyond pool capacity wedge the Supavisor
 * transaction pooler and postgres-js never settles some of the destroyed
 * connection's promises.
 */
import { describe, test, expect, mock } from "bun:test";
import {
  guardRawSqlAgainstPoolerWedge,
  getPoolerSaturation,
  POOLER_SATURATION,
  PoolAdmissionTimeoutError,
  POOL_ADMISSION_DEADLINE_MS,
  type PoolerSaturation,
} from "./raw-sql-pooler-guard";

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

  // mt#4308 — the saturation signal. Before this, an `ECHECKOUTTIMEOUT` mid-write
  // was the first notice that the pooler's client budget was exhausted, and
  // nothing aggregated it, so a recurrence read as an unrelated flake.
  test("saturation reports the cap and an idle pool before any query runs", () => {
    const { sql } = fakeSql({ max: 4 });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);

    const snap = (
      (guarded as unknown as Record<symbol, unknown>)[POOLER_SATURATION] as () => PoolerSaturation
    )();

    expect(snap.limit).toBe(4);
    expect(snap.inFlight).toBe(0);
    expect(snap.queued).toBe(0);
    expect(snap.saturated).toBe(false);
    expect(snap.everSaturated).toBe(false);
    // Distinct from "settled at epoch 0" — nothing has run yet.
    expect(snap.lastSettledAt).toBeNull();
  });

  test("everSaturated survives the burst that set it, after inFlight and queued return to zero", async () => {
    const { sql } = fakeSql({ max: 2, delayMs: 5 });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);
    const read = () =>
      (
        (guarded as unknown as Record<symbol, unknown>)[POOLER_SATURATION] as () => PoolerSaturation
      )();

    // Deliberately NOT awaited yet — the mid-burst read is the point.
    const inflight = Promise.all(
      Array.from({ length: 10 }, () => guarded.unsafe("SELECT 1 AS one"))
    );

    const during = read();
    expect(during.saturated).toBe(true);
    expect(during.queued).toBeGreaterThan(0);
    // The cap holds while saturated — this is the mt#2773 invariant, re-asserted
    // through the new counters rather than through the fake's own bookkeeping.
    expect(during.inFlight).toBeLessThanOrEqual(2);

    await inflight;

    const after = read();
    expect(after.inFlight).toBe(0);
    expect(after.queued).toBe(0);
    expect(after.saturated).toBe(false);
    // The load-bearing property: an operator reading this AFTER the incident
    // still learns the cap was reached. `saturated` alone would say "fine".
    expect(after.everSaturated).toBe(true);
    expect(after.peakQueued).toBeGreaterThan(0);
    expect(after.peakInFlight).toBe(2);
    expect(after.lastSettledAt).not.toBeNull();
  });

  test("getPoolerSaturation() exposes the guard without holding a reference to it", async () => {
    const { sql } = fakeSql({ max: 3 });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);

    await Promise.all(Array.from({ length: 6 }, () => guarded.unsafe("SELECT 1 AS one")));

    // This is the path `debug_systemInfo` takes — it has no handle on the
    // provider's memoized guard, only the module-level reader.
    const viaModule = getPoolerSaturation();
    expect(viaModule).not.toBeNull();
    expect(viaModule?.limit).toBe(3);
    expect(viaModule?.everSaturated).toBe(true);
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

/**
 * A fake whose `.unsafe()` returns a postgres-js-SHAPED PendingQuery: a
 * thenable carrying the pure builder mutators (`values`/`raw`/`simple`/
 * `describe`) that return `this`. The mt#2773 fake above returns a bare
 * Promise, which cannot exercise the chaining drizzle actually performs.
 *
 * `hold` lets a test park queries in flight so the cap is genuinely reached
 * rather than raced.
 */
function fakePendingQuerySql(opts?: { max?: number; hold?: boolean }) {
  const held: Array<() => void> = [];
  const unsafe = mock((_q: string, _p?: unknown[], _o?: Record<string, unknown>) => {
    // Per-CALL, like postgres-js's `isRaw` on the Query instance. A fake-level
    // `mode` would leak the first query's chaining into every later one.
    let mode: string | null = null;
    const run = async () => {
      // Yield before reading `mode`, exactly as postgres-js does: `.values()`
      // only sets `isRaw`, and the flag is not consulted until the query is
      // DISPATCHED (`Query.handle()` does `await 1` first). A fake that read it
      // synchronously here would read it before any caller could chain, and
      // would report a correct replay as a failure.
      await Promise.resolve();
      if (opts?.hold) await new Promise<void>((resolve) => held.push(resolve));
      if (mode === "values") return [["row-as-array"]];
      if (mode === "raw") return [["row-as-raw"]];
      return [{ row: "as-object" }];
    };
    const pending = run() as Promise<unknown> & Record<string, () => unknown>;
    for (const method of ["values", "raw", "simple", "describe"]) {
      Object.defineProperty(pending, method, {
        value: () => {
          mode = method;
          return pending;
        },
        enumerable: false,
      });
    }
    return pending;
  });
  const sql = ((..._args: unknown[]) => Promise.resolve([])) as unknown as Record<string, unknown> &
    ((...args: unknown[]) => unknown);
  sql.unsafe = unsafe;
  sql.options = { max: opts?.max ?? 8 };
  return {
    sql,
    unsafe,
    releaseAll: () => {
      while (held.length) held.shift()?.();
    },
    heldCount: () => held.length,
  };
}

/** Read a guard's saturation snapshot without holding a module-level reference. */
function readSaturation(guarded: unknown): PoolerSaturation {
  return ((guarded as Record<symbol, unknown>)[POOLER_SATURATION] as () => PoolerSaturation)();
}

/** Resolves to "pending" if `p` has not settled within `ms`. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<"settled" | "pending"> {
  return Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const
    ),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

describe("bounded admission on the drizzle path (mt#4473)", () => {
  // AT1 — the negative control, recorded FIRST. This is the pre-mt#4473 shape:
  // the guard's queue with no deadline on the wait. It must NOT settle.
  //
  // The control restores the FULL pre-fix state rather than approximating it
  // (mt#4512): the only difference from the assertion below is the admission
  // deadline, so a caller parked here is parked for exactly the reason the fix
  // addresses. 2_000_000_000ms is used rather than Infinity because setTimeout
  // clamps above 2^31-1 and would fire IMMEDIATELY, inverting the control.
  test("negative control: with no admission deadline, an over-cap caller never settles", async () => {
    const { sql, releaseAll } = fakePendingQuerySql({ max: 1, hold: true });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never, 1, 2_000_000_000);

    const holder = guarded.unsafe("SELECT 1");
    const overCap = guarded.unsafe("SELECT 2");

    expect(await settlesWithin(overCap, 150)).toBe("pending");
    // ...and it is parked in OUR queue, which is the state the fix bounds.
    expect(readSaturation(guarded).queued).toBe(1);

    // Drain deliberately rather than abandoning the promises: the holder's
    // release is what finally admits the over-cap caller, and only then does it
    // reach the fake's own hold. Two rounds, in that order.
    releaseAll();
    await holder;
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseAll();
    await overCap;
  });

  // AT2 — after the fix, the same load produces bounded outcomes: every call
  // either completes or fails with the typed error; none hangs past the bound.
  test("an over-cap caller is refused with the typed error inside the deadline", async () => {
    const { sql, releaseAll } = fakePendingQuerySql({ max: 1, hold: true });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never, 1, 50);

    const holder = guarded.unsafe("SELECT 1");
    const overCap = guarded.unsafe("SELECT 2");

    // Settles — the whole point — and settles as a REFUSAL, not a hang.
    expect(await settlesWithin(overCap, 500)).toBe("settled");
    await expect(overCap).rejects.toBeInstanceOf(PoolAdmissionTimeoutError);

    releaseAll();
    await Promise.allSettled([holder]);
  });

  test("a refused caller consumes no slot, so the pool keeps serving afterwards", async () => {
    const { sql, releaseAll } = fakePendingQuerySql({ max: 1, hold: true });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never, 1, 40);

    const holder = guarded.unsafe("SELECT 1");
    await expect(guarded.unsafe("SELECT 2")).rejects.toBeInstanceOf(PoolAdmissionTimeoutError);

    // The refusal must not have decremented inFlight — that would over-admit
    // against a pool the holder still occupies.
    expect(readSaturation(guarded).inFlight).toBe(1);

    releaseAll();
    await holder;
    expect(readSaturation(guarded).inFlight).toBe(0);
  });

  // AT5 — the error names the cause and the remedy, asserted on its text.
  // A generic timeout is what cost ~45 minutes on 2026-08-23.
  test("the refusal error names the cause and the remedy, not just a timeout", async () => {
    const error = new PoolAdmissionTimeoutError(30_000, 8, 3);

    expect(error.code).toBe("EPOOLADMISSIONTIMEOUT");
    // Cause: which pool, and that it is NOT the database being down.
    expect(error.message).toMatch(/8 pooled connections/);
    expect(error.message).toMatch(/not a database outage/);
    expect(error.message).toMatch(/no checkout timeout/);
    // Remedy: something the operator can actually run.
    expect(error.message).toMatch(/minsky mcp restart --execute/);
    expect(error.message).toMatch(/poolerSaturation/);
  });

  // AT3 — saturation reports the drizzle path. The pre-mt#4473 blind spot was
  // that a pool exhausted by drizzle traffic read all zeros here.
  test("saturation counts queries issued the way drizzle issues them", async () => {
    const { sql, releaseAll } = fakePendingQuerySql({ max: 2, hold: true });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never, 2, 40);

    // drizzle's exact call shape: client.unsafe(query, params).values()
    const drizzleShaped = Array.from({ length: 4 }, (_, i) =>
      guarded.unsafe(`SELECT ${i}`, []).values()
    );

    const during = readSaturation(guarded);
    expect(during.inFlight).toBe(2);
    expect(during.queued).toBe(2);
    expect(during.saturated).toBe(true);

    // The two queued callers exceed the deadline and are refused.
    const outcomes = await Promise.allSettled(drizzleShaped.slice(2));
    expect(outcomes.every((o) => o.status === "rejected")).toBe(true);

    const after = readSaturation(guarded);
    expect(after.refused).toBe(2);
    expect(after.lastRefusedAt).not.toBeNull();
    expect(after.everSaturated).toBe(true);

    releaseAll();
    await Promise.allSettled(drizzleShaped.slice(0, 2));
  });

  test("`.values()` is recorded and replayed onto the real PendingQuery", async () => {
    const { sql, unsafe } = fakePendingQuerySql({ max: 4 });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);

    // Without replay this returns the object-shaped rows — which is exactly how
    // drizzle's select path would silently mis-map every column.
    const values = await guarded.unsafe("SELECT 1", []).values();
    expect(values).toEqual([["row-as-array"]]);
    expect(unsafe).toHaveBeenCalledTimes(1);

    const objects = await guarded.unsafe("SELECT 1", []);
    expect(objects).toEqual([{ row: "as-object" }]);
  });

  // PR #3293 R1 non-blocking: `.raw()` is the other recorded mutator and was
  // untested. Same record-and-replay path, different `isRaw` value.
  test("`.raw()` is recorded and replayed too, independently of `.values()`", async () => {
    const { sql } = fakePendingQuerySql({ max: 4 });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);

    expect(await guarded.unsafe("SELECT 1", []).raw()).toEqual([["row-as-raw"]]);
    // Each query records its OWN chain — a shared recorder would leak the
    // previous query's mode into this one.
    expect(await guarded.unsafe("SELECT 1", []).values()).toEqual([["row-as-array"]]);
    expect(await guarded.unsafe("SELECT 1", [])).toEqual([{ row: "as-object" }]);
  });

  // PR #3293 R1 BLOCKING, fixed at the class rather than the instance. The
  // reviewer flagged `describe()`; `simple()` is its sibling and was flagged by
  // nothing. Both mutate `options.simple` / `options.prepare` rather than the
  // row shape, and the protocol shape is what mt#2773's guard exists to
  // control — the simple protocol is one of the one-shot write shapes in its
  // own experiment matrix. Neither is replayable; both must fail loudly.
  test("protocol-mutating chaining (`simple`/`describe`) is REJECTED, not replayed", async () => {
    const { sql } = fakePendingQuerySql({ max: 4 });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);

    const rows = guarded.unsafe("SELECT 1", []);
    const asChainable = rows as unknown as { simple: () => unknown; describe: () => unknown };

    expect(() => asChainable.simple()).toThrow(/pooler-guarded .unsafe\(\)/);
    expect(() => asChainable.describe()).toThrow(/mt#2773/);
    // The query itself is unaffected and still resolves as plain rows — a
    // rejected chain must not poison the promise it was called on.
    expect(await rows).toEqual([{ row: "as-object" }]);
  });

  // AT4 / SC5 — the bound must not degrade normal operation. Shown by a
  // measurement, not asserted: this is the load mt#4360 measured on the live
  // daemon (21 requests in flight against a max-8 pool) at the REAL deadline.
  test("a realistic 21-in-flight burst over a max-8 pool produces zero refusals", async () => {
    const { sql } = fakeSql({ max: 8, delayMs: 5 });
    const guarded = guardRawSqlAgainstPoolerWedge(sql as never);

    // performance.now(), not Date.now(): this is an elapsed-time measurement, and
    // `custom/no-real-fs-in-tests` reads Date.now() in a test as unique-path generation.
    const startedAt = performance.now();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 21 }, (_, i) => guarded.unsafe(`SELECT ${i}`))
    );
    const elapsedMs = performance.now() - startedAt;

    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(0);
    const snap = readSaturation(guarded);
    expect(snap.refused).toBe(0);
    // The cap WAS reached (so the test is not vacuous)...
    expect(snap.everSaturated).toBe(true);
    // ...and the burst still cleared with orders of magnitude of headroom
    // against the 30s deadline. The margin is the point, so assert it.
    expect(elapsedMs).toBeLessThan(POOL_ADMISSION_DEADLINE_MS / 10);
  });
});
