/**
 * Check (d): does a service's DB-pool RECOVERY mechanism still work? (mt#1495)
 *
 * ## The class this exists for
 *
 * A persistence recovery mechanism — retry, recycle, reconnect, teardown — whose
 * failure mode is SILENCE. The mechanism looks healthy because the thing it
 * protects still works, and its own failure is recorded only where nothing reads.
 *
 * Two instances are known, and both ran broken for months:
 *
 * - **The recycle (mt#4515).** Every cockpit pool recycle abandoned its old
 *   pool's connections, because `close()` passed postgres-js no `timeout` and so
 *   never armed the `destroy()` that releases sockets. Measured across every
 *   retained daemon log rotation: 88 abandoned closes and ZERO clean ones, ever.
 *   Nobody noticed, because the only record was a `log.warn`. It surfaced when an
 *   unrelated investigation happened to `grep` the log.
 * - **The retry (mt#1461).** `withPgPoolRetry` silently no-op'd for the
 *   production path and went undetected for ~5 days.
 *
 * mt#4549 made the recycle's outcome machine-readable — four counters on
 * `/api/health`'s `dbRecycle`. This module is the CONSUMER that decides whether
 * those counters mean anything is wrong. Without it the counters are just a nicer
 * log line.
 *
 * ## Why the reading is not `closesAbandoned > 0`
 *
 * That predicate alone calls an untested process healthy. A counter defaults to
 * zero both when every recycle released cleanly and when no recycle has ever
 * happened — and those are different claims (mem#704: a probe that returns the
 * same result when the system is broken is not verification). So the reading is
 * always taken against `recycleCount`, and `untested` is its own state rather
 * than a flavour of `healthy`.
 *
 * That distinction is not hypothetical here. Measured 2026-08-25, both the local
 * and deployed cockpits reported `recycleCount: 0` with all four counters zero —
 * i.e. the mt#4515 fix is live and has never been exercised. A detector that
 * reported that as HEALTHY would be making exactly the claim it cannot support.
 *
 * ## What this check structurally CANNOT see
 *
 * Every counter here lives inside `closeAbandonedService()`. A counter inside
 * operation X can only report failures that happen AFTER X is reached — it is
 * blind to whatever prevents X from being called at all (mem#862: two green
 * dashboards over one dead sweep, where the tracker's `recordRun()` sat one frame
 * below the connection acquisition that was throwing). If the recycle path stops
 * being invoked, every counter here stays zero and this check reads `untested`
 * forever.
 *
 * `untested` is therefore deliberately NOT silent: it is the only signal this
 * module can offer for that blind spot, which is why it carries its own detail
 * string rather than collapsing into `healthy`.
 *
 * @see mt#4549 — shipped the counters this reads
 * @see mt#4515 — the defect they were built for
 * @see packages/domain/src/deployment/monitor-verdict.ts — the scorer this feeds
 */

import type { CheckSummary } from "./monitor-verdict";

/**
 * The `dbRecycle` sub-object of the cockpit's `GET /api/health` (mt#4549).
 *
 * Declared structurally rather than imported from `src/cockpit/shared-persistence.ts`
 * on purpose: this module runs in the MONITOR, which is an external observer of a
 * deployed service's HTTP response. Importing the producer's type would assert that
 * the deployed service is running this same build, which is the one thing an external
 * monitor must not assume — the deployed service may be several commits behind, and
 * that lag is itself something the monitor checks (check (c), mt#3251).
 */
export interface RecycleCounters {
  recycleCount: number;
  closesDrained: number;
  closesForceTerminated: number;
  closesAbandoned: number;
  closesFailed: number;
  lastRecycleAt: string | null;
}

/**
 * What this run could establish about one service's recycle mechanism.
 *
 * Five states, not two. The three non-obvious ones each exist because collapsing
 * it into its neighbour would produce a specific wrong claim:
 *
 * - `no-surface` vs `untested` — a service that publishes no `dbRecycle` at all
 *   has not been observed to be fine; it has not been observed. Only the cockpit
 *   publishes these counters today.
 * - `untested` vs `healthy` — see the module doc. This is the mem#704 split.
 * - `alarm` vs `degraded` — `closesAbandoned` is a should-never-happen after
 *   mt#4515; `closesFailed` is a real but different fault. See {@link readRecycleCounters}.
 */
