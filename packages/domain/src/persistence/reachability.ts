/**
 * Live DB-reachability tracking, as an instantiable state machine (mt#4466).
 *
 * ## Why this exists, and why it is not a new idea
 *
 * `assessPersistenceHealth` answers "is a SQL-capable provider wired?" by
 * reading `provider.getCapabilities().sql` — a static capability flag. It never
 * touches the database, so it reports `mode: "connected"` with every connection
 * in the pool held. On 2026-08-23 the local MCP daemon did exactly that: every
 * DB-backed tool timed out for ~50 minutes across every conversation on the
 * machine while `GET /health` answered
 * `{"status":"ok","persistence":{"mode":"connected"},"ready":true}` in ~1ms
 * throughout (mem#1120 R2). A probe whose output is identical in the healthy and
 * broken cases carries no information (mem#704).
 *
 * The cockpit hit the same wall first and solved it in mt#3563, hardened by
 * mt#3638 (wedge-triggered recycle) and mt#3826 (failure classification). This
 * module is that state machine extracted so a second daemon can hold one — the
 * cockpit's own copy in `src/cockpit/shared-persistence.ts` is module-level
 * singleton state fused to its shared-provider lifecycle, so it cannot simply be
 * imported by a process that resolves persistence through a DI container.
 *
 * **The cockpit is deliberately NOT migrated onto this in mt#4466.** That file
 * carries four incidents' worth of hard-won behaviour and sits outside this
 * task's `## Scope`; converging the two is tracked separately. What is shared
 * today is the DESIGN, restated here with its rationale so the two cannot drift
 * silently — every non-obvious choice below cites the cockpit incident that
 * produced it.
 *
 * ## The shape, and the three choices that make it work
 *
 * 1. **The probe runs OUT OF BAND; readers get the previous probe's answer.**
 *    Awaiting a probe inside a health handler makes the handler as slow as the
 *    database it is reporting on — and a wedged pool is precisely when a
 *    supervisor most needs a fast answer, since ADR-014/ADR-038 make `/health`
 *    the tray's liveness and adoption signal. ADR-041 §Question 3 names the
 *    same anti-pattern from the other side: queueing "converts a fast local
 *    failure into a slow one, which is the worst outcome for a caller on a
 *    tens-of-ms budget." The cost is a one-poll lag into and out of degraded,
 *    which {@link ReachabilityCheck.checkedAt} makes visible rather than hiding.
 * 2. **At most ONE probe is ever outstanding, and an outstanding probe IS the
 *    signal.** The failure this exists to catch includes a query promise that
 *    never settles (porsager/postgres#1089). A second probe would take a second
 *    pool slot and still never answer, so while one is in flight we report
 *    degraded and issue nothing. Each abandoned probe holds one slot for the
 *    life of the process; capping the count at one bounds the damage this
 *    module can do to the pool it is measuring.
 * 3. **The probe goes through the SHARED pool, parameterized.** A probe on a
 *    dedicated side-connection would have reported healthy through both cockpit
 *    incidents and through mem#1120 R2 — the server was accepting new
 *    connections fine in every case; what was dead was one process's own pool.
 *    Failure to get a slot within the deadline IS the degraded signal. The query
 *    carries a bind parameter on purpose: zero-bind queries are the shape that
 *    wedges a transaction-mode pooler under concurrency, and a probe for pool
 *    health must not be able to cause the condition it reports (mt#2773).
 *
 * ## Testable by construction
 *
 * The probe, the clock and the log sink are all injected, so every branch below
 * is exercisable without a live database and without patching a module import —
 * `testing-standards.mdc §Testable Design`'s functional-core/imperative-shell
 * split, and the reason this is a class holding state rather than the module
 * singletons it was extracted from.
 */

