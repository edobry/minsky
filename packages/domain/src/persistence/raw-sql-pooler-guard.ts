/**
 * Raw-SQL pooler guard (mt#2773), extended to the drizzle path (mt#4473).
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
 * cap by adding dummy binds.
 *
 * ## The drizzle path is this path (mt#4473)
 *
 * mt#2773 documented a carve-out: "drizzle's postgres-js driver and
 * `sql.begin()` transactions reach the raw instance untouched … zero-bind
 * queries issued through drizzle's own driver bypass this guard — today's
 * drizzle consumers are low-concurrency." Two things changed.
 *
 * They are no longer low-concurrency: every DB-backed MCP tool reaches
 * Postgres through drizzle, and on 2026-08-23 eight concurrent long-running
 * MCP calls saturated the pool and hung every subsequent DB-backed call for
 * ~45 minutes across three conversations, with no error and no log line.
 *
 * And the carve-out was never a property of drizzle. `drizzle-orm`'s
 * postgres-js driver issues EVERY query through `client.unsafe(query, params)`
 * (`drizzle-orm/postgres-js/session.js:58,68,90,128,131`) — so the drizzle
 * path IS the `.unsafe()` path at the driver level. The bypass existed only
 * because `postgres-provider.ts` handed `drizzle()` the RAW client instead of
 * the guarded one. It now hands over the guarded one, and the two paths share
 * a single in-flight counter (one memoized guard per process, mt#4298 — two
 * guards would each admit `max` and double the bound).
 *
 * `sql.begin()` transactions are STILL outside the bound: `begin` forwards
 * through the Proxy untouched and runs its statements on a connection the
 * guard never sees. Stated rather than fixed — changing transaction behaviour
 * is a wider blast radius than mt#4473 took on.
 *
 * ## Beyond the cap: a bounded wait, then a typed refusal (mt#4473)
 *
 * `postgres` (postgres.js) 3.4.8 has NO checkout timeout. Verified against the
 * installed source: `handler(query)` (`postgres/src/index.js:329`) dispatches
 * to an `open`, then `closed`, then `busy` connection, and otherwise pushes
 * onto a plain untimed array (`src/queue.js`); the option list is
 * `idle_timeout | connect_timeout | max_lifetime | max_pipeline | backoff |
 * keep_alive`, with nothing that bounds waiting for a free connection. Note
 * the dominant path at `max` is the `busy` branch, not the queue: a new query
 * is PIPELINED onto a connection already running a long one, and a Postgres
 * session executes its queries in order — so it head-of-line blocks with no
 * bound. That is why the cap has to admit ABOVE the driver rather than time
 * out around it: it stops the query being handed to a busy connection at all.
 *
 * So queries beyond the cap wait in a plain in-process FIFO — our queue, not
 * postgres-js's — and that wait is bounded by `POOL_ADMISSION_DEADLINE_MS`.
 * On expiry the caller gets `PoolAdmissionTimeoutError` naming the cause and
 * the remedy. **The deadline expires while the caller is still in OUR queue,
 * before the query is submitted to postgres-js.** That placement is
 * load-bearing: postgres-js exposes no cancellation, so a deadline applied
 * after submission would return to the caller and leave the query
 * permanently parked in the driver, leaking one slot per timeout — the exact
 * accumulation `readiness-probe.ts` had to add `outstandingSince` tracking to
 * avoid (PR #3265 R1).
 *
 * Why a bounded WAIT rather than ADR-041 Question 3's immediate refusal: that
 * decision governs the loopback gateway, whose callers have direct-connect as
 * a fallback on every path (Question 7), so a refusal there degrades to
 * today's performance. A DB-backed MCP tool call inside the daemon has no
 * fallback — a refusal IS the error — and ordinary single-conversation work
 * was measured at 21 requests in flight against this pool, clearing in well
 * under a second. Refusing at the cap would convert ordinary bursts into
 * user-visible failures. The invariant ADR-041 actually protects (never an
 * unbounded wait, never convert a fast failure into a slow one) is preserved.
 */
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

/** Conservative fallback when the instance doesn't expose options.max. */
const DEFAULT_IN_FLIGHT_LIMIT = 10;

