/**
 * Tests for window commands and domain logic — mt#1489 + mt#1491.
 *
 * Tests openWindow / closeWindow domain functions, the cron integration
 * helper, and the window.service render + response loop. Uses the
 * recording notifier for hermetic event assertion and the FakeAskRepository
 * for in-memory ask persistence.
 *
 * checkAndFireCronWindows tests use an in-memory LoaderFs (empty = no config
 * file = defaults) so no real filesystem or env-var manipulation is needed.
 */

import { describe, test, expect } from "bun:test";
import {
  openWindow,
  closeWindow,
  checkAndFireCronWindows,
  OpenWindowRegistry,
  parseServiceCommand,
  renderAsk,
  renderCohortDigest,
  serviceWindow,
  type StdinReader,
  type WindowServiceResult,
} from "./index";
import { createRecordingWindowNotifier } from "@minsky/domain/ask/attention-windows/notify";
import type { AttentionWindowConfig } from "@minsky/domain/ask/attention-windows/config";
import type { LoaderFs } from "@minsky/domain/ask/attention-windows/loader";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import type { Ask, AskKind, AskOption } from "@minsky/domain/ask/types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const WINDOWS: AttentionWindowConfig[] = [
  {
    key: "ask-hours",
    schedule: { type: "cron", expr: "0 16 * * 1-5" },
    durationMin: 30,
    maxMisses: 2,
    description: "Daily 4pm window",
  },
  {
    key: "weekly-review",
    schedule: { type: "cron", expr: "0 10 * * 1" },
    durationMin: 60,
    maxMisses: 1,
    description: "Weekly Monday",
  },
  {
    key: "on-demand",
    schedule: { type: "manual" },
    durationMin: 30,
    maxMisses: -1,
  },
];

function makeRegistry(): OpenWindowRegistry {
  return new OpenWindowRegistry();
}

/**
 * In-memory LoaderFs: empty map means no config file exists, so the loader
 * falls back to DEFAULT_ATTENTION_WINDOWS.
 */
function makeEmptyLoaderFs(): LoaderFs {
  return {
    existsSync(_path: string): boolean {
      return false;
    },
    readFileSync(_path: string, _encoding: "utf8"): string {
      throw new Error("ENOENT");
    },
  };
}

// ---------------------------------------------------------------------------
// openWindow
// ---------------------------------------------------------------------------

describe("openWindow", () => {
  test("opens a window and records state in registry", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    const result = await openWindow("ask-hours", WINDOWS, notifier, registry);

    expect(result.windowKey).toBe("ask-hours");
    expect(result.durationMin).toBe(30);
    expect(result.alreadyOpen).toBe(false);
    expect(registry.isOpen("ask-hours")).toBe(true);
  });

  test("emits a NOTIFY opened event", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    await openWindow("ask-hours", WINDOWS, notifier, registry);

    expect(notifier.openedEvents).toHaveLength(1);
    const evt = notifier.openedEvents[0];
    if (!evt) throw new Error("expected opened event");
    expect(evt.windowKey).toBe("ask-hours");
    expect(evt.durationMin).toBe(30);
    // expectedCloseAt should be 30 minutes after openedAt
    const opened = new Date(evt.openedAt);
    const expected = new Date(evt.expectedCloseAt);
    expect(expected.getTime() - opened.getTime()).toBe(30 * 60_000);
  });

  test("is idempotent when called twice: does not re-emit", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    await openWindow("ask-hours", WINDOWS, notifier, registry);
    const result2 = await openWindow("ask-hours", WINDOWS, notifier, registry);

    expect(result2.alreadyOpen).toBe(true);
    expect(notifier.openedEvents).toHaveLength(1); // only emitted once
  });

  test("throws on unknown window key", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    await expect(openWindow("nonexistent", WINDOWS, notifier, registry)).rejects.toThrow(
      "unknown window key"
    );
  });

  test("opens a manual window when called explicitly", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    const result = await openWindow("on-demand", WINDOWS, notifier, registry);
    expect(result.windowKey).toBe("on-demand");
    expect(notifier.openedEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// closeWindow
// ---------------------------------------------------------------------------

describe("closeWindow", () => {
  test("closes an open window", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    await openWindow("ask-hours", WINDOWS, notifier, registry);
    const result = await closeWindow("ask-hours", WINDOWS, notifier, registry);

    expect(result.windowKey).toBe("ask-hours");
    expect(result.wasOpen).toBe(true);
    expect(registry.isOpen("ask-hours")).toBe(false);
  });

  test("emits a NOTIFY closed event", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    await openWindow("ask-hours", WINDOWS, notifier, registry);
    await closeWindow("ask-hours", WINDOWS, notifier, registry);

    expect(notifier.closedEvents).toHaveLength(1);
    const closedEvt = notifier.closedEvents[0];
    if (!closedEvt) throw new Error("expected closed event");
    expect(closedEvt.windowKey).toBe("ask-hours");
  });

  test("is idempotent when window is not open", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    const result = await closeWindow("ask-hours", WINDOWS, notifier, registry);

    expect(result.wasOpen).toBe(false);
    expect(notifier.closedEvents).toHaveLength(0);
  });

  test("throws on unknown window key", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    await expect(closeWindow("nonexistent", WINDOWS, notifier, registry)).rejects.toThrow(
      "unknown window key"
    );
  });
});

