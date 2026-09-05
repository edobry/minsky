/**
 * Watch the reopen triggers for mt#4996's toolloop-timeout accept (mt#4988).
 *
 * mt#4996 measured the reviewer's 120s per-round timeout across all history and
 * ACCEPTED the current behaviour: 133 of 134 timeout events recovered, the cap
 * sits above the p99.9 of completing rounds, and neither raising nor lowering it
 * helps. That decision is recorded on `DEFAULT_MODEL_TIMEOUT_MS` in
 * `providers.ts` and in the README, and it installed three explicit conditions
 * under which the question should be REOPENED.
 *
 * Nothing evaluated those conditions. This does.
 *
 * **This is a watchdog for a decision, not an outage detector**, and the
 * distinction decides the channel. `ask-emitter.ts`'s operator-incident path
 * says "Reviewer is down" and "only you can clear this — the reviewer cannot
 * recover on its own"; both are false here. Nothing is broken when a trigger
 * crosses — a documented baseline has moved, and the remedy is to re-open
 * mt#4996's analysis, which an agent can do. So this notifies through the
 * `AlertSink` at `warn`, and does not mint an operator incident.
 *
 * ### Covers
 *
 * The three reopen triggers mt#4996 recorded, evaluated over a rolling window:
 *
 * 1. `unrecovered_count` — `timeout-unrecovered` events reaching the threshold
 *    (baseline: 1 in 103 days).
 * 2. `recovery_rate` — event-level recovery falling below the threshold
 *    (baseline: 99.25%).
 * 3. `round_p999_ms` — the p99.9 of COMPLETING round latencies rising past the
 *    threshold (baseline: 105.0s). This is the one condition that would make the
 *    cap genuinely tight against real work.
 *
 * ### Does NOT cover
 *
 * - **Why a request hangs.** mt#1897 left that `inferred` and mt#4996 chose a
 *   remedy that does not depend on it. Diagnosing a hang needs Railway deploy
 *   logs, which are per-deployment and age out in hours; that capture was this
 *   task's original scope and was retired with the accept. No current owner —
 *   re-file if a trigger crosses and the cause is wanted.
 * - **Per-occurrence unrecovered alerting.** `reviewer-pre-submit-failure/v1`
 *   (mt#4881) already emits an operator ask for each unrecovered timeout. This
 *   check deliberately reports the AGGREGATE — "the failure rate crossed the
 *   documented baseline" is a different claim from "this review failed" — and
 *   its threshold sits at 2, above the single occurrence mt#4881 pages on.
 * - **`provider_timeout` paging policy.** mt#2719 SC5 excludes it on the grounds
 *   that it self-heals; mt#4996 measured that premise holding at 99.25%.
 *   Revisiting the carve-out is mt#2719's call.
 * - **Crossings that span a restart.** The once-per-crossing suppression below is
 *   in-process, so a redeploy re-arms every trigger and a still-crossed one
 *   notifies again on the next cycle. At a daily cadence that is a small,
 *   bounded repeat of a signal the operator wants anyway; a durable
 *   suppression table would cost a migration for no benefit this side of a
 *   trigger ever firing.
 *
 * Follows `findings-aggregation.ts`'s scheduler shape (in-process setInterval,
 * `enabled` flag, strict-positive env parse, `isRunning` re-entrancy guard,
 * cycle never throws) rather than the heavier `sweeper.ts`.
 *
 * Sealed: no imports from src/.
 */

import { sql } from "drizzle-orm";
import type { ReviewerDb } from "./db/client";
import type { AlertSink } from "./alert-sink";
import { parsePositiveIntEnv } from "./config";
import { extractPgErrorContext } from "./webhook-events";
import { log } from "./logger";

/** The three trigger names, stable identifiers for logs and suppression. */
export type TimeoutRegimeTriggerName = "unrecovered_count" | "recovery_rate" | "round_p999_ms";

/**
 * One trigger's current value against its threshold.
 *
 * `value: null` means NOT COMPUTABLE from the window (no timeout events, or no
 * completing rounds) — never "zero". A null value never crosses, which is what
 * keeps a quiet window from reading as a perfect or a catastrophic one.
 */
