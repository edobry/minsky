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
 * The guard therefore bounds IN-FLIGHT `.unsafe()` queries at the pool's
 * `max` (verified: 120 parameterless queries through a max-15 pool settle in
 * 1.2s under the cap, vs. permanent wedge without it). The cap applies to ALL
 * `.unsafe()` calls uniformly — including parameterized ones — BY DESIGN:
 * with-bind queries are empirically safe but pacing them too keeps the
 * invariant simple ("raw fan-out never exceeds the pool") and closes the
 * door on mixed batches re-creating ramp-up pressure. Do not work around the
 * cap by adding dummy binds. Queries beyond the cap wait in a plain
 * in-process FIFO — our queue, not postgres-js's — so a destroyed connection
 * can only ever affect queries actually submitted, and the queue keeps
 * draining on settle OR reject.
 *
 * Deliberately NOT applied to the underlying shared instance: drizzle's
 * postgres-js driver and `sql.begin()` transactions reach the raw instance
 * untouched (the wrapper is a get-trap Proxy; tagged-template invocation,
 * `begin`, `end`, `listen`, and every other property forward unchanged).
 * Residual (documented) gap: zero-bind queries issued through drizzle's own
 * driver bypass this guard — today's drizzle consumers are low-concurrency.
 */
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

/** Conservative fallback when the instance doesn't expose options.max. */
const DEFAULT_IN_FLIGHT_LIMIT = 10;

/**
 * PendingQuery chaining surface that the guarded `.unsafe()` deliberately
 * does NOT provide. Each member exists at runtime but throws with a pointer
 * here, so an untyped/casted caller fails loudly instead of crashing on an
 * undefined method (PR #1922 R1).
 */
const REJECTED_CHAINING_METHODS = [
  "cursor",
  "stream",
  "forEach",
  "execute",
  "cancel",
  "describe",
  "values",
  "raw",
  "simple",
  "readable",
  "writable",
] as const;

/**
 * The truthful type of the instance handed out by `getRawSqlConnection()`
 * (PR #1922 R1): full postgres-js `Sql` EXCEPT that `.unsafe()` returns a
 * plain `Promise` of rows — NOT a `PendingQuery` — so `.cursor()`,
 * `.stream()`, `.execute()` etc. are not available through it (they exist at
 * runtime only as loud throwing stubs). Tagged-template invocation and every
 * other member (`begin`, `end`, `listen`, `options`, ...) keep the raw
 * instance's contract.
 */
export type GuardedRawSql = Omit<Sql, "unsafe"> & {
  (template: TemplateStringsArray, ...parameters: unknown[]): PromiseLike<unknown>;
  unsafe(
    query: string,
    parameters?: unknown[],
    options?: Record<string, unknown>
  ): Promise<Record<string, unknown>[]>;
};

/**
 * Wrap a postgres-js instance so `.unsafe()` calls are capped at `limit`
 * concurrent in-flight queries (default: the pool's own `max`). Everything
 * else forwards to the underlying instance unchanged.
 */
export function guardRawSqlAgainstPoolerWedge(sql: Sql, limit?: number): GuardedRawSql {
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

  const guardedUnsafe = (
    query: string,
    params?: unknown[],
    options?: Record<string, unknown>
  ): Promise<Record<string, unknown>[]> => {
    const rows = (async () => {
      await acquire();
      try {
        return (await sql.unsafe(
          query,
          (params ?? []) as never,
          (options ?? {}) as never
        )) as Record<string, unknown>[];
      } finally {
        release();
      }
    })();
    // Loud runtime rejection of PendingQuery chaining for callers that cast
    // past the GuardedRawSql type (PR #1922 R1): fail with a pointer, not an
    // "undefined is not a function" crash.
    for (const method of REJECTED_CHAINING_METHODS) {
      Object.defineProperty(rows, method, {
        value: () => {
          throw new Error(
            `.${method}() is not available on the pooler-guarded .unsafe() — it returns plain rows, ` +
              `not a postgres-js PendingQuery (raw-sql-pooler-guard.ts, mt#2773). ` +
              `If chaining is genuinely needed, take an unguarded connection deliberately and bound your own fan-out.`
          );
        },
        enumerable: false,
      });
    }
    return rows;
  };

  /* eslint-disable custom/no-excessive-as-unknown -- deliberate boundary cast: the Proxy
     narrows `unsafe`'s return from PendingQuery to Promise<rows>, which makes Sql and
     GuardedRawSql structurally incompatible; the double assertion is the honest bridge. */
  return new Proxy(sql, {
    get(target, prop, receiver) {
      if (prop === "unsafe") return guardedUnsafe;
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as GuardedRawSql;
  /* eslint-enable custom/no-excessive-as-unknown */
}
