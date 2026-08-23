/**
 * The shared hand-off-status predicate (mt#4228).
 *
 * The behaviour under test is one distinction: a `tasks_status_set` that moves
 * a task FORWARD versus one that OPENS a hand-off. Both stop-at-handoff guards
 * read `tasks_status_set` as forward motion unconditionally, which made the
 * single call that most reliably marks a stop-at-handoff — setting a task to
 * PLANNING or READY and stopping — the call that silenced them.
 *
 * Every fail-open case is asserted explicitly. The failure this guards against
 * is a MISSED advisory; manufacturing fires out of unreadable input would be
 * strictly worse, because the calibration stream is the thing being protected.
 */
import { describe, test, expect } from "bun:test";
import {
  anyStatusSetIsForwardMotion,
  cliStatusSetIsForwardMotion,
  HANDOFF_STATUSES,
  statusSetIsForwardMotion,
} from "./handoff-status";

describe("statusSetIsForwardMotion", () => {
  test("a transition INTO a hand-off state is NOT forward motion", () => {
    expect(statusSetIsForwardMotion({ status: "PLANNING" })).toBe(false);
    expect(statusSetIsForwardMotion({ status: "READY" })).toBe(false);
  });

  test("every other status IS forward motion", () => {
    for (const status of ["TODO", "IN-PROGRESS", "IN-REVIEW", "DONE", "BLOCKED", "CLOSED"]) {
      expect(statusSetIsForwardMotion({ status })).toBe(true);
    }
  });

  test("the hand-off set is exactly PLANNING and READY", () => {
    // Pinned so widening it becomes a deliberate edit with a failing test,
    // not a silent behaviour change — every status added here silences the
    // guard on another transition.
    expect([...HANDOFF_STATUSES].sort()).toEqual(["PLANNING", "READY"]);
  });

  test("case and surrounding whitespace do not change the verdict", () => {
    expect(statusSetIsForwardMotion({ status: "planning" })).toBe(false);
    expect(statusSetIsForwardMotion({ status: "  Ready  " })).toBe(false);
  });

  test("FAILS OPEN on input it cannot read", () => {
    // Each of these keeps the pre-mt#4228 reading. A missed advisory is the
    // failure being fixed; a fabricated one is worse.
    expect(statusSetIsForwardMotion({})).toBe(true);
    expect(statusSetIsForwardMotion({ status: undefined })).toBe(true);
    expect(statusSetIsForwardMotion({ status: 3 })).toBe(true);
    expect(statusSetIsForwardMotion({ status: "" })).toBe(true);
    expect(statusSetIsForwardMotion({ status: "   " })).toBe(true);
    expect(statusSetIsForwardMotion({ status: "SOMETHING-NEW" })).toBe(true);
  });
});

describe("anyStatusSetIsForwardMotion", () => {
  test("ANY forward transition in the turn counts, even beside a hand-off one", () => {
    // A turn that opens one hand-off and advances a different task DID act.
    // Suppressing on the PLANNING call alone would silence a working turn.
    expect(anyStatusSetIsForwardMotion([{ status: "PLANNING" }, { status: "IN-PROGRESS" }])).toBe(
      true
    );
  });

  test("a turn whose ONLY transitions open hand-offs is not forward motion", () => {
    expect(anyStatusSetIsForwardMotion([{ status: "PLANNING" }, { status: "READY" }])).toBe(false);
  });

  test("no calls at all is not forward motion", () => {
    expect(anyStatusSetIsForwardMotion([])).toBe(false);
  });
});

describe("cliStatusSetIsForwardMotion", () => {
  test("the CLI transport gets the SAME verdict as MCP — positional and flag forms", () => {
    // mt#3730's lesson: enforcement keys on the capability across every
    // transport. Qualifying only MCP would rebuild that asymmetry one level in.
    expect(cliStatusSetIsForwardMotion("minsky tasks status set mt#1 READY")).toBe(false);
    expect(cliStatusSetIsForwardMotion("minsky tasks status set mt#1 --status PLANNING")).toBe(
      false
    );
    expect(cliStatusSetIsForwardMotion("bun src/cli.ts tasks status set mt#1 planning")).toBe(
      false
    );
  });

  test("a forward CLI transition still counts", () => {
    expect(cliStatusSetIsForwardMotion("minsky tasks status set mt#1 IN-PROGRESS")).toBe(true);
    expect(cliStatusSetIsForwardMotion("minsky tasks status set mt#1 DONE")).toBe(true);
  });

  test("FAILS OPEN on a status-set command naming no recognizable status", () => {
    expect(cliStatusSetIsForwardMotion("minsky tasks status set mt#1")).toBe(true);
  });
});