export interface TriggerReading {
  name: TimeoutRegimeTriggerName;
  value: number | null;
  threshold: number;
  crossed: boolean;
}

/** Raw aggregates for one window. Everything `evaluateTimeoutRegime` needs. */
export interface TimeoutRegimeSample {
  windowDays: number;
  /** Rows in the window carrying at least one timeout. Context, not a trigger. */
  reviewsWithTimeout: number;
  /** Sum of `timeout_count` over the window — the recovery rate's denominator. */
  timeoutEvents: number;
  /**
   * `timeout-unrecovered` ENTRIES across `retry_outcomes` in the window — array
   * elements, not rows carrying at least one (PR #3653 R1).
   *
   * Counting elements is the more general of the two and needs no assumption
   * about how many a review can carry: if one ever carries two, this counts two
   * where a row-count would under-report. Today they agree exactly — measured
   * over the live 30-day window, 1 element / 1 row / max 1 per row — which is
   * also what keeps this consistent with mt#4996's baseline, itself a row count.
   */
  unrecoveredEvents: number;
  /** p99.9 of COMPLETING round latencies in ms, or null when there are none. */
  completingRoundP999Ms: number | null;
  /** How many completing rounds the p99.9 was computed over. */
  completingRounds: number;
}

/**
 * Thresholds, defaulted to the values mt#4996 recorded rather than to round
 * numbers (`decision-defaults.mdc §Thresholds`).
 */
export interface TimeoutRegimeThresholds {
  /** Crossed at or above this many unrecovered events. Baseline: 1 in 103 days. */
  maxUnrecoveredEvents: number;
  /** Crossed below this event-level recovery rate. Baseline: 0.9925. */
  minRecoveryRate: number;
  /** Crossed above this completing-round p99.9, in ms. Baseline: 105_000. */
  maxRoundP999Ms: number;
}

export interface TimeoutRegimeWatchConfig extends TimeoutRegimeThresholds {
  enabled: boolean;
  intervalMs: number;
  windowDays: number;
  /**
   * A round latency at or above this is CENSORED at the cap, not measured
   * (mem#1373) — the timeout mechanism produced the number, not the work. Only
   * rounds strictly below it enter the p99.9, which is the correction that
   * changed mt#1897's conclusion.
   */
  completingRoundCapMs: number;
}

export function loadTimeoutRegimeWatchConfig(): TimeoutRegimeWatchConfig {
  return {
    enabled: (process.env["TIMEOUT_REGIME_WATCH_ENABLED"] ?? "false") === "true",
    // Strict-positive parse (the mt#1811 cascade-defense convention shared with
    // every scheduler in this service): a malformed value would feed NaN to
    // setInterval. Daily — the thing being watched moves over weeks, and the
    // triggers are 30-day aggregates.
    intervalMs: parsePositiveIntEnv("TIMEOUT_REGIME_WATCH_INTERVAL_MS", 24 * 60 * 60 * 1000),
    // 30 days: the window mt#4996 stated its triggers over, not a round number.
    windowDays: parsePositiveIntEnv("TIMEOUT_REGIME_WATCH_WINDOW_DAYS", 30),
    completingRoundCapMs: parsePositiveIntEnv("TIMEOUT_REGIME_WATCH_CAP_MS", 118_000),
    maxUnrecoveredEvents: parsePositiveIntEnv("TIMEOUT_REGIME_MAX_UNRECOVERED", 2),
    // parsePositiveIntEnv is integer-only, so the rate is carried as basis
    // points — 9500 = 95.00%. A float env var would need a second parser whose
    // failure mode (NaN) is exactly what the shared one exists to prevent.
    minRecoveryRate: parsePositiveIntEnv("TIMEOUT_REGIME_MIN_RECOVERY_BP", 9500) / 10_000,
    maxRoundP999Ms: parsePositiveIntEnv("TIMEOUT_REGIME_MAX_P999_MS", 115_000),
  };
}

/**
 * Evaluate a sample against thresholds. Pure — the whole decision is a function
 * of its inputs (`testing-standards.mdc` §Testable Design), so the thresholds
 * can be tested without a database or a clock.
 */
