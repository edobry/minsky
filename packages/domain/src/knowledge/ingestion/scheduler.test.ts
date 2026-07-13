import { describe, it, expect } from "bun:test";
import {
  KnowledgeSyncScheduler,
  parseCron,
  nextFireAfter,
  NAMED_SCHEDULE_TO_CRON,
  type SchedulerClock,
  type TimerHandle,
  type SchedulerSource,
  type RunSyncFn,
} from "./scheduler";
import type { KnowledgeSourceProvider, KnowledgeDocument } from "../types";
import type { SyncRunnerDeps } from "./sync-runner";
import { knowledgeSyncConfigSchema } from "../../configuration/schemas/knowledge-bases";

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

interface Scheduled {
  id: TimerHandle;
  fireAt: number;
  fn: () => void;
  canceled: boolean;
}

class FakeClock implements SchedulerClock {
  private time: number;
  private nextId = 1;
  public scheduled: Scheduled[] = [];

  constructor(startMs: number) {
    this.time = startMs;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = { __id: this.nextId++ } as unknown as TimerHandle;
    this.scheduled.push({ id, fireAt: this.time + ms, fn, canceled: false });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    const entry = this.scheduled.find((s) => s.id === handle);
    if (entry) entry.canceled = true;
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    // Fire every pending timer whose fireAt is ≤ target, in order
    while (true) {
      const due = this.scheduled
        .filter((s) => !s.canceled && s.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!due) break;
      this.time = due.fireAt;
      due.canceled = true; // consumed
      due.fn();
      // Yield to microtasks so setTimeout callbacks can schedule follow-up timers
      await new Promise<void>((r) => setImmediate(r));
    }
    this.time = target;
  }

  pendingCount(): number {
    return this.scheduled.filter((s) => !s.canceled).length;
  }
}

// ---------------------------------------------------------------------------
// Fake provider / runSync
// ---------------------------------------------------------------------------

function makeProvider(name: string): KnowledgeSourceProvider {
  return {
    sourceType: "fake",
    sourceName: name,
    async *listDocuments(): AsyncIterable<KnowledgeDocument> {
      // no-op
    },
    async fetchDocument() {
      throw new Error("not implemented");
    },
    async *getChangedSince() {
      // no-op
    },
  };
}

function makeDeps(): SyncRunnerDeps {
  return {
    embeddingService: {} as SyncRunnerDeps["embeddingService"],
    vectorStorage: {} as SyncRunnerDeps["vectorStorage"],
  };
}

// ---------------------------------------------------------------------------
// Cron parsing
// ---------------------------------------------------------------------------

