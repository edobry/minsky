/**
 * Knowledge Sync Scheduler
 *
 * Opt-in scheduler that drives `runSync` per configured knowledge source on a
 * schedule. Accepts named schedule presets (hourly / daily / weekly) and raw
 * 5-field cron strings. Uses a simple setTimeout chain — next-fire is recomputed
 * from the current clock each time, so late fires do not try to catch up
 * (missed-run policy: skip forward, do not replay).
 *
 * Graceful shutdown: stop() cancels pending timers and returns a Promise that
 * resolves once any in-flight sync runs have completed.
 *
 * Must NOT be auto-started. Composition roots that don't need the KB
 * subsystem (e.g. `minsky --help`) must not construct or start this scheduler.
 */

import type { KnowledgeSourceProvider, SyncReport } from "../types";
import type { SyncRunnerDeps } from "./sync-runner";
import { runSync as defaultRunSync } from "./sync-runner";

// ---------------------------------------------------------------------------
// Clock abstraction for deterministic testing
// ---------------------------------------------------------------------------

export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type TimerHandle = ReturnType<typeof setTimeout> | { readonly __id: number };

const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => {
    if (typeof handle === "object" && handle !== null && "__id" in handle) return;
    globalThis.clearTimeout(handle);
  },
};

// ---------------------------------------------------------------------------
// Schedule expressions
// ---------------------------------------------------------------------------

/** Named schedule presets recognized by the scheduler. */
export const NAMED_SCHEDULE_TO_CRON: Record<string, string | null> = {
  "on-demand": null, // never fires automatically
  startup: "__startup__", // fires once at start, never again
  hourly: "0 * * * *",
  daily: "0 2 * * *",
  weekly: "0 2 * * 0",
};

export type Schedule = keyof typeof NAMED_SCHEDULE_TO_CRON | string;

// ---------------------------------------------------------------------------
// Minimal cron parser (5-field: minute hour day-of-month month day-of-week)
// ---------------------------------------------------------------------------

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day-of-month
  [1, 12], // month
  [0, 6], // day-of-week (0 = Sunday)
];

