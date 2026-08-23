/**
 * Persistence READINESS probe (mt#4471).
 *
 * ## Why this exists
 *
 * `assessPersistenceHealth` answers "what KIND of provider is wired" by
 * inspecting the provider OBJECT — `provider.getCapabilities().sql` is a static
 * declaration of provider TYPE, not an observation that a query can complete.
 * That is the right question for the boot-time cases it was built for
 * (mt#2949's missing provider, mt#4297's unwired one) and it is silent on the
 * case that produced this module: a provider that is present, correctly typed,
 * and unable to serve.
 *
 * On 2026-08-23 the tray-supervised daemon reached that state. Eight concurrent
 * long-running MCP calls saturated the connection pool; every subsequent
 * DB-backed call hung indefinitely for ~45 minutes across three conversations,
 * with no error and no log line, until the process was replaced. `/health` was
 * checked twice during the outage and answered
 * `{"status":"ok","persistence":{"mode":"connected"},"ready":true}` both times.
 * A probe that returns the same answer whether or not the system is broken
 * carries no information (mem#704) — this module is what makes `/health` able
 * to fail.
 *
 * ## Why a round trip, and not the saturation counter we already have
 *
 * `getPoolerSaturation()` (mt#2773, `raw-sql-pooler-guard.ts`) looks like the
 * cheaper signal and is the wrong one HERE. Its own docblock states the bound:
 * it observes the `.unsafe()` path only, so *"a pool can be exhausted by
 * drizzle traffic while this reads all zeros."* Every DB-backed MCP tool
 * reaches Postgres through drizzle, which is precisely the traffic it cannot
 * see — keying readiness on it would rebuild the can't-fail probe in a new
 * place. A round trip is end-to-end: it has to acquire a real pool connection
 * like any other query, so it observes contention from drizzle, `.unsafe()` and
 * `sql.begin()` alike.
 *
 * ## Why the probe itself cannot hang
 *
 * `postgres` (postgres.js) has NO checkout timeout — with all `max` connections
 * busy, queries queue with no bound, which is the mechanism behind the incident
 * above. So the probe query is raced against a timer rather than awaited: on a
 * saturated pool it is the TIMEOUT that resolves, and `/health` answers
 * not-ready instead of joining the queue it is trying to report on.
 *
 * Concurrent callers share one in-flight probe. The tray health-polls every few
 * seconds and the flip tool probes on demand; without deduplication each poll
 * would add another connection request to an already-saturated pool — making
 * `/health` a contributor to the condition it measures.
 */

/** What a single readiness check observed. */
export interface ReadinessResult {
  /** True only when a real query completed within the bound. */
  ok: boolean;
  /**
   * Present when `ok` is false, absent otherwise. Written for an operator
   * reading a health body at 3am, so it names the bound that was exceeded or
   * the error that was raised — not just "unhealthy".
   */
  reason?: string;
  /** ISO timestamp of when the check settled. */
  checkedAt: string;
  /** How long the check took, whether it succeeded, timed out, or errored. */
  durationMs: number;
}

/**
 * The four ways a probe attempt can settle.
 *
 * `outstanding` is the one that is not about THIS attempt: it means a PREVIOUS
 * attempt's query has still not settled, so this attempt declined to issue
 * another. See `createReadinessProbe`.
 */
export type ProbeOutcome =
  | { kind: "ok" }
  | { kind: "timeout" }
  | { kind: "error"; message: string }
  | { kind: "outstanding"; outstandingForMs: number };

/**
 * Functional core: turn a settled probe attempt into a readiness verdict.
 *
 * Pure and separately testable — the decision returns a value and the shell
 * below does the IO, per `testing-standards.mdc §Testable Design`. Observing
 * this logic requires no database and no clock control.
 */
export function assessProbeOutcome(input: {
  outcome: ProbeOutcome;
  timeoutMs: number;
  durationMs: number;
  checkedAt: string;
}): ReadinessResult {
  const { outcome, timeoutMs, durationMs, checkedAt } = input;

  if (outcome.kind === "ok") {
    return { ok: true, checkedAt, durationMs };
  }

  if (outcome.kind === "timeout") {
    return {
      ok: false,
      // Naming the pool explicitly: this is the saturation case, and the
      // distinction from "the database is down" is what an operator needs
      // first. postgres.js queues without bound, so a timeout here means the
      // query never got a connection — not that Postgres rejected it.
      reason:
        `persistence round-trip did not complete within ${timeoutMs}ms — ` +
        `the connection pool is not serving queries (a saturated pool queues ` +
        `without bound; see mt#4471)`,
      checkedAt,
      durationMs,
    };
  }

  if (outcome.kind === "outstanding") {
    return {
      ok: false,
      reason:
        `a previous persistence round-trip has not settled after ` +
        `${outcome.outstandingForMs}ms — no new query was issued, because the ` +
        `pool is already not serving one (mt#4471)`,
      checkedAt,
      durationMs,
    };
  }

  return {
    ok: false,
    reason: `persistence round-trip failed: ${outcome.message}`,
    checkedAt,
    durationMs,
  };
}