export function evaluateTimeoutRegime(
  sample: TimeoutRegimeSample,
  thresholds: TimeoutRegimeThresholds
): TriggerReading[] {
  // Undefined rather than 1.0 when nothing timed out: a window with no timeout
  // events says nothing about the recovery rate, and reporting a perfect score
  // for it would make the trigger unfalsifiable in exactly the quiet periods
  // that dominate the corpus.
  const recoveryRate =
    sample.timeoutEvents > 0
      ? (sample.timeoutEvents - sample.unrecoveredEvents) / sample.timeoutEvents
      : null;

  return [
    {
      name: "unrecovered_count",
      value: sample.unrecoveredEvents,
      threshold: thresholds.maxUnrecoveredEvents,
      crossed: sample.unrecoveredEvents >= thresholds.maxUnrecoveredEvents,
    },
    {
      name: "recovery_rate",
      value: recoveryRate,
      threshold: thresholds.minRecoveryRate,
      crossed: recoveryRate !== null && recoveryRate < thresholds.minRecoveryRate,
    },
    {
      name: "round_p999_ms",
      value: sample.completingRoundP999Ms,
      threshold: thresholds.maxRoundP999Ms,
      crossed:
        sample.completingRoundP999Ms !== null &&
        sample.completingRoundP999Ms > thresholds.maxRoundP999Ms,
    },
  ];
}

/**
 * Shape of the aggregate row. A `type` alias rather than an `interface` because
 * `db.execute<T>` constrains `T extends Record<string, unknown>`, and an
 * interface has no implicit index signature to satisfy it.
 *
 * Every column is `number | string | null`: count()/sum() cross the pg wire as
 * strings, and `percentile_cont` is NULL when its input set is empty.
 */
type SampleRow = {
  reviews_with_timeout: number | string | null;
  timeout_events: number | string | null;
  unrecovered_events: number | string | null;
  p999_ms: number | string | null;
  completing_rounds: number | string | null;
};

/** Postgres returns bigint/numeric aggregates as strings; normalise to number. */
function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Query the window's aggregates.
 *
 * `nowMs` is injected with a real default rather than read at the point of use
 * (`testing-standards.mdc` §Testable Design → the clock is injected), so a test
 * can anchor a window without touching the real clock.
 */
export async function sampleTimeoutRegime(
  db: ReviewerDb,
  options: { windowDays: number; completingRoundCapMs: number; nowMs?: number }
): Promise<TimeoutRegimeSample> {
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - options.windowDays * 24 * 60 * 60 * 1000);

  // `tool_use_active is true` scopes this to the population mt#4996's thresholds
  // and mt#4988's burst figures were both measured over (PR #3653 R1).
  //
  // Measured before adding it, so the change is understood rather than assumed:
  // over the live 30-day window the filter excludes 1,238 of 4,593 rows and
  // changes NOTHING — 51 timeout events either way, 27,189 completing rounds
  // either way, p99.9 108,068.7ms either way, identical to the digit. The
  // excluded rows are the skip paths (routing-skip, concurrent-inflight) that
  // write a timing row with no model call, so they carry an empty
  // `per_round_latencies_ms` and a zero `timeout_count`.
  //
  // It is here anyway because that equality is a property of the CURRENT write
  // paths, not an invariant this query states. A future path that recorded round
  // latencies with tool-use off would pool two regimes into one percentile with
  // no error to notice — mem#1247's shape. The filter makes the population
  // explicit instead of coincidental.
  const rows = await db.execute<SampleRow>(
    sql`WITH w AS (
          SELECT timeout_count, retry_outcomes, per_round_latencies_ms
            FROM review_timing
           WHERE created_at >= ${cutoff}
             AND tool_use_active IS TRUE
        ),
        ev AS (
          SELECT count(*) FILTER (WHERE timeout_count > 0) AS reviews_with_timeout,
                 coalesce(sum(timeout_count), 0)          AS timeout_events
            FROM w
        ),
        un AS (
          SELECT count(*) AS unrecovered_events
            FROM w, unnest(w.retry_outcomes) AS outcome
           WHERE outcome = 'timeout-unrecovered'
        ),
        rounds AS (
          SELECT ms FROM (SELECT unnest(per_round_latencies_ms) AS ms FROM w) t
           WHERE ms < ${options.completingRoundCapMs}
        )
        SELECT ev.reviews_with_timeout,
               ev.timeout_events,
               un.unrecovered_events,
               (SELECT percentile_cont(0.999) WITHIN GROUP (ORDER BY ms) FROM rounds) AS p999_ms,
               (SELECT count(*) FROM rounds)                                          AS completing_rounds
          FROM ev, un`
  );

  const row = rows[0];
  return {
    windowDays: options.windowDays,
    reviewsWithTimeout: toNumber(row?.reviews_with_timeout) ?? 0,
    timeoutEvents: toNumber(row?.timeout_events) ?? 0,
    unrecoveredEvents: toNumber(row?.unrecovered_events) ?? 0,
    completingRoundP999Ms: toNumber(row?.p999_ms),
    completingRounds: toNumber(row?.completing_rounds) ?? 0,
  };
}

