/**
 * Raw-SQL pooler guard (mt#2773).
 *
 * ZERO-BIND raw queries (`sql.unsafe(query)` with no parameters) submitted
 * concurrently beyond the pool's capacity wedge the shared client against the
 * Supabase/Supavisor TRANSACTION-mode pooler (:6543): connections get
 * destroyed (`write CONNECTION_DESTROYED`) during ramp-up, and a postgres-js
 * defect then leaves SOME of the destroyed connection's query promises
 * permanently unsettled (86 of 120 never resolved in the mt#2773 repro
 * matrix). One consumer fanning out parameterless raw queries can therefore
 * hang itself — and anything awaiting it — forever, as the reviewer cockpit
 * widget did in mt#2765.
 *
 * Why zero-bind specifically (mt#2773 experiment matrix):
 * - WITH binds, postgres-js sets `describeFirst` (connection.js:238 —
 *   `parameters.length && !prepared`) and sends Parse+Describe+Flush first,
 *   waiting a round trip before Bind/Execute. That gating self-paces
 *   submission; 120-concurrent settles in ~1.8s.
 * - WITHOUT binds, the whole extended sequence goes out in ONE pipelined
 *   write (`unnamed()`), and the simple protocol is a one-shot write too.
 *   Both one-shot shapes wedge under concurrent ramp-up against the
 *   transaction pooler (session mode :5432 is immune — it rejects overload
 *   CLEANLY with EMAXCONNSESSION).
 * - Forcing the extended protocol via `{ simple: false }` was tested and
 *   does NOT help — zero-bind extended is still a one-shot pipelined write.
 *   The protocol flag is NOT the lever; submission pacing is.
 *
 * The guard therefore bounds IN-FLIGHT raw queries at the pool's `max`
 * (verified: 120 parameterless queries through a max-15 pool settle in 1.2s
 * under the cap, vs. permanent wedge without it). Queries beyond the cap wait
 * in a plain in-process FIFO — our queue, not postgres-js's — so a destroyed
 * connection can only ever affect queries we actually submitted, and the
 * queue keeps draining on settle/reject either way.
 *
 * Deliberately NOT applied to the underlying shared instance: drizzle's
 * postgres-js driver and `sql.begin()` transactions reach the raw instance
 * untouched (the wrapper is a get-trap Proxy; tagged-template invocation,
 * `begin`, `end`, `listen`, and every other property forward unchanged).
 * Residual (documented) gap: zero-bind queries issued through drizzle's own
 * driver bypass this guard — today's drizzle consumers are low-concurrency.
 *
 * Limitation: the guarded `.unsafe()` returns a plain Promise of rows, not a
 * postgres-js Query object — `.cursor()`/`.stream()`/`.cancel()` chaining is
 * not available through it. Callsite audit (2026-07-14): no consumer of
 * `getRawSqlConnection()` uses those on `.unsafe()` results.
 */
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

/** Conservative fallback when the instance doesn't expose options.max. */
const DEFAULT_IN_FLIGHT_LIMIT = 10;

/**
 * Wrap a postgres-js instance so `.unsafe()` calls are capped at `limit`
 * concurrent in-flight queries (default: the pool's own `max`). Everything
 * else forwards to the underlying instance unchanged.
 */
export function guardRawSqlAgainstPoolerWedge(sql: Sql, limit?: number): Sql {
  const configuredMax = Number((sql as { options?: { max?: unknown } }).options?.max);
  const inFlightLimit = Math.max(
    1,
    limit ??
      (Number.isFinite(configuredMax) && configuredMax > 0
        ? configuredMax
        : DEFAULT_IN_FLIGHT_LIMIT)
  );

  let inFlight = 0;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (inFlight < inFlightLimit) {
      inFlight++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    inFlight++;
  }

  function release(): void {
    inFlight--;
    const next = waiters.shift();
    if (next) next();
  }

  const guardedUnsafe = async (
    query: string,
    params?: unknown[],
    options?: Record<string, unknown>
  ): Promise<unknown> => {
    await acquire();
    try {
      return await sql.unsafe(query, (params ?? []) as never, (options ?? {}) as never);
    } finally {
      release();
    }
  };

  return new Proxy(sql, {
    get(target, prop, receiver) {
      if (prop === "unsafe") return guardedUnsafe;
      return Reflect.get(target, prop, receiver);
    },
  }) as Sql;
}
