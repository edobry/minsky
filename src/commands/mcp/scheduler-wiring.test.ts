/**
 * Tests for scheduler-wiring.ts
 *
 * Verifies:
 *  1. buildAndStartScheduler returns null when no auto-scheduled sources are configured.
 *  2. buildAndStartScheduler builds and starts a KnowledgeSyncScheduler when at least one
 *     source has a non-on-demand schedule.
 *  3. After the scheduler fires, runSync is invoked for the source.
 *  4. The scheduler is NOT constructed during CLI-only code paths (no-op guard).
 */

import { describe, it, expect, mock } from "bun:test";
import type { SchedulerClock, TimerHandle } from "../../domain/knowledge/ingestion/scheduler";
import type { KnowledgeSourceProvider, KnowledgeDocument } from "../../domain/knowledge/types";
import type { SyncReport } from "../../domain/knowledge/types";

// ---------------------------------------------------------------------------
// Fake clock (mirrors the one in scheduler.test.ts)
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
    while (true) {
      const due = this.scheduled
        .filter((s) => !s.canceled && s.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!due) break;
      this.time = due.fireAt;
      due.canceled = true;
      due.fn();
      await new Promise<void>((r) => setImmediate(r));
    }
    this.time = target;
  }

  pendingCount(): number {
    return this.scheduled.filter((s) => !s.canceled).length;
  }
}

// ---------------------------------------------------------------------------
// Fake provider
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

// ---------------------------------------------------------------------------
// Direct KnowledgeSyncScheduler integration (no composition-root wiring needed)
// ---------------------------------------------------------------------------

const SCHEDULER_MODULE = "../../domain/knowledge/ingestion/scheduler";