function formatReading(reading: TriggerReading): string {
  const value =
    reading.value === null
      ? "n/a"
      : reading.name === "recovery_rate"
        ? `${(reading.value * 100).toFixed(2)}%`
        : String(Math.round(reading.value));
  const threshold =
    reading.name === "recovery_rate"
      ? `${(reading.threshold * 100).toFixed(2)}%`
      : String(reading.threshold);
  const direction = reading.name === "recovery_rate" ? "below" : "above";
  return `${reading.name} ${value} (${direction} ${threshold} reopens)`;
}

/** Body for the alert. Pure, so the wording is assertable without a sink. */
export function buildTimeoutRegimeAlertBody(
  crossed: TriggerReading[],
  sample: TimeoutRegimeSample
): string {
  return (
    `mt#4996 accepted the reviewer's 120s toolloop-timeout cadence on a measured baseline. ` +
    `Over the last ${sample.windowDays} days that baseline no longer holds: ` +
    `${crossed.map(formatReading).join("; ")}. ` +
    `Window totals: ${sample.timeoutEvents} timeout events across ` +
    `${sample.reviewsWithTimeout} reviews, ${sample.unrecoveredEvents} unrecovered, ` +
    `p99.9 over ${sample.completingRounds} completing rounds. ` +
    `Nothing is broken and no one is paged — this asks for mt#4996's remedy question to be ` +
    `reopened, not for an incident response. Its recorded triggers and queries are in ` +
    `mt#4996 "## DECISION 2026-09-05".`
  );
}

export interface TimeoutRegimeCycleResult {
  readings: TriggerReading[];
  crossed: TriggerReading[];
  /** Crossed triggers that were not already crossed on the previous cycle. */
  notified: TimeoutRegimeTriggerName[];
}

/**
 * Run one cycle: sample, evaluate, record every reading, notify only on a NEW
 * crossing. Errors are caught and logged — a background signal never crashes
 * the reviewer service.
 *
 * `alreadyCrossed` carries the previous cycle's crossed set and is MUTATED to
 * the current one, which is what makes "at most once per trigger per crossing"
 * hold without persisting state. A trigger that clears is removed, so a later
 * re-crossing notifies again.
 */