describe("parseCron", () => {
  it("parses wildcards", () => {
    const p = parseCron("* * * * *");
    expect(p.minute.size).toBe(60);
    expect(p.hour.size).toBe(24);
    expect(p.dom.size).toBe(31);
    expect(p.month.size).toBe(12);
    expect(p.dow.size).toBe(7);
  });

  it("parses specific values", () => {
    const p = parseCron("0 2 * * *");
    expect(Array.from(p.minute)).toEqual([0]);
    expect(Array.from(p.hour)).toEqual([2]);
  });

  it("parses ranges", () => {
    const p = parseCron("0 9-17 * * *");
    expect(Array.from(p.hour).sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("parses steps", () => {
    const p = parseCron("0 */6 * * *");
    expect(Array.from(p.hour).sort((a, b) => a - b)).toEqual([0, 6, 12, 18]);
  });

  it("rejects expressions with the wrong number of fields", () => {
    expect(() => parseCron("0 2 *")).toThrow(/expected 5 fields/);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/Invalid cron/);
    expect(() => parseCron("* 24 * * *")).toThrow(/Invalid cron/);
  });
});

// ---------------------------------------------------------------------------
// Next-fire calculation
// ---------------------------------------------------------------------------

describe("nextFireAfter", () => {
  it("computes the next hourly fire", () => {
    const parsed = parseCron("0 * * * *");
    // 00:30:00 UTC → next fire should be 01:00:00 UTC
    const now = Date.UTC(2026, 0, 1, 0, 30, 0);
    const next = nextFireAfter(parsed, now);
    expect(next).toBe(Date.UTC(2026, 0, 1, 1, 0, 0));
  });

  it("computes the next daily fire at 02:00 UTC", () => {
    const parsed = parseCron("0 2 * * *");
    // 01:30 → 02:00 same day
    const now1 = Date.UTC(2026, 0, 1, 1, 30, 0);
    expect(nextFireAfter(parsed, now1)).toBe(Date.UTC(2026, 0, 1, 2, 0, 0));
    // 03:00 → 02:00 next day
    const now2 = Date.UTC(2026, 0, 1, 3, 0, 0);
    expect(nextFireAfter(parsed, now2)).toBe(Date.UTC(2026, 0, 2, 2, 0, 0));
  });

  it("computes the next weekly fire", () => {
    const parsed = parseCron("0 2 * * 0"); // Sunday 02:00 UTC
    // 2026-01-01 is a Thursday (dow=4); next Sunday is 2026-01-04
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(nextFireAfter(parsed, now)).toBe(Date.UTC(2026, 0, 4, 2, 0, 0));
  });
});

// ---------------------------------------------------------------------------
// Scheduler lifecycle
// ---------------------------------------------------------------------------

describe("KnowledgeSyncScheduler — lifecycle", () => {
  it("fires a daily-schedule source at 02:00 UTC", async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const calls: string[] = [];
    const runSync: RunSyncFn = async (provider) => {
      calls.push(provider.sourceName);
      return {
        sourceName: provider.sourceName,
        added: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
        duration: 0,
      };
    };

    const sources: SchedulerSource[] = [
      { name: "daily-src", provider: makeProvider("daily-src"), schedule: "daily" },
    ];

    const scheduler = new KnowledgeSyncScheduler({
      sources,
      deps: makeDeps(),
      runSync,
      clock,
    });
    scheduler.start();

    // Before 02:00, no fires
    await clock.advance(1 * 60 * 60 * 1000); // +1h → 01:00
    expect(calls).toEqual([]);

    // Advance to 02:01 — should have fired once
    await clock.advance(1 * 60 * 60 * 1000 + 60_000); // +1h1m → 02:01
    expect(calls).toEqual(["daily-src"]);

    // Advance another 24h → should fire again
    await clock.advance(24 * 60 * 60 * 1000);
    expect(calls).toEqual(["daily-src", "daily-src"]);

    await scheduler.stop();
  });

  it("fires a */6 hours cron schedule correctly", async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const calls: string[] = [];
    const runSync: RunSyncFn = async (provider) => {
      calls.push(provider.sourceName);
      return {
        sourceName: provider.sourceName,
        added: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
        duration: 0,
      };
    };

    const scheduler = new KnowledgeSyncScheduler({
      sources: [
        { name: "six-hourly", provider: makeProvider("six-hourly"), schedule: "0 */6 * * *" },
      ],
      deps: makeDeps(),
      runSync,
      clock,
    });
    scheduler.start();

    // Advance to 06:01 → one fire
    await clock.advance(6 * 60 * 60 * 1000 + 60_000);
    expect(calls).toEqual(["six-hourly"]);

    // Advance to 12:01 (another 6h) → two fires total
    await clock.advance(6 * 60 * 60 * 1000);
    expect(calls).toEqual(["six-hourly", "six-hourly"]);

    await scheduler.stop();
  });

  it("fires a startup-mode source exactly once at start", async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const calls: string[] = [];
    const runSync: RunSyncFn = async (provider) => {
      calls.push(provider.sourceName);
      return {
        sourceName: provider.sourceName,
        added: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
        duration: 0,
      };
    };

    const scheduler = new KnowledgeSyncScheduler({
      sources: [
        { name: "startup-src", provider: makeProvider("startup-src"), schedule: "startup" },
      ],
      deps: makeDeps(),
      runSync,
      clock,
    });
    scheduler.start();
    // Let the synchronous fire-and-forget kick off
    await new Promise<void>((r) => setImmediate(r));

    // Even after advancing far into the future, no second fire
    await clock.advance(30 * 24 * 60 * 60 * 1000);
    expect(calls).toEqual(["startup-src"]);

    await scheduler.stop();
  });

  it("on-demand sources never auto-fire", async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const calls: string[] = [];
    const runSync: RunSyncFn = async (provider) => {
      calls.push(provider.sourceName);
      return {
        sourceName: provider.sourceName,
        added: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
        duration: 0,
      };
    };

    const scheduler = new KnowledgeSyncScheduler({
      sources: [{ name: "manual", provider: makeProvider("manual"), schedule: "on-demand" }],
      deps: makeDeps(),
      runSync,
      clock,
    });
    scheduler.start();

    // Advance way into the future; no fires
    await clock.advance(30 * 24 * 60 * 60 * 1000);
    expect(calls).toEqual([]);
    expect(clock.pendingCount()).toBe(0);

    await scheduler.stop();
  });

  it("applies the skip-forward missed-run policy", async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const calls: number[] = [];
    const runSync: RunSyncFn = async () => {
      calls.push(clock.now());
      return {
        sourceName: "",
        added: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
        duration: 0,
      };
    };

    // Build scheduler but start it AFTER we advance past the first would-be fire time.
    const scheduler = new KnowledgeSyncScheduler({
      sources: [{ name: "hourly-src", provider: makeProvider("hourly-src"), schedule: "hourly" }],
      deps: makeDeps(),
      runSync,
      clock,
    });

    // Skip to 02:30 — we have already missed both 01:00 and 02:00
    await clock.advance(2 * 60 * 60 * 1000 + 30 * 60 * 1000);

    // Now start — next fire should be 03:00, not a catch-up for 01:00 and 02:00
    scheduler.start();
    await clock.advance(30 * 60 * 1000 + 60_000); // +30m+1m → 03:01
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(Date.UTC(2026, 0, 1, 3, 0, 0));

    await scheduler.stop();
  });

  it("stop() cancels pending timers", async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    let called = false;
    const runSync: RunSyncFn = async () => {
      called = true;
      return {
        sourceName: "",
        added: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
        duration: 0,
      };
    };

    const scheduler = new KnowledgeSyncScheduler({
      sources: [{ name: "daily-src", provider: makeProvider("daily-src"), schedule: "daily" }],
      deps: makeDeps(),
      runSync,
      clock,
    });
    scheduler.start();
    expect(clock.pendingCount()).toBe(1);

    await scheduler.stop();
    expect(clock.pendingCount()).toBe(0);

    // Advance past the would-be fire time — nothing should happen
    await clock.advance(24 * 60 * 60 * 1000);
    expect(called).toBe(false);
  });

  it("runNow triggers an immediate sync for one source without affecting others", async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const calls: string[] = [];
    const runSync: RunSyncFn = async (provider) => {
      calls.push(provider.sourceName);
      return {
        sourceName: provider.sourceName,
        added: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
        duration: 0,
      };
    };

    const scheduler = new KnowledgeSyncScheduler({
      sources: [
        { name: "a", provider: makeProvider("a"), schedule: "daily" },
        { name: "b", provider: makeProvider("b"), schedule: "daily" },
      ],
      deps: makeDeps(),
      runSync,
      clock,
    });
    scheduler.start();

    await scheduler.runNow("a");
    expect(calls).toEqual(["a"]);

    await scheduler.stop();
  });

  it("invokes onError and continues running when runSync throws", async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const errors: Array<{ source: string; message: string }> = [];
    const calls: string[] = [];
    let throwOnce = true;
    const runSync: RunSyncFn = async (provider) => {
      calls.push(provider.sourceName);
      if (throwOnce) {
        throwOnce = false;
        throw new Error("boom");
      }
      return {
        sourceName: provider.sourceName,
        added: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
        duration: 0,
      };
    };

    const scheduler = new KnowledgeSyncScheduler({
      sources: [{ name: "err-src", provider: makeProvider("err-src"), schedule: "hourly" }],
      deps: makeDeps(),
      runSync,
      onError: (source, err) => {
        errors.push({ source, message: err.message });
      },
      clock,
    });
    scheduler.start();

    await clock.advance(60 * 60 * 1000 + 60_000); // +1h1m
    expect(errors.length).toBe(1);
    const firstError = errors[0];
    expect(firstError?.message).toBe("boom");

    // Next fire still scheduled — the scheduler did not break
    await clock.advance(60 * 60 * 1000);
    expect(calls.length).toBe(2);

    await scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Named schedules table correctness
// ---------------------------------------------------------------------------

describe("NAMED_SCHEDULE_TO_CRON", () => {
  it("maps named schedules to expected cron expressions", () => {
    expect(NAMED_SCHEDULE_TO_CRON["on-demand"]).toBe(null);
    expect(NAMED_SCHEDULE_TO_CRON["startup"]).toBe("__startup__");
    expect(NAMED_SCHEDULE_TO_CRON["hourly"]).toBe("0 * * * *");
    expect(NAMED_SCHEDULE_TO_CRON["daily"]).toBe("0 2 * * *");
    expect(NAMED_SCHEDULE_TO_CRON["weekly"]).toBe("0 2 * * 0");
  });
});

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

describe("knowledgeSyncConfigSchema — schedule union", () => {
  it("accepts all named schedule presets", () => {
    for (const name of ["on-demand", "startup", "hourly", "daily", "weekly"]) {
      const parsed = knowledgeSyncConfigSchema.parse({ schedule: name });
      expect(parsed.schedule).toBe(name);
    }
  });

  it("accepts valid cron strings", () => {
    const parsed = knowledgeSyncConfigSchema.parse({ schedule: "0 */6 * * *" });
    expect(parsed.schedule).toBe("0 */6 * * *");
  });

  it("rejects invalid cron strings", () => {
    expect(() => knowledgeSyncConfigSchema.parse({ schedule: "not a cron" })).toThrow();
  });

  it("defaults to on-demand", () => {
    const parsed = knowledgeSyncConfigSchema.parse({});
    expect(parsed.schedule).toBe("on-demand");
  });

  it("is backward compatible with pre-extension configs (schedule: 'daily')", () => {
    const parsed = knowledgeSyncConfigSchema.parse({ schedule: "daily" });
    expect(parsed.schedule).toBe("daily");
  });
});
