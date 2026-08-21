/**
 * Service-window tick tests (mt#4313).
 *
 * These cover the three halves that had no caller before this task: opening a
 * window on its cron schedule, closing it when its duration elapses, and
 * running the reaper's deadline poll. Every collaborator is injected, so
 * nothing here patches a module in place (ADR-036).
 */
import { describe, expect, test } from "bun:test";
import { runServiceWindowTick } from "./sweepers";

const NOW = new Date("2026-08-20T16:00:00.000Z");

/** Deps that do nothing, so each test states only what it is about. */
function inertDeps(overrides: Partial<Parameters<typeof runServiceWindowTick>[0]> = {}) {
  return {
    now: () => NOW,
    fireCronWindows: async () => [],
    listOpenWindows: () => [],
    closeWindow: async () => {},
    pollDeadlineBound: async () => 0,
    ...overrides,
  };
}

describe("runServiceWindowTick", () => {
  test("opens the windows the cron schedule reports as due", async () => {
    const outcome = await runServiceWindowTick(
      inertDeps({ fireCronWindows: async () => ["ask-hours"] })
    );

    expect(outcome.opened).toEqual(["ask-hours"]);
  });

  test("passes the injected clock to the cron check", async () => {
    // Collected rather than assigned to a `let`: TypeScript narrows a
    // closure-assigned `let` back to its initializer type at the assertion.
    const seen: Date[] = [];
    await runServiceWindowTick(
      inertDeps({
        fireCronWindows: async (now) => {
          seen.push(now);
          return [];
        },
      })
    );

    expect(seen).toEqual([NOW]);
  });

  test("closes a window whose expected close time has passed", async () => {
    const closed: string[] = [];
    const outcome = await runServiceWindowTick(
      inertDeps({
        listOpenWindows: () => [
          { windowKey: "ask-hours", expectedCloseAt: new Date(NOW.getTime() - 1_000) },
        ],
        closeWindow: async (key) => {
          closed.push(key);
        },
      })
    );

    expect(closed).toEqual(["ask-hours"]);
    expect(outcome.closed).toEqual(["ask-hours"]);
  });

  test("leaves a window whose close time is still in the future", async () => {
    const closed: string[] = [];
    const outcome = await runServiceWindowTick(
      inertDeps({
        listOpenWindows: () => [
          { windowKey: "ask-hours", expectedCloseAt: new Date(NOW.getTime() + 60_000) },
        ],
        closeWindow: async (key) => {
          closed.push(key);
        },
      })
    );

    expect(closed).toEqual([]);
    expect(outcome.closed).toEqual([]);
  });

  test("a failing close does not stop the other windows or the deadline poll", async () => {
    let polled = false;
    const outcome = await runServiceWindowTick(
      inertDeps({
        listOpenWindows: () => [
          { windowKey: "broken", expectedCloseAt: new Date(NOW.getTime() - 1_000) },
          { windowKey: "ask-hours", expectedCloseAt: new Date(NOW.getTime() - 1_000) },
        ],
        closeWindow: async (key) => {
          if (key === "broken") throw new Error("config missing");
        },
        pollDeadlineBound: async () => {
          polled = true;
          return 2;
        },
      })
    );

    expect(outcome.closeFailures).toBe(1);
    expect(outcome.closed).toEqual(["ask-hours"]);
    expect(polled).toBe(true);
    expect(outcome.dispatched).toBe(2);
  });

  test("runs the deadline poll at the injected time and reports its count", async () => {
    const seenMs: number[] = [];
    const outcome = await runServiceWindowTick(
      inertDeps({
        pollDeadlineBound: async (nowMs) => {
          seenMs.push(nowMs);
          return 3;
        },
      })
    );

    expect(seenMs).toEqual([NOW.getTime()]);
    expect(outcome.dispatched).toBe(3);
  });

  // mt#4364: the shipped tick logged its failures and returned normally, so
  // `createIntervalSweeper` recorded every one of ~390 failing ticks as a
  // success and `/api/sweeps` read `consecutiveFailures: 0, lastErrorAt: null`.
  test("a failed auto-close is reported as a domain failure, not just logged", async () => {
    const outcome = await runServiceWindowTick(
      inertDeps({
        listOpenWindows: () => [
          { windowKey: "ask-hours", expectedCloseAt: new Date(NOW.getTime() - 1_000) },
        ],
        closeWindow: async () => {
          throw new Error("config missing");
        },
      })
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.closeFailures).toBe(1);
  });

  // PR #3198 R2: containing only `closeWindow` left the contract inconsistent —
  // the other three dependency calls escaped to the caller's outer catch, which
  // reports ok:false but discards the counts collected before the throw.
  test("a throwing deadline poll degrades the outcome instead of escaping", async () => {
    const outcome = await runServiceWindowTick(
      inertDeps({
        fireCronWindows: async () => ["ask-hours"],
        pollDeadlineBound: async () => {
          throw new Error("pool recycled");
        },
      })
    );

    expect(outcome.ok).toBe(false);
    // The step that already succeeded is still reported.
    expect(outcome.opened).toEqual(["ask-hours"]);
  });

  test("a throwing cron open degrades the outcome and the poll still runs", async () => {
    let polled = false;
    const outcome = await runServiceWindowTick(
      inertDeps({
        fireCronWindows: async () => {
          throw new Error("config unreadable");
        },
        pollDeadlineBound: async () => {
          polled = true;
          return 0;
        },
      })
    );

    expect(outcome.ok).toBe(false);
    expect(polled).toBe(true);
  });

  test("a throwing open-window enumeration degrades the outcome and the poll still runs", async () => {
    let polled = false;
    const outcome = await runServiceWindowTick(
      inertDeps({
        listOpenWindows: () => {
          throw new Error("registry unavailable");
        },
        pollDeadlineBound: async () => {
          polled = true;
          return 0;
        },
      })
    );

    expect(outcome.ok).toBe(false);
    expect(polled).toBe(true);
  });

  test("a healthy tick reports ok", async () => {
    const outcome = await runServiceWindowTick(
      inertDeps({
        fireCronWindows: async () => ["ask-hours"],
        pollDeadlineBound: async () => 1,
      })
    );

    expect(outcome.ok).toBe(true);
  });

  test("a quiet tick reports nothing happened rather than throwing", async () => {
    const outcome = await runServiceWindowTick(inertDeps());

    expect(outcome).toEqual({ ok: true, opened: [], closed: [], closeFailures: 0, dispatched: 0 });
  });
});