/**
 * How long a caller waits for a pooled connection before being refused (mt#4473).
 *
 * Derived from both directions per `decision-defaults §Thresholds`, because
 * this threshold has a real floor AND a real ceiling:
 *
 * - FLOOR — observed cadence. It must not refuse ordinary bursts. The shared
 *   daemon was measured at 21 requests in flight against its own pool during
 *   single-conversation lifecycle work (mt#4360, 2026-08-24), at a measured
 *   query latency around 150ms. Twenty-one over a max-8 pool is three batches,
 *   ~450ms; a pathological 30-in-flight burst of 500ms queries is ~2s. 30s is
 *   roughly 65x the measured case and 15x the pathological one.
 * - CEILING — a budget declared elsewhere, which is the CEILING case that rule
 *   names: the MCP call cap is 120s, so the admission wait must leave room for
 *   the query itself plus transport. 30s leaves 90s.
 *
 * Biased to the high end of that band deliberately. Within it, a lower value
 * sheds faster and a higher one produces fewer spurious refusals under
 * legitimately slow load; a spurious refusal breaks a user's tool call, while
 * a slower refusal costs seconds against an outage that today costs ~45
 * minutes. When the pool is genuinely wedged, every value in the band fires —
 * only the latency differs.
 */
export const POOL_ADMISSION_DEADLINE_MS = 30_000;

/**
 * Raised when a caller waited `POOL_ADMISSION_DEADLINE_MS` for one of the
 * pool's connections and none became free (mt#4473).
 *
 * Carries the cause and the remedy in its message rather than leaving a
 * generic timeout: the 2026-08-23 incident cost ~45 minutes largely because
 * the failure was indistinguishable from slowness.
 */
export class PoolAdmissionTimeoutError extends Error {
  /** Stable, greppable discriminator for callers that branch on the cause. */
  readonly code = "EPOOLADMISSIONTIMEOUT";
  readonly deadlineMs: number;
  readonly limit: number;
  readonly queued: number;

  constructor(deadlineMs: number, limit: number, queued: number) {
    super(
      `Database query refused: waited ${deadlineMs}ms for one of this process's ${limit} pooled ` +
        `connections and none became free (${queued} caller(s) still waiting). ` +
        `CAUSE: connection-pool saturation in THIS process, not a database outage — the queries ` +
        `holding the pool are long-running or wedged, and postgres.js has no checkout timeout, so ` +
        `this wait is bounded here instead of hanging forever (mt#4473). ` +
        `REMEDY: 'minsky mcp status' reports db: degraded for this condition and ` +
        `'minsky mcp restart --execute' clears it; 'debug_systemInfo.poolerSaturation' shows the ` +
        `live in-flight/queued/refused counters.`
    );
    this.name = "PoolAdmissionTimeoutError";
    this.deadlineMs = deadlineMs;
    this.limit = limit;
    this.queued = queued;
  }
}

/**
 * Builder methods the guard RECORDS and replays onto the real `PendingQuery`
 * at submission time (mt#4473).
 *
 * The line is drawn at ROW SHAPE vs PROTOCOL, and it is drawn there for this
 * guard's own reason. `values()` and `raw()` set `isRaw` and nothing else —
 * they change how the returned rows are shaped and leave the wire protocol
 * alone, so replaying them is invisible to the pacing invariant.
 *
 * `simple()` and `describe()` are NOT here even though both also return
 * `this`, because both mutate `options.simple` / `options.prepare` — and the
 * protocol shape is precisely what this guard exists to control. Per mt#2773's
 * experiment matrix above, the simple protocol is one of the one-shot write
 * shapes that wedges the transaction pooler; letting a caller flip it THROUGH
 * the guard would hand them a way to re-create the condition the guard
 * prevents. `describe()` additionally resolves to a statement description
 * rather than rows, so replaying it would resolve this promise to a shape its
 * own type denies (PR #3293 R1, BLOCKING). Both stay in the rejected set,
 * where they fail loudly with a pointer.
 *
 * `values()` is the load-bearing member: drizzle's postgres-js driver calls
 * `client.unsafe(query, params).values()` on its main select path
 * (`drizzle-orm/postgres-js/session.js:68,128`), so a guard that threw on it
 * would break every select that maps fields.
 */