// ---------------------------------------------------------------------------
// checkAndFireCronWindows
// ---------------------------------------------------------------------------

describe("checkAndFireCronWindows", () => {
  // Use an in-memory LoaderFs that has no files, causing the loader to fall
  // back to DEFAULT_ATTENTION_WINDOWS. This avoids any env-var manipulation.
  const emptyFs = makeEmptyLoaderFs();

  test("opens windows whose cron expression fires at the given time", async () => {
    // Default windows include ask-hours: "0 16 * * 1-5" (Mon-Fri 16:00)
    // 2024-04-15 is a Monday.
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    const lastFiredAt = new Map<string, Date>();

    // Construct a Date whose local time reads as Monday 16:00
    const utcMs = Date.UTC(2024, 3, 15, 16, 0, 0); // April 15 2024 UTC
    const now = new Date(utcMs);
    // Shift so local hour/minute = 16:00
    const localHour = now.getHours();
    const localMinute = now.getMinutes();
    const shifted = new Date(utcMs + (16 - localHour) * 3_600_000 + (0 - localMinute) * 60_000);

    const fired = await checkAndFireCronWindows(notifier, registry, lastFiredAt, shifted, emptyFs);
    // Should fire ask-hours (default window "0 16 * * 1-5") on Monday
    expect(fired).toContain("ask-hours");
  });

  test("returns an array (manual-only path)", async () => {
    // shouldWindowFireNow({ type: "manual" }, ...) always returns false.
    // Verify the cron helper returns cleanly when no windows fire.
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    const fired = await checkAndFireCronWindows(
      notifier,
      registry,
      new Map(),
      new Date("2024-04-15T09:00:00.000Z"),
      emptyFs
    );
    expect(Array.isArray(fired)).toBe(true);
  });

  test("does not re-fire when lastFiredAt is in the same minute", async () => {
    const notifier = createRecordingWindowNotifier();
    const registry = makeRegistry();
    const lastFiredAt = new Map<string, Date>();

    const utcMs = Date.UTC(2024, 3, 15, 16, 0, 0);
    const tmp = new Date(utcMs);
    const shifted = new Date(
      utcMs + (16 - tmp.getHours()) * 3_600_000 + (0 - tmp.getMinutes()) * 60_000
    );

    // First call — should fire
    await checkAndFireCronWindows(notifier, registry, lastFiredAt, shifted, emptyFs);
    const firstFiredCount = notifier.openedEvents.length;

    // Second call same minute — should NOT re-fire
    await checkAndFireCronWindows(notifier, registry, lastFiredAt, shifted, emptyFs);
    expect(notifier.openedEvents).toHaveLength(firstFiredCount);
  });
});

// ---------------------------------------------------------------------------
// window.service — mt#1491
// ---------------------------------------------------------------------------

/**
 * Build a fake StdinReader that yields the given lines in order, then null.
 * Used by serviceWindow tests to simulate operator input without touching
 * process.stdin.
 */
function makeFakeStdinReader(lines: string[]): StdinReader {
  let i = 0;
  return {
    async readLine(): Promise<string | null> {
      if (i >= lines.length) return null;
      return lines[i++] ?? null;
    },
  };
}