export type RecoveryReading =
  | { state: "no-surface" }
  | { state: "unparseable"; detail: string }
  | { state: "untested"; detail: string }
  | { state: "healthy"; detail: string }
  | { state: "degraded"; detail: string }
  | { state: "alarm"; detail: string };

/** True when `value` is a finite, non-negative integer — what every counter must be. */
function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const COUNTER_FIELDS = [
  "recycleCount",
  "closesDrained",
  "closesForceTerminated",
  "closesAbandoned",
  "closesFailed",
] as const;

/**
 * Read the `dbRecycle` counters off a parsed `/api/health` body.
 *
 * ## Why this enumerates the key set instead of projecting
 *
 * A projection over a payload that LACKS these keys manufactures `undefined` for
 * every one of them, and `undefined > 0` is `false` — so a service publishing no
 * counters at all would read as "healthy, nothing abandoned". That is an accessor
 * SYNTHESIZING a value rather than dropping one, and it is invisible at the call
 * site. So presence is established first, per field, and a partial object is
 * `unparseable` rather than silently zero-filled.
 */
export function readRecycleCounters(healthBody: unknown): RecoveryReading {
  if (typeof healthBody !== "object" || healthBody === null) {
    return { state: "unparseable", detail: "health body is not an object" };
  }

  if (!("dbRecycle" in healthBody)) {
    return { state: "no-surface" };
  }

  const raw = (healthBody as { dbRecycle: unknown }).dbRecycle;
  if (typeof raw !== "object" || raw === null) {
    return { state: "unparseable", detail: "dbRecycle is present but is not an object" };
  }

  const record = raw as Record<string, unknown>;
  const missing = COUNTER_FIELDS.filter((field) => !isCounter(record[field]));
  if (missing.length > 0) {
    return {
      state: "unparseable",
      detail:
        `dbRecycle is missing or has non-counter values for: ${missing.join(", ")}. ` +
        "A partial payload is reported as unparseable rather than zero-filled, because " +
        "an absent counter and a zero counter are different claims.",
    };
  }

  const counters: RecycleCounters = {
    recycleCount: record.recycleCount as number,
    closesDrained: record.closesDrained as number,
    closesForceTerminated: record.closesForceTerminated as number,
    closesAbandoned: record.closesAbandoned as number,
    closesFailed: record.closesFailed as number,
    lastRecycleAt: typeof record.lastRecycleAt === "string" ? record.lastRecycleAt : null,
  };

  return classifyRecycleCounters(counters);
}

/**
 * Decide what a complete set of counters means.
 *
 * Split from {@link readRecycleCounters} so the DECISION can be tested without
 * constructing an HTTP body, and so the parsing can be tested without reasoning
 * about thresholds.
 */