const REPLAYABLE_CHAINING_METHODS = ["values", "raw"] as const;

type ReplayableChainingMethod = (typeof REPLAYABLE_CHAINING_METHODS)[number];

/**
 * PendingQuery chaining surface that the guarded `.unsafe()` deliberately
 * does NOT provide. Each member exists at runtime but throws with a pointer
 * here, so an untyped/casted caller fails loudly instead of crashing on an
 * undefined method (PR #1922 R1).
 *
 * Two groups, rejected for different reasons. `cursor` / `stream` / `forEach`
 * / `execute` / `cancel` / `readable` / `writable` START, stream, or cancel
 * execution, so they are not pure mutators and cannot be recorded at all.
 * `simple` / `describe` ARE pure mutators and are still rejected, because they
 * change the wire protocol rather than the row shape — see
 * `REPLAYABLE_CHAINING_METHODS` for why that distinction is the one this guard
 * cares about.
 */
const REJECTED_CHAINING_METHODS = [
  "cursor",
  "stream",
  "forEach",
  "execute",
  "cancel",
  "readable",
  "writable",
  "simple",
  "describe",
] as const;

/**
 * A guarded `.unsafe()` result: a real Promise of rows, plus the recordable
 * subset of postgres-js's PendingQuery builder surface.
 *
 * Deliberately a Promise rather than a lazy thenable — a lazy one would defer
 * `acquire()` into a microtask, which changes both the FIFO submission order
 * and the point at which saturation becomes observable.
 */
export type GuardedPendingQuery<TRows = Record<string, unknown>[]> = Promise<TRows> & {
  /** Rows as ARRAYS of column values, not objects — postgres-js's `isRaw = "values"`. */
  values(): GuardedPendingQuery<unknown[][]>;
  /** Rows as arrays of RAW (unparsed) column buffers — postgres-js's `isRaw = true`. */
  raw(): GuardedPendingQuery<unknown[][]>;
};

/**
 * The truthful type of the instance handed out by `getRawSqlConnection()`
 * (PR #1922 R1): full postgres-js `Sql` EXCEPT that `.unsafe()` returns a
 * `GuardedPendingQuery` — a plain `Promise` of rows carrying only the
 * recordable builder methods, NOT a full `PendingQuery`, so `.cursor()`,
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
  ): GuardedPendingQuery;
};

/**
 * Well-known key for reading a guard's saturation snapshot (mt#4308).
 *
 * Served by the Proxy's get-trap rather than added to `GuardedRawSql`'s shape,
 * so the guarded instance stays structurally a postgres-js client for every
 * existing consumer. `Symbol.for` (not a private symbol) so a reader in another
 * module can look it up without importing this file.
 */
export const POOLER_SATURATION = Symbol.for("minsky.poolerSaturation");

/**
 * Point-in-time view of how close the guarded path is to its cap.
 *
 * WHY THIS EXISTS: before mt#4308 the first notice of pooler exhaustion was an
 * `ECHECKOUTTIMEOUT` surfacing as a failed write mid-operation, with nothing
 * aggregating it — so a recurrence read as an unrelated flake. These counters
 * are the guard's own, already maintained for the cap; exposing them costs
 * nothing at runtime.
 *
 * COVERAGE (mt#4473 — this paragraph previously disclaimed drizzle): this now
 * observes BOTH the `.unsafe()` path and drizzle's own driver traffic, because
 * drizzle issues every query through `.unsafe()` and `postgres-provider.ts`
 * builds the drizzle client over the guarded instance. `sql.begin()`
 * transactions remain outside it — `begin` forwards through the Proxy — so
 * they contend for the same pool and are invisible here. `queued > 0` is
 * therefore a sufficient signal of saturation and still not a strictly
 * necessary one, but the traffic it used to be blind to (every DB-backed MCP
 * tool) is now counted.
 */