/**
 * Reachability of the database from THIS process, as of the last probe.
 *
 * - `"ok"` — a query completed through the shared pool inside the deadline.
 * - `"degraded"` — a provider is initialized but a query did not complete: it
 *   timed out, errored, or a previously issued probe still has not come back.
 * - `"unreachable"` — no provider is initialized, so there is nothing to probe.
 *
 * The `degraded`/`unreachable` split is the same one `assessPersistenceHealth`
 * draws between `unavailable` and `unconfigured`: it separates "something is
 * wrong" from "nothing was ever set up", which call for opposite responses.
 */
export type ReachabilityStatus = "ok" | "degraded" | "unreachable";

/** Outcome of the last probe that actually finished. */
export interface ReachabilityCheck {
  /**
   * ISO timestamp of the last probe that FINISHED — resolved, rejected, or hit
   * its deadline — or null if none has.
   *
   * Deliberately NOT bumped when a poll merely observes that an earlier probe is
   * still outstanding. Nothing was determined on such a poll, so a freshly
   * stamped `checkedAt` would read as a fresh measurement. Letting it go stale
   * is the more informative behaviour: a stale `checkedAt` beside
   * `status: "degraded"` says "stuck since then", which is exactly what an
   * operator needs in the never-settling-query wedge.
   */
  checkedAt: string | null;
  /** Round-trip of the last SUCCESSFUL probe in ms, or null if none succeeded. */
  latencyMs: number | null;
}

/**
 * Hard deadline for one probe.
 *
 * Matches the cockpit's `DB_REACHABILITY_PROBE_TIMEOUT_MS`. Generous against a
 * healthy round-trip while still marking a wedged pool degraded well inside one
 * 5s tray poll.
 */
export const REACHABILITY_PROBE_TIMEOUT_MS = 5_000;

/**
 * Minimum gap between probes while the last one SUCCEEDED.
 *
 * A health route kicks a probe per request and several clients poll it (the tray
 * supervisor every 5s, plus any operator or uptime probe), so without a floor a
 * busy daemon issues a query per poll per client. The floor applies ONLY in the
 * healthy state: once degraded we probe on every poll, because detecting
 * recovery promptly outweighs one extra query against a pool that is not doing
 * anything else anyway.
 */
export const REACHABILITY_MIN_INTERVAL_MS = 2_000;

/** Issues one reachability query. Rejecting (or never settling) is the signal. */
export type ReachabilityProbe = () => Promise<unknown>;

export interface ReachabilityTrackerOptions {
  /** Issues the probe query through the shared pool. */
  probe: ReachabilityProbe;
  /**
   * Whether a provider is initialized at all.
   *
   * Decides `degraded` vs `unreachable` on failure — "the pool is wedged" and
   * "there is no pool" are different findings with different remedies, and
   * collapsing them is what makes a health body unactionable.
   */
  isInitialized: () => boolean;
  /** Injected for tests. Defaults to the real clock. */
  now?: () => number;
  /** Injected for tests. Defaults to a no-op; the daemon passes its logger. */
  onLog?: (message: string, meta: Record<string, unknown>) => void;
  /** Injected for tests. Defaults to {@link REACHABILITY_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injected for tests. Defaults to {@link REACHABILITY_MIN_INTERVAL_MS}. */
  minIntervalMs?: number;
}

/**
 * A single process's view of whether its own pool is answering.
 *
 * One instance per process. {@link refresh} never throws and never blocks its
 * caller beyond `timeoutMs`, so a health handler can fire it without being able
 * to hang — which is the whole point, per choice 1 in the module docstring.
 */
export class DbReachabilityTracker {
  private status: ReachabilityStatus = "unreachable";
  private check: ReachabilityCheck = { checkedAt: null, latencyMs: null };
  private outstanding: Promise<unknown> | null = null;
  private lastFinishedAtMs: number | null = null;

  private readonly probe: ReachabilityProbe;
  private readonly isInitialized: () => boolean;
  private readonly now: () => number;
  private readonly onLog: (message: string, meta: Record<string, unknown>) => void;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;