export async function runTimeoutRegimeWatchCycle(
  db: ReviewerDb,
  config: TimeoutRegimeWatchConfig,
  alertSink: AlertSink | null | undefined,
  alreadyCrossed: Set<TimeoutRegimeTriggerName>,
  nowMs?: number
): Promise<TimeoutRegimeCycleResult> {
  const empty: TimeoutRegimeCycleResult = { readings: [], crossed: [], notified: [] };
  try {
    const sample = await sampleTimeoutRegime(db, {
      windowDays: config.windowDays,
      completingRoundCapMs: config.completingRoundCapMs,
      ...(nowMs === undefined ? {} : { nowMs }),
    });
    const readings = evaluateTimeoutRegime(sample, config);
    const crossed = readings.filter((r) => r.crossed);

    // SC1': record every trigger's value against its threshold on every cycle,
    // so a reader sees the MARGIN rather than only a boolean.
    log.info("timeout_regime.cycle_complete", {
      event: "timeout_regime.cycle_complete",
      windowDays: sample.windowDays,
      readings,
      sample,
    });

    const notified: TimeoutRegimeTriggerName[] = [];
    for (const reading of crossed) {
      if (!alreadyCrossed.has(reading.name)) notified.push(reading.name);
    }
    alreadyCrossed.clear();
    for (const reading of crossed) alreadyCrossed.add(reading.name);

    if (notified.length > 0) {
      const body = buildTimeoutRegimeAlertBody(crossed, sample);
      log.warn("timeout_regime.trigger_crossed", {
        event: "timeout_regime.trigger_crossed",
        notified,
        crossed,
        // PR #3653 R1: state the suppression's scope in the record itself, so a
        // reader correlating a repeat notification against a redeploy does not
        // have to infer it from the module source. See `### Does NOT cover`.
        suppressionScope: "process-local",
      });
      // `notify` is contractually fail-open and never throws, so this needs no
      // guard of its own — but it is awaited so a cycle's work is finished
      // before the re-entrancy flag clears.
      await alertSink?.notify("warn", "Reviewer toolloop-timeout baseline drifted", body);
    }

    return { readings, crossed, notified };
  } catch (err: unknown) {
    log.error("timeout_regime.cycle_error", {
      event: "timeout_regime.cycle_error",
      ...extractPgErrorContext(err),
      windowDays: config.windowDays,
    });
    return empty;
  }
}

/**
 * Start the watch on an in-process interval.
 *
 * Opt-in via `TIMEOUT_REGIME_WATCH_ENABLED=true`, matching
 * `findings-aggregation.ts` — a job with no production urgency until a trigger
 * approaches. Returns the timer handle (for tests to `clearInterval`), or null
 * when disabled or when no DB is configured (degraded boot).
 */
export function startTimeoutRegimeWatch(
  db: ReviewerDb | undefined,
  config: TimeoutRegimeWatchConfig,
  alertSink?: AlertSink | null
): ReturnType<typeof setInterval> | null {
  if (!config.enabled) {
    log.info("timeout_regime.disabled", {
      event: "timeout_regime.disabled",
      message: "Timeout-regime watch is disabled (TIMEOUT_REGIME_WATCH_ENABLED=false).",
    });
    return null;
  }

  if (db === undefined) {
    log.warn("timeout_regime.missing_db", {
      event: "timeout_regime.missing_db",
      message:
        "TIMEOUT_REGIME_WATCH_ENABLED=true but no DB is configured. " +
        "Timeout-regime watch will not start.",
    });
    return null;
  }

  log.info("timeout_regime.enabled", {
    event: "timeout_regime.enabled",
    intervalMs: config.intervalMs,
    windowDays: config.windowDays,
    maxUnrecoveredEvents: config.maxUnrecoveredEvents,
    minRecoveryRate: config.minRecoveryRate,
    maxRoundP999Ms: config.maxRoundP999Ms,
    hasAlertSink: Boolean(alertSink),
  });

  const alreadyCrossed = new Set<TimeoutRegimeTriggerName>();
  let isRunning = false;

  return setInterval(() => {
    if (isRunning) {
      log.warn("timeout_regime.tick.skipped_overlap", {
        event: "timeout_regime.tick.skipped_overlap",
        message: "Previous timeout-regime cycle still in progress; skipping this tick.",
      });
      return;
    }
    isRunning = true;
    runTimeoutRegimeWatchCycle(db, config, alertSink, alreadyCrossed)
      .catch((err: unknown) => {
        // Unreachable: runTimeoutRegimeWatchCycle catches internally.
        // Belt-and-suspenders, mirroring findings-aggregation.ts.
        const message = err instanceof Error ? err.message : String(err);
        log.error("timeout_regime.tick.error", {
          event: "timeout_regime.tick.error",
          error: message,
        });
      })
      .finally(() => {
        isRunning = false;
      });
  }, config.intervalMs);
}