/**
 * Seed the FakeAskRepository with a "suspended" Ask, walking it through
 * detected → classified → suspended (the window-deferred lifecycle).
 */
async function seedSuspendedAsk(
  repo: FakeAskRepository,
  opts: {
    kind: AskKind;
    parentTaskId?: string;
    title: string;
    question: string;
    options?: AskOption[];
    serviceStrategy?: Ask["serviceStrategy"];
    windowKey?: string;
    contextRefs?: Ask["contextRefs"];
    metadata?: Record<string, unknown>;
  }
): Promise<Ask> {
  const created = await repo.create({
    kind: opts.kind,
    classifierVersion: "test-1",
    requestor: "com.anthropic.claude-code:proc:test",
    parentTaskId: opts.parentTaskId,
    title: opts.title,
    question: opts.question,
    options: opts.options,
    contextRefs: opts.contextRefs,
    metadata: opts.metadata,
    serviceStrategy: opts.serviceStrategy ?? "scheduled",
    windowKey: opts.windowKey ?? "ask-hours",
  });
  await repo.transition(created.id, "classified");
  await repo.transition(created.id, "suspended");
  const final = await repo.getById(created.id);
  if (!final) throw new Error("seeded ask missing");
  return final;
}

const TWO_OPTIONS: AskOption[] = [
  { label: "Postgres", value: "postgres", description: "already deployed" },
  { label: "Redis", value: "redis", description: "second source of truth" },
];

// Local kind constants — extracted to satisfy custom/no-magic-string-duplication
// (each AskKind appears in many test fixtures across describe blocks).
const KIND_DECIDE: AskKind = "direction.decide";
const KIND_APPROVE: AskKind = "authorization.approve";
const KIND_REVIEW: AskKind = "quality.review";

describe("parseServiceCommand", () => {
  test("parses `done` (case-insensitive)", () => {
    expect(parseServiceCommand("done")).toEqual({ type: "done" });
    expect(parseServiceCommand("DONE")).toEqual({ type: "done" });
    expect(parseServiceCommand("  done  ")).toEqual({ type: "done" });
  });

  test("parses `skip N`", () => {
    expect(parseServiceCommand("skip 2")).toEqual({ type: "skip", index: 2 });
    expect(parseServiceCommand("SKIP 11")).toEqual({ type: "skip", index: 11 });
  });

  test("parses `<N><letter>` as respond", () => {
    expect(parseServiceCommand("1A")).toEqual({
      type: "respond",
      index: 1,
      optionLetter: "A",
    });
    expect(parseServiceCommand("3b")).toEqual({
      type: "respond",
      index: 3,
      optionLetter: "B",
    });
  });

  test("returns null for unrecognized input", () => {
    expect(parseServiceCommand("")).toBeNull();
    expect(parseServiceCommand("blah")).toBeNull();
    expect(parseServiceCommand("1")).toBeNull();
    expect(parseServiceCommand("A")).toBeNull();
    expect(parseServiceCommand("12AB")).toBeNull();
  });
});