/** Injected so the probe is testable without a database or a real clock. */
export interface ReadinessProbeDeps {
  /**
   * Issue the cheapest possible query that requires a real pool connection.
   *
   * Must NOT be routed through the `.unsafe()` guard: that path has its own
   * FIFO, so a probe behind it would report on the guard's queue rather than
   * on the pool the rest of the process contends for.
   */
  runProbeQuery: () => Promise<void>;
  /** Bound on a single attempt. */
  timeoutMs: number;
  /** Injected for tests. */
  now?: () => number;
  /** Injected for tests; must resolve after `ms`. */
  delay?: (ms: number) => Promise<void>;
}

export interface ReadinessProbe {
  /**
   * Run a check, or join the one already running.
   *
   * Never rejects — a probe that threw would take out the health endpoint it
   * exists to inform.
   */
  check(): Promise<ReadinessResult>;
}

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createReadinessProbe(deps: ReadinessProbeDeps): ReadinessProbe {
  const now = deps.now ?? (() => Date.now());
  const delay = deps.delay ?? defaultDelay;

  // Deduplication of concurrent CHECKS: callers arriving while a check is
  // running join it rather than starting their own.
  let inFlight: Promise<ReadinessResult> | null = null;

  // When the QUERY of a previous check started, if it has still not settled.
  //
  // This is a SEPARATE lifetime from `inFlight`, and the distinction is the
  // whole point (PR #3265 R1). A timed-out check RESOLVES — it returns
  // not-ready and clears `inFlight` — while its query keeps waiting in
  // postgres.js's unbounded queue, because there is no checkout timeout to
  // cancel it and no cancellation API to call. Tracking only the check would
  // therefore issue a FRESH query on every subsequent poll, each one joining
  // the same queue and never leaving: on a saturated pool the health endpoint
  // would accumulate one permanently-parked query per poll, becoming a source
  // of the pressure it exists to report.
  //
  // So at most ONE probe query is ever outstanding. While one is, later checks
  // answer from that fact instead of adding to it — which is also the more
  // honest reading: a query that has not returned is itself the evidence the
  // pool is not serving.
  let outstandingSince: number | null = null;

  async function runOnce(): Promise<ReadinessResult> {
    const startedAt = now();

    if (outstandingSince !== null) {
      return assessProbeOutcome({
        outcome: { kind: "outstanding", outstandingForMs: startedAt - outstandingSince },
        timeoutMs: deps.timeoutMs,
        durationMs: 0,
        checkedAt: new Date(startedAt).toISOString(),
      });
    }

    outstandingSince = startedAt;

    // Settles when the QUERY does, whatever the race below decides, and never
    // rejects — so the outstanding slot is released exactly once, on the real
    // completion, and a rejected promise is never left unhandled.
    const query: Promise<ProbeOutcome> = deps
      .runProbeQuery()
      .then<ProbeOutcome>(() => ({ kind: "ok" }))
      .catch<ProbeOutcome>((error) => ({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        outstandingSince = null;
      });

    const outcome = await Promise.race([
      query,
      delay(deps.timeoutMs).then<ProbeOutcome>(() => ({ kind: "timeout" })),
    ]);

    return assessProbeOutcome({
      outcome,
      timeoutMs: deps.timeoutMs,
      durationMs: now() - startedAt,
      checkedAt: new Date(now()).toISOString(),
    });
  }

  return {
    check(): Promise<ReadinessResult> {
      if (inFlight) return inFlight;

      // NOTE the ordering: `inFlight` is cleared in a `finally` on the SHARED
      // promise, not by each awaiting caller, so the slot frees exactly once
      // regardless of how many callers joined. `runOnce` never rejects, so the
      // chain cannot leave a rejected promise memoized here — which would
      // otherwise latch a transient failure forever (ADR-035's rule against
      // memoizing a failed initializer, applied to a probe).
      const started = runOnce().finally(() => {
        inFlight = null;
      });
      inFlight = started;
      return started;
    },
  };
}