export interface PoolerSaturation {
  /** In-flight cap — the pool's `max`, or the explicit `limit` override. */
  limit: number;
  /** Guarded queries executing right now. */
  inFlight: number;
  /** Callers parked waiting for a slot right now. Non-zero means at the cap. */
  queued: number;
  /** High-water mark of `inFlight` for this guard's lifetime. */
  peakInFlight: number;
  /** High-water mark of `queued`. Non-zero means the cap was reached at least once. */
  peakQueued: number;
  /** ISO timestamp of the last query to settle, or null if none has. */
  lastSettledAt: string | null;
  /** True while callers are parked — saturated at this instant. */
  saturated: boolean;
  /** True if the cap was ever reached. Survives the burst that caused it. */
  everSaturated: boolean;
  /**
   * Callers refused with `PoolAdmissionTimeoutError` for this guard's lifetime
   * (mt#4473).
   *
   * The one counter here that reports a FAILURE rather than a load level, and
   * the one an operator should read first: `peakQueued > 0` says the cap was
   * reached, which is ordinary under burst; `refused > 0` says a caller waited
   * the full admission deadline and got nothing, which is the outage shape.
   */
  refused: number;
  /** ISO timestamp of the most recent refusal, or null if there has been none. */
  lastRefusedAt: string | null;
  /**
   * How many guards this process has constructed (PR #3177 review).
   *
   * The reader below reports the LATEST guard, which is accurate only while
   * there is one. Rather than assert that invariant in prose and leave it
   * unchecked, this exposes the number so a reader can see when it stops
   * holding: `guardCount > 1` means the other fields describe one guard among
   * several and understate total demand.
   *
   * Deliberately NOT enforced by throwing — tests legitimately construct many
   * guards, and a hard failure would make the invariant untestable. Production
   * routes every consumer through one memoized instance (mt#4298), so a
   * `guardCount > 1` reading outside tests is the signal that something
   * re-wrapped the client.
   */
  guardCount: number;
}

/** Count of guards constructed in this process. See `PoolerSaturation.guardCount`. */
let guardsConstructed = 0;

/**
 * Most recently constructed guard's snapshot reader (mt#4308).
 *
 * ASSUMPTION, stated because it is what makes this accurate: there is ONE guard
 * per process. `PostgresPersistenceProvider.getGuardedSql()` memoizes a single
 * instance and every consumer — `.unsafe()` callers AND the drizzle client
 * (mt#4473) — is routed through it, deliberately, since the cap is a SHARED
 * counter and a second wrap would double the bound (mt#4298). If that ever
 * stops holding, this reader reports the last guard constructed rather than
 * the aggregate, and it should become a registry.
 *
 * Returns null before any guard exists — a process that has not opened a pool,
 * which is distinct from a pool sitting idle at zero.
 */
let latestGuardSaturation: (() => PoolerSaturation) | null = null;

export function getPoolerSaturation(): PoolerSaturation | null {
  return latestGuardSaturation === null ? null : latestGuardSaturation();
}