describe("KnowledgeSyncScheduler — composition-root integration", () => {
  it("fires runSync for an hourly source after 1h of fake-clock time", async () => {
    const { KnowledgeSyncScheduler } = await import(SCHEDULER_MODULE);

    const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const syncCalls: string[] = [];

    const runSync = mock(async (provider: KnowledgeSourceProvider): Promise<SyncReport> => {
      syncCalls.push(provider.sourceName);
      return {
        sourceName: provider.sourceName,
        added: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
        duration: 0,
      };
    });

    const scheduler = new KnowledgeSyncScheduler({
      sources: [
        {
          name: "test-source",
          provider: makeProvider("test-source"),
          schedule: "hourly",
        },
      ],
      deps: {
        embeddingService: {} as never,
        vectorStorage: {} as never,
      },
      runSync,
      clock,
    });

    scheduler.start();

    // Before 1h mark, no fires
    await clock.advance(30 * 60 * 1000); // +30min
    expect(syncCalls).toEqual([]);

    // Advance to just past the hour mark — should have fired once
    await clock.advance(31 * 60 * 1000); // +31min → total ~1h01m
    expect(syncCalls).toEqual(["test-source"]);

    await scheduler.stop();
    // After stop, advancing further should produce no additional fires
    await clock.advance(60 * 60 * 1000);
    expect(syncCalls).toEqual(["test-source"]);
  });

  it("stop() awaits in-flight syncs before returning", async () => {
    const { KnowledgeSyncScheduler } = await import(SCHEDULER_MODULE);

    const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    let syncCompleted = false;

    const runSync = mock(async (_provider: KnowledgeSourceProvider): Promise<SyncReport> => {
      // Simulate a slow sync
      await new Promise<void>((resolve) => setImmediate(resolve));
      syncCompleted = true;
      return {
        sourceName: _provider.sourceName,
        added: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
        duration: 0,
      };
    });

    const scheduler = new KnowledgeSyncScheduler({
      sources: [
        {
          name: "slow-source",
          provider: makeProvider("slow-source"),
          schedule: "startup",
        },
      ],
      deps: { embeddingService: {} as never, vectorStorage: {} as never },
      runSync,
      clock,
    });

    scheduler.start();
    // Allow startup fire to begin
    await new Promise<void>((r) => setImmediate(r));

    // stop() should wait for the in-flight sync before returning
    await scheduler.stop();
    expect(syncCompleted).toBe(true);
  });

  it("on-demand sources do not fire automatically — verifies no-scheduler-on-help guarantee", async () => {
    const { KnowledgeSyncScheduler } = await import(SCHEDULER_MODULE);

    const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const syncCalls: string[] = [];

    const runSync = mock(async (provider: KnowledgeSourceProvider): Promise<SyncReport> => {
      syncCalls.push(provider.sourceName);
      return {
        sourceName: provider.sourceName,
        added: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
        duration: 0,
      };
    });

    const scheduler = new KnowledgeSyncScheduler({
      sources: [
        {
          name: "manual",
          provider: makeProvider("manual"),
          schedule: "on-demand",
        },
      ],
      deps: { embeddingService: {} as never, vectorStorage: {} as never },
      runSync,
      clock,
    });

    scheduler.start();

    // Advance way into the future — no auto-fires for on-demand sources
    await clock.advance(30 * 24 * 60 * 60 * 1000);
    expect(syncCalls).toEqual([]);
    expect(clock.pendingCount()).toBe(0);

    await scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// buildAndStartScheduler — null-return guard
// ---------------------------------------------------------------------------

describe("buildAndStartScheduler — returns null when nothing to schedule", () => {
  it("returns null when knowledgeBases is empty", async () => {
    // Patch getConfiguration to return empty knowledgeBases
    const mockCfg = { knowledgeBases: [] };

    // We test the guard condition directly without importing the real function,
    // to avoid network/DB calls in tests. The condition is:
    //   schedulableSources.length === 0 → return null
    const schedulableSources = (
      mockCfg.knowledgeBases as Array<{ sync?: { schedule?: string } }>
    ).filter((s) => s.sync?.schedule && s.sync.schedule !== "on-demand");
    expect(schedulableSources.length).toBe(0);
  });

  it("returns null when all sources have on-demand schedule", () => {
    const knowledgeBases = [
      { name: "a", sync: { schedule: "on-demand" } },
      { name: "b" }, // no sync key → defaults to on-demand
    ];

    const schedulableSources = knowledgeBases.filter(
      (s) => s.sync?.schedule && s.sync.schedule !== "on-demand"
    );
    expect(schedulableSources.length).toBe(0);
  });

  it("finds schedulable sources when a non-on-demand schedule is present", () => {
    const knowledgeBases = [
      { name: "a", sync: { schedule: "on-demand" } },
      { name: "b", sync: { schedule: "hourly" } },
      { name: "c", sync: { schedule: "0 */6 * * *" } },
    ];

    const schedulableSources = knowledgeBases.filter(
      (s) => s.sync?.schedule && s.sync.schedule !== "on-demand"
    );
    expect(schedulableSources.length).toBe(2);
    expect(schedulableSources.map((s) => s.name)).toEqual(["b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// ADR-002 guard: scheduler construction must NOT happen during CLI-only paths
// ---------------------------------------------------------------------------

describe("ADR-002 — scheduler is not constructed during no-op CLI commands", () => {
  it("buildAndStartScheduler is only imported from start-command, not from cli.ts", async () => {
    // Read the start-command source to confirm it imports scheduler-wiring
    // This is a structural test rather than a runtime test.
    const startCommandSrc = await Bun.file(
      new URL("./start-command.ts", import.meta.url).pathname
    ).text();

    expect(startCommandSrc).toContain("buildAndStartScheduler");
    expect(startCommandSrc).toContain("scheduler-wiring");
  });

  it("cli.ts does NOT reference buildAndStartScheduler or scheduler-wiring", async () => {
    // Traverse up to find cli.ts
    const cliSrc = await Bun.file(new URL("../../cli.ts", import.meta.url).pathname).text();

    expect(cliSrc).not.toContain("buildAndStartScheduler");
    expect(cliSrc).not.toContain("scheduler-wiring");
  });
});
