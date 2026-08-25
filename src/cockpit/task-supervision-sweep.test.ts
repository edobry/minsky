/**
 * Tests for the supervisor's production wiring (mt#4571).
 *
 * Two things are worth pinning here, and they are the two the tick's own tests
 * cannot reach because the tick takes them as injected values:
 *
 *  1. `livenessFromRecord` — the mapping from `DrivenSessionStatus` onto the
 *     liveness the tick reasons about. The first version of this function was
 *     written against a GUESSED status vocabulary (it checked for an `"error"`
 *     status that does not exist and never checked `"unrecoverable"`, which
 *     does); the compiler caught it. A test that names all five real statuses
 *     is what stops the next edit from re-guessing, since four of them map to
 *     three different outcomes and only one is obvious.
 *  2. `buildSupervisedChildInstructions` — a supervised child is told nobody is
 *     reading its chat. If that sentence is ever dropped, the child politely
 *     asks a question and waits forever, and every symptom looks like a stall
 *     rather than a missing instruction.
 */
import { describe, test, expect } from "bun:test";
import { buildSupervisedChildInstructions, livenessFromRecord } from "./task-supervision-sweep";
import type { DrivenSessionRecord, DrivenSessionStatus } from "./driven-session-host";

function recordWithStatus(status: DrivenSessionStatus): DrivenSessionRecord {
  // Only `status` is read by livenessFromRecord; the cast keeps the fixture to
  // the one field under test rather than fabricating a whole record.
  return { status } as DrivenSessionRecord;
}

describe("livenessFromRecord", () => {
  test("a running or freshly-spawned child is live", () => {
    expect(livenessFromRecord(recordWithStatus("running"))).toBe("live");
    expect(livenessFromRecord(recordWithStatus("spawned"))).toBe("live");
  });

  test("a clean exit is `exited`, which the tick reads as possibly stranded", () => {
    // `exitStatus` resolves "exited" only for code 0 or an explicit stop, so
    // this genuinely is the clean case — and a clean exit with the task still
    // open is the stranded-child signal, not a failure.
    expect(livenessFromRecord(recordWithStatus("exited"))).toBe("exited");
  });

  test("both failure statuses map to crashed, including `unrecoverable`", () => {
    // `unrecoverable` is the one the original version missed: it is terminal
    // (isTerminalStatus includes it) and it carries an unrecoverableReason such
    // as a workspace that no longer exists. Reading it as a clean exit would
    // file a real failure as a stranded child.
    expect(livenessFromRecord(recordWithStatus("crashed"))).toBe("crashed");
    expect(livenessFromRecord(recordWithStatus("unrecoverable"))).toBe("crashed");
  });

  test("`reconnecting` is unknown, so the dispatch keeps its slot", () => {
    // The session driver died and mt#3038 deliberately does not respawn it
    // eagerly. The conversation is still resumable, so settling it would
    // discard recoverable work and free a slot for a duplicate child.
    expect(livenessFromRecord(recordWithStatus("reconnecting"))).toBe("unknown");
  });

  test("a session this process has no record of is unknown, never exited", () => {
    // A restarted daemon has no in-memory record of a child it started before
    // the restart. Reading that as an exit would strand every dispatch across
    // every restart, which is precisely what this feature exists to survive.
    expect(livenessFromRecord(undefined)).toBe("unknown");
  });
});

describe("buildSupervisedChildInstructions", () => {
  const instructions = buildSupervisedChildInstructions({
    taskId: "mt#4554",
    umbrellaTaskId: "mt#4553",
  });

  test("names the task and its umbrella", () => {
    expect(instructions).toContain("mt#4554");
    expect(instructions).toContain("mt#4553");
  });

  test("tells the child nobody is reading the conversation, and what to do instead", () => {
    expect(instructions).toContain("NOT reading this conversation");
    expect(instructions).toContain("asks_create");
  });

  test("states the supervisor's own bounds, so the child does not wait for it to act", () => {
    expect(instructions).toContain("will not merge for you");
  });
});