  constructor(options: ReachabilityTrackerOptions) {
    this.probe = options.probe;
    this.isInitialized = options.isInitialized;
    this.now = options.now ?? (() => Date.now());
    this.onLog = options.onLog ?? ((): void => {});
    this.timeoutMs = options.timeoutMs ?? REACHABILITY_PROBE_TIMEOUT_MS;
    this.minIntervalMs = options.minIntervalMs ?? REACHABILITY_MIN_INTERVAL_MS;
  }

  /** Last-known status. Read-only and synchronous — safe on every health poll. */
  getStatus(): ReachabilityStatus {
    return this.status;
  }

  /** Last finished probe's detail. Read-only; pairs with {@link getStatus}. */
  getCheck(): ReachabilityCheck {
    return { ...this.check };
  }

  /**
   * Probe if due, and update the reported status. Never throws.
   *
   * Callers fire this without awaiting (`void tracker.refresh()`) and then read
   * {@link getStatus}; awaiting it inside a request handler reintroduces exactly
   * the slow-failure mode choice 1 exists to avoid.
   */
  async refresh(): Promise<ReachabilityStatus> {
    if (this.outstanding) {
      // A probe we already issued has not come back. Do not issue another, and
      // do NOT touch `checkedAt` — nothing finished on this poll, so claiming a
      // fresh measurement would misreport. This branch IS the never-settle
      // wedge signature, not merely a concurrency guard.
      this.status = this.isInitialized() ? "degraded" : "unreachable";
      return this.status;
    }

    // Healthy-state floor. Skipped entirely while degraded so recovery is seen
    // on the very next poll.
    if (
      this.status === "ok" &&
      this.lastFinishedAtMs !== null &&
      this.now() - this.lastFinishedAtMs < this.minIntervalMs
    ) {
      return this.status;
    }

    const startedAt = this.now();
    let issued: Promise<unknown>;
    try {
      issued = this.probe();
    } catch (err) {
      // A probe that threw synchronously never reached a connection. That still
      // DETERMINED reachability, so unlike the outstanding branch above it does
      // stamp `checkedAt`.
      this.status = this.isInitialized() ? "degraded" : "unreachable";
      this.check = { ...this.check, checkedAt: new Date(this.now()).toISOString() };
      this.lastFinishedAtMs = this.now();
      this.onLog("DB reachability probe failed to start", {
        message: err instanceof Error ? err.message : String(err),
        status: this.status,
      });
      return this.status;
    }

    this.outstanding = issued;
    // Release the slot whenever it eventually settles — even long after the
    // deadline — so a pool that recovers becomes probeable again with no
    // restart. Both arms are attached here so a late rejection can never surface
    // as an unhandled rejection.
    let raceSettled = false;
    const release = (): void => {
      if (this.outstanding === issued) this.outstanding = null;
    };
    void issued.then(release, (err: unknown) => {
      release();
      // A rejection arriving AFTER the deadline has no awaiting caller, so
      // without this arm its cause is discarded silently — and that cause is the
      // most diagnostic signal available about WHY the pool stopped answering.
      // Logged only post-deadline; a pre-deadline rejection is already reported
      // by the catch below, and logging both would double up.
      if (!raceSettled) return;
      this.onLog("DB reachability probe rejected after its deadline", {
        message: err instanceof Error ? err.message : String(err),
      });
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        issued,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`DB reachability probe exceeded ${this.timeoutMs}ms`)),
            this.timeoutMs
          );
        }),
      ]);
      this.status = "ok";
      this.check = {
        checkedAt: new Date(this.now()).toISOString(),
        latencyMs: this.now() - startedAt,
      };
    } catch (err) {
      this.status = this.isInitialized() ? "degraded" : "unreachable";
      this.check = { ...this.check, checkedAt: new Date(this.now()).toISOString() };
      this.onLog("DB unreachable from this process", {
        message: err instanceof Error ? err.message : String(err),
        status: this.status,
      });
    } finally {
      if (timer) clearTimeout(timer);
      // This poll DID finish a probe (resolved, rejected, or hit the deadline),
      // so it is the reference point for both `checkedAt` and the healthy floor.
      raceSettled = true;
      this.lastFinishedAtMs = this.now();
    }
    return this.status;
  }
}