function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`Invalid cron step: ${part}`);
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart && rangePart.includes("-")) {
      const parts = rangePart.split("-").map((n) => parseInt(n, 10));
      const s = parts[0];
      const e = parts[1];
      if (
        s === undefined ||
        e === undefined ||
        !Number.isFinite(s) ||
        !Number.isFinite(e) ||
        s < min ||
        e > max ||
        s > e
      ) {
        throw new Error(`Invalid cron range: ${part}`);
      }
      start = s;
      end = e;
    } else {
      const n = parseInt(rangePart ?? "", 10);
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new Error(`Invalid cron value: ${part}`);
      }
      start = n;
      end = n;
    }

    for (let v = start; v <= end; v += step) {
      result.add(v);
    }
  }
  return result;
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression (expected 5 fields, got ${fields.length}): ${expr}`);
  }
  const getField = (index: number): string => {
    const f = fields[index];
    if (f === undefined) {
      // Unreachable after the length check above; kept to satisfy strict mode
      throw new Error(`Missing cron field at index ${index}`);
    }
    return f;
  };
  const getRange = (index: number): [number, number] => {
    const r = FIELD_RANGES[index];
    if (!r) {
      throw new Error(`Missing field range at index ${index}`);
    }
    return r;
  };
  return {
    minute: parseField(getField(0), ...getRange(0)),
    hour: parseField(getField(1), ...getRange(1)),
    dom: parseField(getField(2), ...getRange(2)),
    month: parseField(getField(3), ...getRange(3)),
    dow: parseField(getField(4), ...getRange(4)),
  };
}

/**
 * Compute the next fire time strictly after `afterMs` that matches `parsed`.
 * Uses minute-level granularity (seconds are always zero).
 */
export function nextFireAfter(parsed: ParsedCron, afterMs: number): number {
  // Start scanning from the top of the next minute after afterMs
  let t = new Date(afterMs);
  t.setUTCSeconds(0, 0);
  t = new Date(t.getTime() + 60_000);

  // Bound scan to prevent pathological loops (max 366 days worth of minutes)
  const maxIterations = 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    const minute = t.getUTCMinutes();
    const hour = t.getUTCHours();
    const dom = t.getUTCDate();
    const month = t.getUTCMonth() + 1;
    const dow = t.getUTCDay();

    if (
      parsed.minute.has(minute) &&
      parsed.hour.has(hour) &&
      parsed.dom.has(dom) &&
      parsed.month.has(month) &&
      parsed.dow.has(dow)
    ) {
      return t.getTime();
    }
    t = new Date(t.getTime() + 60_000);
  }
  throw new Error("Could not find next cron fire time within 1 year");
}

/**
 * Resolve a Schedule value to a parsed cron, the "startup" sentinel, or null
 * for the on-demand case.
 */
function resolveSchedule(schedule: Schedule): ParsedCron | null | "startup" {
  const mapped = NAMED_SCHEDULE_TO_CRON[schedule as keyof typeof NAMED_SCHEDULE_TO_CRON];
  if (mapped === null) return null;
  if (mapped === "__startup__") return "startup";
  const expr = mapped ?? schedule;
  return parseCron(expr);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export type RunSyncFn = (
  provider: KnowledgeSourceProvider,
  deps: SyncRunnerDeps,
  options?: { force?: boolean }
) => Promise<SyncReport>;

export interface SchedulerSource {
  name: string;
  provider: KnowledgeSourceProvider;
  schedule: Schedule;
}

export interface SchedulerOptions {
  sources: SchedulerSource[];
  deps: SyncRunnerDeps;
  runSync?: RunSyncFn;
  onError?: (sourceName: string, error: Error) => void;
  clock?: SchedulerClock;
}

interface SourceState {
  source: SchedulerSource;
  parsed: ParsedCron | null | "startup";
  timer: TimerHandle | null;
  nextFireAt: number | null;
  inFlight: Promise<unknown> | null;
}

export interface SourceStatus {
  source: string;
  nextFireAt: Date | null;
  running: boolean;
}

export class KnowledgeSyncScheduler {
  private readonly states: Map<string, SourceState> = new Map();
  private readonly runSync: RunSyncFn;
  private readonly deps: SyncRunnerDeps;
  private readonly onError?: (sourceName: string, error: Error) => void;
  private readonly clock: SchedulerClock;
  private started = false;
  private stopping = false;

  constructor(options: SchedulerOptions) {
    this.runSync = options.runSync ?? defaultRunSync;
    this.deps = options.deps;
    this.onError = options.onError;
    this.clock = options.clock ?? realClock;

    for (const source of options.sources) {
      this.states.set(source.name, {
        source,
        parsed: resolveSchedule(source.schedule),
        timer: null,
        nextFireAt: null,
        inFlight: null,
      });
    }
  }

  /**
   * Start the scheduler. Each source gets its next fire scheduled relative to
   * the current clock — the scheduler never tries to replay missed fires.
   * `startup`-mode sources fire once immediately.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;

    for (const state of this.states.values()) {
      if (state.parsed === null) continue; // on-demand: never auto-fires

      if (state.parsed === "startup") {
        // Fire once immediately; do not re-schedule
        this.fireSource(state.source.name);
        continue;
      }

      this.scheduleNext(state.source.name);
    }
  }

  /**
   * Cancel pending timers and wait for any in-flight syncs to complete.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    const inFlightPromises: Promise<unknown>[] = [];
    for (const state of this.states.values()) {
      if (state.timer) {
        this.clock.clearTimeout(state.timer);
        state.timer = null;
        state.nextFireAt = null;
      }
      if (state.inFlight) {
        inFlightPromises.push(state.inFlight);
      }
    }
    await Promise.allSettled(inFlightPromises);
  }

  /**
   * Trigger an immediate sync for one source (or all if omitted). Bypasses the
   * schedule entirely. Does not affect the next scheduled fire time.
   */
  async runNow(sourceName?: string): Promise<void> {
    const names = sourceName ? [sourceName] : Array.from(this.states.keys());
    const promises = names.map((name) => {
      const state = this.states.get(name);
      if (!state) {
        throw new Error(`Scheduler source not found: "${name}"`);
      }
      return this.executeSync(state);
    });
    await Promise.all(promises);
  }

  /**
   * Snapshot of each source's schedule state: whether a run is in flight and
   * when the next fire is due.
   */
  getStatus(): SourceStatus[] {
    return Array.from(this.states.values()).map((state) => ({
      source: state.source.name,
      nextFireAt: state.nextFireAt !== null ? new Date(state.nextFireAt) : null,
      running: state.inFlight !== null,
    }));
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private scheduleNext(name: string): void {
    if (this.stopping || !this.started) return;
    const state = this.states.get(name);
    if (!state || !state.parsed || state.parsed === "startup") return;

    const now = this.clock.now();
    const nextFire = nextFireAfter(state.parsed, now);
    const delay = nextFire - now;

    state.nextFireAt = nextFire;
    state.timer = this.clock.setTimeout(() => {
      state.timer = null;
      state.nextFireAt = null;
      this.fireSource(name);
    }, delay);
  }

  private fireSource(name: string): void {
    const state = this.states.get(name);
    if (!state) return;

    const syncPromise = this.executeSync(state).catch(() => {
      // errors are already routed to onError in executeSync
    });

    syncPromise.finally(() => {
      if (!this.stopping && state.parsed !== "startup") {
        // Reschedule relative to current clock (skip-forward policy).
        this.scheduleNext(name);
      }
    });
  }

  private async executeSync(state: SourceState): Promise<void> {
    if (state.inFlight) {
      // Already running — don't start a concurrent run for the same source
      await state.inFlight;
      return;
    }

    const run = (async () => {
      try {
        await this.runSync(state.source.provider, this.deps);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.onError) {
          try {
            this.onError(state.source.name, error);
          } catch {
            // swallow onError callback failures
          }
        }
      }
    })();

    state.inFlight = run;
    try {
      await run;
    } finally {
      state.inFlight = null;
    }
  }
}