export function classifyRecycleCounters(counters: RecycleCounters): RecoveryReading {
  const {
    recycleCount,
    closesDrained,
    closesForceTerminated,
    closesAbandoned,
    closesFailed,
    lastRecycleAt,
  } = counters;

  // The alarm, checked FIRST so it is never masked by the untested branch below.
  // A non-zero abandoned count with recycleCount 0 would be incoherent, but if it
  // ever occurs it is a fault worth surfacing rather than a reason to report
  // "untested".
  if (closesAbandoned > 0) {
    return {
      state: "alarm",
      detail:
        `${closesAbandoned} of ${recycleCount} pool recycles ABANDONED their close ` +
        `(last recycle ${lastRecycleAt ?? "unknown"}). Post-mt#4515 this should never ` +
        "happen: the outer deadline gave up AND postgres-js's own destroy timer failed " +
        "to release the connections, so a full pool's worth of client sockets is " +
        "stranded for the life of the process. This is the mt#4515 defect recurring " +
        "past its fix, not the fix working.",
    };
  }

  if (recycleCount === 0) {
    return {
      state: "untested",
      detail:
        "No pool recycle has occurred in this process, so the recycle mechanism is " +
        "UNEXERCISED — not verified healthy. All four outcome counters are zero because " +
        "nothing has happened, which reads identically to 'every recycle released cleanly'. " +
        "Not an alert; recorded so a zero is never mistaken for a liveness claim.",
    };
  }

  // A real fault, but deliberately NOT the alarm. mt#4549 split `closesFailed` out
  // of `closesAbandoned` during review precisely so the alarm counter stays
  // trustworthy: a close that REJECTED errored and said so, which is a different
  // event from one that never returned. Folding them together would inflate the
  // alarm with events that are not "connections stranded because nothing terminated
  // them" — so this reports at its own lower severity instead.
  if (closesFailed > 0) {
    return {
      state: "degraded",
      detail:
        `${closesFailed} of ${recycleCount} pool recycles had close() REJECT before the ` +
        `deadline (${closesDrained} drained, ${closesForceTerminated} force-terminated). ` +
        "Teardown errored and reported it, rather than silently stranding sockets — a real " +
        "fault, but not the mt#4515 class.",
    };
  }

  return {
    state: "healthy",
    detail:
      `${recycleCount} pool recycles, all released: ${closesDrained} drained, ` +
      `${closesForceTerminated} force-terminated. Force-terminated is the mt#4515 fix ` +
      "WORKING — postgres-js's destroy timer fired and released the connections — and is " +
      "deliberately not counted as a fault.",
  };
}

/**
 * Project a reading into the `CheckSummary` shape `scoreService` consumes.
 *
 * The mapping is where this check earns the monitor's existing three-state model:
 *
 * | reading       | outcome          | problem | why |
 * | ------------- | ---------------- | ------- | --- |
 * | `no-surface`  | `not-applicable` | false   | the service publishes no counters; nothing to check |
 * | `unparseable` | `failed`         | false   | the check could not COMPLETE — state is unknown, not fine |
 * | `untested`    | `not-applicable` | false   | the check ran and learned nothing — see below |
 * | `healthy`     | `ok`             | false   | ran, found no fault |
 * | `degraded`    | `ok`             | true    | ran, found a real fault |
 * | `alarm`       | `ok`             | true    | ran, found the should-never-happen |
 *
 * `unparseable` maps to `failed` rather than to a problem, matching mt#3921's rule
 * that a check which could not run has OBSERVED NOTHING and makes the service's
 * verdict DEGRADED — it is not evidence of a fault, and it is not evidence of
 * health either.
 *
 * ## Why `untested` is `not-applicable` and not `ok`
 *
 * `ok` is the more natural reading of what happened — the check genuinely ran and
 * parsed a payload. But `outcome` is not only consumed by the alert path: it also
 * feeds `observedRecoveredClasses`, where `ok` + `!problem` is POSITIVE EVIDENCE
 * OF RECOVERY and closes an open P0.
 *
 * That makes `ok` actively wrong here, in a way that would have been hard to
 * notice. Every counter resets when the process restarts — so a cockpit that
 * raised this alarm, got restarted, and came back with `recycleCount: 0` would
 * present as recovered on the very next run, and the P0 would auto-close. The
 * restart is not a fix; it is the erasure of the evidence. (This is mem#704's
 * shape pointed at the recovery direction rather than the alert direction: a
 * signal that reads the same whether the fault was fixed or merely forgotten.)
 *
 * `not-applicable` is what the scorer already means by "produces no alert and no
 * recovery evidence", which is exactly the semantics an unexercised mechanism
 * needs. The honest detail string rides along either way, so nothing is hidden
 * from an operator reading the run log.
 */
export function toRecoveryCheckSummary(reading: RecoveryReading): CheckSummary {
  switch (reading.state) {
    case "no-surface":
      return {
        outcome: "not-applicable",
        detail: "service publishes no dbRecycle counters (only the cockpit does today)",
        problem: false,
      };
    case "unparseable":
      return { outcome: "failed", detail: reading.detail, problem: false };
    case "untested":
      return { outcome: "not-applicable", detail: reading.detail, problem: false };
    case "healthy":
      return { outcome: "ok", detail: reading.detail, problem: false };
    case "degraded":
    case "alarm":
      return { outcome: "ok", detail: reading.detail, problem: true };
  }
}
