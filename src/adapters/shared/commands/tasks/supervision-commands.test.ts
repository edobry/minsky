/**
 * Tests for the supervision read surface (mt#4571 AT5, SC8, SC10).
 *
 * AT5 asks that an operator can "query supervisor state mid-run and get the
 * current dispatch set and what it is waiting on". `formatSupervisionStatus` is
 * what actually answers that — it is pure (report in, string out, no IO), so
 * the rendering is testable independently of the database-backed query that
 * feeds it, and the two fail independently.
 *
 * The load-bearing cases are the ones where a wrong render is WORSE than no
 * render: a supervision that has stalled must say so rather than looking idle,
 * and a failed or stranded child must be visible without anyone opening a log
 * (SC10). This corner of the cockpit is exactly where mt#2076/mt#2757 rendered
 * healthy-looking zeros for five weeks while every underlying query failed.
 */
import { describe, test, expect } from "bun:test";
import { formatSupervisionStatus, type SupervisionStatusReport } from "./supervision-commands";

function report(overrides: Partial<SupervisionStatusReport> = {}): SupervisionStatusReport {
  return {
    umbrellaTaskId: "mt#4553",
    supervisionId: "sup-1",
    status: "active",
    statusFilter: ["TODO", "READY"],
    wipLimit: 4,
    model: null,
    lastTickAt: "2026-08-25T20:00:00.000Z",
    lastAdvanceAt: "2026-08-25T19:30:00.000Z",
    waitingOn: null,
    stalled: false,
    stallThresholdHours: 8,
    inFlight: [],
    dispatches: [],
    ...overrides,
  };
}

describe("formatSupervisionStatus — AT5: the current dispatch set", () => {
  test("names each in-flight child, when it started, and its session", () => {
    const text = formatSupervisionStatus(
      report({
        inFlight: [
          {
            taskId: "mt#4554",
            drivenSessionLocalId: "driven-7",
            dispatchedAt: "2026-08-25T19:30:00.000Z",
          },
        ],
        dispatches: [
          {
            taskId: "mt#4554",
            status: "dispatched",
            drivenSessionLocalId: "driven-7",
            minskySessionId: "ws-7",
            dispatchedAt: "2026-08-25T19:30:00.000Z",
          },
        ],
      })
    );

    expect(text).toContain("In flight (1)");
    expect(text).toContain("mt#4554");
    expect(text).toContain("driven-7");
    expect(text).toContain("2026-08-25T19:30:00.000Z");
  });

  test("says 'none' rather than rendering an empty section", () => {
    // An empty list and a section that failed to render look identical
    // otherwise, which is the shape mt#2757 shipped for five weeks.
    expect(formatSupervisionStatus(report())).toContain("In flight: none");
  });
});

describe("formatSupervisionStatus — AT5: what it is waiting on", () => {
  test("renders the hold reason the tick recorded", () => {
    const text = formatSupervisionStatus(report({ waitingOn: "wip-limit" }));
    expect(text).toContain("waiting on: wip-limit");
  });

  test("renders the explicit status filter and WIP limit, not a defaulted one", () => {
    // SC5: a supervisor running at tasks_orchestrate's TODO-only default would
    // silently skip every already-planned child, so what it is ACTUALLY
    // filtering on has to be visible rather than assumed.
    const text = formatSupervisionStatus(report({ statusFilter: ["READY"], wipLimit: 2 }));
    expect(text).toContain("dispatchable statuses: READY");
    expect(text).toContain("WIP limit: 2");
  });
});

describe("formatSupervisionStatus — SC9: the stall is louder than silence", () => {
  test("a stalled supervision says so, and says the tick is alive", () => {
    // The distinction is the whole point: a dead tick is already covered by the
    // sweep meta-watchdog. This is the case it structurally cannot see.
    const text = formatSupervisionStatus(report({ stalled: true }));
    expect(text).toContain("STALLED");
    expect(text).toContain("the tick is alive but nothing has advanced");
    expect(text).toContain("8h");
  });

  test("a healthy supervision does not mention a stall at all", () => {
    expect(formatSupervisionStatus(report({ stalled: false }))).not.toContain("STALLED");
  });
});

describe("formatSupervisionStatus — SC10: a failed child is visible without a log", () => {
  test("renders settled dispatches with their outcome", () => {
    const text = formatSupervisionStatus(
      report({
        dispatches: [
          {
            taskId: "mt#4554",
            status: "failed",
            drivenSessionLocalId: "driven-7",
            minskySessionId: "ws-7",
            dispatchedAt: "2026-08-25T19:00:00.000Z",
          },
          {
            taskId: "mt#4556",
            status: "stranded",
            drivenSessionLocalId: "driven-8",
            minskySessionId: null,
            dispatchedAt: "2026-08-25T18:00:00.000Z",
          },
        ],
      })
    );

    expect(text).toContain("Settled (2)");
    expect(text).toContain("mt#4554  failed");
    expect(text).toContain("mt#4556  stranded");
  });

  test("omits the settled section when nothing has settled", () => {
    expect(formatSupervisionStatus(report())).not.toContain("Settled (");
  });
});