describe("renderAsk", () => {
  test("renders direction.decide with humility 5-item checklist", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "Cache choice",
      question: "Postgres vs Redis for cache?",
      options: TWO_OPTIONS,
      contextRefs: [
        { kind: "spec", ref: "mt#1500", description: "latency budget" },
        { kind: "spec", ref: "mt#1500", description: "operational complexity" },
      ],
      metadata: { notNeeded: "cost analysis (already done)" },
    });
    const out = renderAsk(1, ask);

    // 1. Question
    expect(out).toContain("Q: Postgres vs Redis for cache?");
    // 2. Options inline
    expect(out).toContain("A) Postgres");
    expect(out).toContain("B) Redis");
    // 3. Drivers (from contextRefs descriptions)
    expect(out).toContain("Drivers:");
    expect(out).toContain("latency budget");
    expect(out).toContain("operational complexity");
    // 4. Recommendation marker on first option
    expect(out).toContain("(recommended)");
    // 5. What-not-needed
    expect(out).toContain("Not needed: cost analysis");
    // Index header
    expect(out).toMatch(/^\[1\] direction\.decide/);
    // Reply affordance
    expect(out).toContain("Reply: 1A");
  });

  test("renders authorization.approve with approve/deny affordance", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_APPROVE,
      parentTaskId: "mt#1500",
      title: "deploy",
      question: "OK to deploy v2?",
    });
    const out = renderAsk(1, ask);
    expect(out).toContain("A) Approve");
    expect(out).toContain("B) Deny");
    expect(out).toContain("Reply: 1A (approve)");
  });

  // PR #943 R2 BLOCKING #1: Reply hint must use the Ask's display index
  // (not the option ordinal) so operators don't accidentally close the wrong Ask.
  test("Reply hint embeds the Ask's display index for index > 1", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "third",
      question: "Q?",
      options: TWO_OPTIONS,
    });
    const out = renderAsk(3, ask);
    expect(out).toContain("Reply: 3A | 3B | skip 3 | done");
    expect(out).not.toContain("Reply: 1A");
    expect(out).not.toContain("2B |");
  });

  // PR #943 R2 BLOCKING #3: rendering caps options at 26 (A–Z)
  test("renders only first 26 options + overflow note when ask has > 26 options", async () => {
    const manyOptions: AskOption[] = Array.from({ length: 30 }, (_, i) => ({
      label: `Option ${i + 1}`,
      value: `opt${i + 1}`,
    }));
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "many",
      question: "Pick?",
      options: manyOptions,
    });
    const out = renderAsk(1, ask);
    // First 26 letters render with their option label
    expect(out).toContain("A) Option 1");
    expect(out).toContain("Z) Option 26");
    // No 27th letter / no numeric fallback render
    expect(out).not.toContain("27) Option 27");
    // Overflow note present
    expect(out).toContain("4 more options not selectable in v1");
    // Reply hint stops at Z, doesn't include 27/28/29/30
    expect(out).toContain("1A | 1B");
    expect(out).toContain("1Z | skip 1 | done");
    expect(out).not.toContain("127");
  });

  test("renders quality.review with approve/changes affordance", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_REVIEW,
      parentTaskId: "mt#1500",
      title: "review",
      question: "Approve PR?",
    });
    const out = renderAsk(1, ask);
    expect(out).toContain("A) Approve");
    expect(out).toContain("B) Request changes");
    expect(out).toContain("Reply: 1A (approve)");
    expect(out).toContain("1B (changes)");
  });
});

describe("renderCohortDigest", () => {
  test("renders empty-state for empty cohort", () => {
    const out = renderCohortDigest("ask-hours", []);
    expect(out).toContain("No pending asks");
    expect(out).toContain("ask-hours");
  });

  test("groups asks by parentTaskId with task headers + numbered items", async () => {
    const repo = new FakeAskRepository();
    const a1 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "first",
      question: "Q1?",
      options: TWO_OPTIONS,
    });
    const a2 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "second",
      question: "Q2?",
      options: TWO_OPTIONS,
    });
    const a3 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1501",
      title: "third",
      question: "Q3?",
      options: TWO_OPTIONS,
    });
    const out = renderCohortDigest("ask-hours", [a1, a2, a3]);

    // Task section headers
    expect(out).toContain("## mt#1500 — 2 decisions");
    expect(out).toContain("## mt#1501 — 1 decision");
    // Three numbered items
    expect(out).toContain("[1] direction.decide");
    expect(out).toContain("[2] direction.decide");
    expect(out).toContain("[3] direction.decide");
    // Footer (PR #943 R1 NB#1: generic letter placeholder, not concrete A/B)
    expect(out).toContain("respond [N<letter> | skip N | done]");
  });
});