/** A caller parked waiting for a slot, with the timer that will refuse it. */
interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Wrap a postgres-js instance so guarded queries are capped at `limit`
 * concurrent in-flight (default: the pool's own `max`), with waits beyond the
 * cap bounded by `admissionDeadlineMs`. Everything else forwards to the
 * underlying instance unchanged.
 */
export function guardRawSqlAgainstPoolerWedge(
  sql: Sql,
  limit?: number,
  admissionDeadlineMs: number = POOL_ADMISSION_DEADLINE_MS
): GuardedRawSql {
  const configuredMax = Number((sql as { options?: { max?: unknown } }).options?.max);
  const inFlightLimit = Math.max(
    1,
    limit ??
      (Number.isFinite(configuredMax) && configuredMax > 0
        ? configuredMax
        : DEFAULT_IN_FLIGHT_LIMIT)
  );

  let inFlight = 0;
  const waiters: Waiter[] = [];
  // mt#4308 saturation counters. Peaks are high-water marks rather than
  // instantaneous reads because a burst is over by the time anyone asks: an
  // operator reading this after an incident needs to know the cap WAS reached,
  // which `inFlight`/`queued` alone cannot tell them once things settle.
  let peakInFlight = 0;
  let peakQueued = 0;
  let lastSettledAt: number | null = null;
  let refused = 0;
  let lastRefusedAt: number | null = null;

  function admit(): void {
    inFlight++;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
  }

  async function acquire(): Promise<void> {
    if (inFlight < inFlightLimit) {
      admit();
      return;
    }
    // mt#4473: the wait is bounded, and it is bounded HERE — before the query
    // reaches postgres-js, which offers no way to cancel one once submitted.
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          refused++;
          lastRefusedAt = Date.now();
          reject(new PoolAdmissionTimeoutError(admissionDeadlineMs, inFlightLimit, waiters.length));
        }, admissionDeadlineMs),
      };
      // Never hold the process open on an admission timer.
      (waiter.timer as { unref?: () => void }).unref?.();
      waiters.push(waiter);
      if (waiters.length > peakQueued) peakQueued = waiters.length;
    });
    admit();
  }

  function release(): void {
    inFlight--;
    lastSettledAt = Date.now();
    const next = waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    }
  }

  const saturation = (): PoolerSaturation => ({
    limit: inFlightLimit,
    inFlight,
    queued: waiters.length,
    peakInFlight,
    peakQueued,
    lastSettledAt: lastSettledAt === null ? null : new Date(lastSettledAt).toISOString(),
    saturated: waiters.length > 0,
    everSaturated: peakQueued > 0,
    refused,
    lastRefusedAt: lastRefusedAt === null ? null : new Date(lastRefusedAt).toISOString(),
    guardCount: guardsConstructed,
  });
  guardsConstructed++;
  latestGuardSaturation = saturation;

  const guardedUnsafe = (
    query: string,
    params?: unknown[],
    options?: Record<string, unknown>
  ): GuardedPendingQuery => {
    // Builder calls the caller makes SYNCHRONOUSLY on the returned object —
    // drizzle writes `client.unsafe(q, p).values()` — are recorded here and
    // replayed onto the real PendingQuery at submission time.
    const chained: ReplayableChainingMethod[] = [];

    const rows = (async () => {
      await acquire();
      try {
        // Yield one microtask before submitting, so a builder call made in the
        // same expression as `.unsafe()` is already recorded. This mirrors
        // postgres-js's own deferral (`Query.handle()` does `await 1` before
        // dispatching) and is why the record-and-replay design works at all.
        // `await acquire()` above already yields, but relying on that would
        // make correctness depend on acquire staying async.
        await Promise.resolve();
        let pending = sql.unsafe(query, (params ?? []) as never, (options ?? {}) as never);
        for (const method of chained) {
          // Dynamic dispatch over a name we validated at record time; postgres-js's
          // PendingQuery type cannot be indexed by a string union without this.
          // eslint-disable-next-line custom/no-excessive-as-unknown -- see above
          const mutate = (pending as unknown as Record<string, () => typeof pending>)[method];
          if (typeof mutate === "function") pending = mutate.call(pending);
        }
        return (await pending) as Record<string, unknown>[];
      } finally {
        release();
      }
    })() as GuardedPendingQuery;

    // mt#4473: the postgres-js builder mutators the guard can honour. Each
    // records itself and returns the SAME promise, so `.values()` composes the
    // way it does on a real PendingQuery.
    for (const method of REPLAYABLE_CHAINING_METHODS) {
      Object.defineProperty(rows, method, {
        value: () => {
          chained.push(method);
          return rows;
        },
        enumerable: false,
      });
    }

    // Loud runtime rejection of the chaining members that START or STREAM
    // execution, for callers that cast past the GuardedPendingQuery type
    // (PR #1922 R1): fail with a pointer, not an "undefined is not a function"
    // crash.
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
     narrows `unsafe`'s return from PendingQuery to a guarded Promise of rows, which makes Sql
     and GuardedRawSql structurally incompatible; the double assertion is the honest bridge. */
  return new Proxy(sql, {
    get(target, prop, receiver) {
      if (prop === "unsafe") return guardedUnsafe;
      // mt#4308: served here rather than on the type, so the guarded instance
      // stays structurally a postgres-js client for every existing consumer.
      if (prop === POOLER_SATURATION) return saturation;
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as GuardedRawSql;
  /* eslint-enable custom/no-excessive-as-unknown */
}