describe("serviceWindow", () => {
  // Acceptance test 5: empty cohort
  test("empty cohort → renders empty-state, returns zero counts", async () => {
    const repo = new FakeAskRepository();
    const stdin = makeFakeStdinReader([]);
    const lines: string[] = [];
    const result = await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      (t) => lines.push(t),
      Date.now(),
      async () => []
    );
    expect(result).toEqual({
      windowKey: "ask-hours",
      responded: 0,
      skipped: 0,
      remaining: 0,
    } satisfies WindowServiceResult);
    expect(lines.join("\n")).toContain("No pending asks");
  });

  // Acceptance test 1: render shape with 3 decide asks across 2 tasks
  test("renders 2 task sections + 3 numbered items, priority-sorted", async () => {
    const repo = new FakeAskRepository();
    const a1 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "auth",
      question: "Postgres vs Redis?",
      options: TWO_OPTIONS,
    });
    const a2 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "module name",
      question: "What name?",
      options: TWO_OPTIONS,
    });
    const a3 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1501",
      title: "chart lib",
      question: "Recharts or Visx?",
      options: TWO_OPTIONS,
    });
    const lines: string[] = [];
    const stdin = makeFakeStdinReader(["done"]);
    const result = await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      (t) => lines.push(t),
      Date.now(),
      async () => [a1, a2, a3]
    );
    const text = lines.join("\n");
    expect(text).toContain("## mt#1500 — 2 decisions");
    expect(text).toContain("## mt#1501 — 1 decision");
    expect(text).toContain("[1]");
    expect(text).toContain("[2]");
    expect(text).toContain("[3]");
    // None handled because user immediately said `done`
    expect(result).toEqual({
      windowKey: "ask-hours",
      responded: 0,
      skipped: 0,
      remaining: 3,
    } satisfies WindowServiceResult);
  });

  // Acceptance test 2: reply 1A closes ask 1 with option=A payload
  test("`1A` propagates response via respondAndClose; ask 1 closes; 2 remain", async () => {
    const repo = new FakeAskRepository();
    const a1 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "first",
      question: "Q1?",
      options: TWO_OPTIONS,
    });
    const a2 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "second",
      question: "Q2?",
      options: TWO_OPTIONS,
    });
    const a3 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1501",
      title: "third",
      question: "Q3?",
      options: TWO_OPTIONS,
    });
    const stdin = makeFakeStdinReader(["1A", "done"]);
    const result = await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      () => {},
      Date.now(),
      async () => [a1, a2, a3]
    );

    expect(result.responded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.remaining).toBe(2);

    // Verify ask 1 is closed with option=postgres (the value of the "A" option)
    const closed = await repo.getById(a1.id);
    expect(closed?.state).toBe("closed");
    expect(closed?.response?.payload).toEqual({
      option: "postgres",
      chosen: "postgres",
    });

    // Asks 2 and 3 should still be suspended
    const stillA2 = await repo.getById(a2.id);
    const stillA3 = await repo.getById(a3.id);
    expect(stillA2?.state).toBe("suspended");
    expect(stillA3?.state).toBe("suspended");
  });

  // Acceptance test 3: reply done after 1 → remaining stay suspended
  test("`done` after responding to 1 → 2 remain suspended for next window", async () => {
    const repo = new FakeAskRepository();
    const a1 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "a",
      question: "Q?",
      options: TWO_OPTIONS,
    });
    const a2 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "b",
      question: "Q?",
      options: TWO_OPTIONS,
    });
    const a3 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1501",
      title: "c",
      question: "Q?",
      options: TWO_OPTIONS,
    });
    const stdin = makeFakeStdinReader(["1B", "done"]);
    const result = await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      () => {},
      Date.now(),
      async () => [a1, a2, a3]
    );

    expect(result.responded).toBe(1);
    expect(result.remaining).toBe(2);

    const stillA2 = await repo.getById(a2.id);
    const stillA3 = await repo.getById(a3.id);
    expect(stillA2?.state).toBe("suspended");
    expect(stillA3?.state).toBe("suspended");
  });

  // Acceptance test 4: skip 2 keeps Ask 2 suspended without response
  test("`skip 2` defers ask 2 (no response written); other asks still pending", async () => {
    const repo = new FakeAskRepository();
    const a1 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "a",
      question: "Q?",
      options: TWO_OPTIONS,
    });
    const a2 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "b",
      question: "Q?",
      options: TWO_OPTIONS,
    });
    const a3 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1501",
      title: "c",
      question: "Q?",
      options: TWO_OPTIONS,
    });
    const stdin = makeFakeStdinReader(["skip 2", "done"]);
    const result = await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      () => {},
      Date.now(),
      async () => [a1, a2, a3]
    );

    expect(result.responded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.remaining).toBe(2);

    // Ask 2 was not responded to — still suspended, no response payload
    const stillA2 = await repo.getById(a2.id);
    expect(stillA2?.state).toBe("suspended");
    expect(stillA2?.response).toBeUndefined();
  });

  // Acceptance test 6: mixed kinds render with kind-appropriate affordances
  test("mixed kinds (decide + approve + review) render kind-appropriate affordances", async () => {
    const repo = new FakeAskRepository();
    const decide = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "decide",
      question: "A or B?",
      options: TWO_OPTIONS,
    });
    const approve = await seedSuspendedAsk(repo, {
      kind: KIND_APPROVE,
      parentTaskId: "mt#1500",
      title: "approve",
      question: "Deploy?",
    });
    const review = await seedSuspendedAsk(repo, {
      kind: KIND_REVIEW,
      parentTaskId: "mt#1500",
      title: "review",
      question: "PR ok?",
    });
    const lines: string[] = [];
    const stdin = makeFakeStdinReader(["done"]);
    await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      (t) => lines.push(t),
      Date.now(),
      async () => [decide, approve, review]
    );
    const text = lines.join("\n");
    // direction.decide affordance — labeled options
    expect(text).toContain("A) Postgres");
    // authorization.approve affordance
    expect(text).toMatch(/Reply:\s+\dA \(approve\)/);
    // quality.review affordance
    expect(text).toContain("(changes)");
  });

  test("authorization.approve `1A` writes { approved: true }", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_APPROVE,
      parentTaskId: "mt#1500",
      title: "deploy",
      question: "Deploy?",
    });
    const stdin = makeFakeStdinReader(["1A"]);
    await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      () => {},
      Date.now(),
      async () => [ask]
    );
    const closed = await repo.getById(ask.id);
    expect(closed?.state).toBe("closed");
    expect(closed?.response?.payload).toEqual({ approved: true });
  });

  test("authorization.approve `1B` writes { approved: false }", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_APPROVE,
      parentTaskId: "mt#1500",
      title: "deploy",
      question: "Deploy?",
    });
    const stdin = makeFakeStdinReader(["1B"]);
    await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      () => {},
      Date.now(),
      async () => [ask]
    );
    const closed = await repo.getById(ask.id);
    expect(closed?.response?.payload).toEqual({ approved: false });
  });

  test("EOF (null from stdin) exits cleanly", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "a",
      question: "Q?",
      options: TWO_OPTIONS,
    });
    const stdin = makeFakeStdinReader([]); // EOF immediately
    const result = await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      () => {},
      Date.now(),
      async () => [ask]
    );
    expect(result.responded).toBe(0);
    expect(result.remaining).toBe(1);
  });

  test("unrecognized input continues the loop without consuming an ask", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "a",
      question: "Q?",
      options: TWO_OPTIONS,
    });
    const lines: string[] = [];
    const stdin = makeFakeStdinReader(["garbage", "1A"]);
    const result = await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      (t) => lines.push(t),
      Date.now(),
      async () => [ask]
    );
    expect(result.responded).toBe(1);
    expect(lines.some((l) => l.includes("Unrecognised input"))).toBe(true);
  });

  // PR #943 R3 BLOCKING #1: kinds outside the v1 CLI-respondable set
  // (e.g. coordination.notify) must render skip-only and reject respond.
  test("renders skip-only affordance for non-v1 kinds (e.g. coordination.notify)", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: "coordination.notify",
      parentTaskId: "mt#1500",
      title: "notify",
      question: "Heads up?",
    });
    const out = renderAsk(2, ask);
    expect(out).not.toContain("2A");
    expect(out).toContain("not in CLI v1");
    expect(out).toContain("skip 2");
  });

  test("serviceWindow rejects respond on non-v1 kinds without closing the ask", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: "coordination.notify",
      parentTaskId: "mt#1500",
      title: "notify",
      question: "Heads up?",
    });
    const lines: string[] = [];
    const stdin = makeFakeStdinReader(["1A", "skip 1"]);
    const result = await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      (t) => lines.push(t),
      Date.now(),
      async () => [ask]
    );
    expect(result.responded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(lines.some((l) => l.includes("not respondable from CLI v1"))).toBe(true);
    const stillThere = await repo.getById(ask.id);
    expect(stillThere?.state).toBe("suspended");
  });

  // PR #943 R1 BLOCKING #1: approve/review must reject letters beyond A/B
  test("authorization.approve rejects `1C` as out-of-range without consuming the ask", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_APPROVE,
      parentTaskId: "mt#1500",
      title: "deploy",
      question: "Deploy?",
    });
    const lines: string[] = [];
    const stdin = makeFakeStdinReader(["1C", "1A"]);
    const result = await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      (t) => lines.push(t),
      Date.now(),
      async () => [ask]
    );
    expect(result.responded).toBe(1);
    expect(lines.some((l) => l.includes("out of range") && l.includes("A–B"))).toBe(true);
    // Final state: approved=true (from the 1A retry, not silently denied from 1C)
    const closed = await repo.getById(ask.id);
    expect(closed?.response?.payload).toEqual({ approved: true });
  });

  test("quality.review rejects `1Z` as out-of-range without consuming the ask", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_REVIEW,
      parentTaskId: "mt#1500",
      title: "review",
      question: "Approve?",
    });
    const lines: string[] = [];
    const stdin = makeFakeStdinReader(["1Z", "1B"]);
    const result = await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      (t) => lines.push(t),
      Date.now(),
      async () => [ask]
    );
    expect(result.responded).toBe(1);
    expect(lines.some((l) => l.includes("out of range") && l.includes("A–B"))).toBe(true);
    // Final state: approved=false (from the 1B retry, not silently denied from 1Z)
    const closed = await repo.getById(ask.id);
    expect(closed?.response?.payload).toEqual({ approved: false });
  });

  // PR #943 R1 BLOCKING #2: section order is deterministic by first-occurrence
  test("renders task sections in first-occurrence order from the input cohort", async () => {
    const repo = new FakeAskRepository();
    // Asks ordered with mt#1501 appearing FIRST in the input array — section
    // for 1501 should render before 1500 even though 1500 has more asks.
    const a1 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1501",
      title: "early",
      question: "First?",
      options: TWO_OPTIONS,
    });
    const a2 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "later",
      question: "Second?",
      options: TWO_OPTIONS,
    });
    const a3 = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "later2",
      question: "Third?",
      options: TWO_OPTIONS,
    });
    const lines: string[] = [];
    const stdin = makeFakeStdinReader(["done"]);
    await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      (t) => lines.push(t),
      Date.now(),
      async () => [a1, a2, a3]
    );
    const text = lines.join("\n");
    const idx1501 = text.indexOf("## mt#1501");
    const idx1500 = text.indexOf("## mt#1500");
    expect(idx1501).toBeGreaterThan(0);
    expect(idx1500).toBeGreaterThan(idx1501);
  });

  // PR #943 R1 NON-BLOCKING #2: stdinReader.close() called exactly once on exit
  test("calls stdinReader.close() on normal exit", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "a",
      question: "Q?",
      options: TWO_OPTIONS,
    });
    let closeCalls = 0;
    const stdin: StdinReader = {
      async readLine(): Promise<string | null> {
        return null; // EOF immediately
      },
      close(): void {
        closeCalls++;
      },
    };
    await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      () => {},
      Date.now(),
      async () => [ask]
    );
    expect(closeCalls).toBe(1);
  });

  test("calls stdinReader.close() even on empty cohort path", async () => {
    const repo = new FakeAskRepository();
    let closeCalls = 0;
    const stdin: StdinReader = {
      async readLine(): Promise<string | null> {
        return null;
      },
      close(): void {
        closeCalls++;
      },
    };
    await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      () => {},
      Date.now(),
      async () => []
    );
    expect(closeCalls).toBe(1);
  });

  test("out-of-range index is rejected without consuming an ask", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo, {
      kind: KIND_DECIDE,
      parentTaskId: "mt#1500",
      title: "a",
      question: "Q?",
      options: TWO_OPTIONS,
    });
    const lines: string[] = [];
    const stdin = makeFakeStdinReader(["5A", "1A"]);
    const result = await serviceWindow(
      repo,
      "ask-hours",
      stdin,
      (t) => lines.push(t),
      Date.now(),
      async () => [ask]
    );
    expect(result.responded).toBe(1);
    expect(lines.some((l) => l.includes("out of range"))).toBe(true);
  });
});
