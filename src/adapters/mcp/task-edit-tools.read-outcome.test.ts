/**
 * Tests for the spec-READ decision in `tasks_spec_patch` (mt#4108).
 *
 * Sibling of `task-edit-tools.collapse-guard.test.ts`, one phase earlier: that
 * one covers what happens to a merge RESULT, this one covers whether the read is
 * a basis for doing anything at all.
 */

import { describe, test, expect } from "bun:test";
import { decideSpecReadOutcome } from "./task-edit-tools";

const TASK_ID = "mt#4073";
const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

describe("decideSpecReadOutcome", () => {
  test("a failed read is reported as a failed read, not as a missing task", () => {
    // The originating defect: two false claims — the task existed and its spec
    // was populated — shown to a caller whose read had merely thrown.
    const outcome = decideSpecReadOutcome({
      taskId: TASK_ID,
      specExists: false,
      specReadError: new Error("write CONNECTION_ENDED"),
      hasMarkers: true,
      describeError,
    });

    expect(outcome.kind).toBe("read-failed");
    if (outcome.kind !== "read-failed") throw new Error("unreachable");
    expect(outcome.message).toContain("reading its current spec FAILED");
    expect(outcome.message).toContain("NOT a claim that the task is missing");
    expect(outcome.message).toContain("write CONNECTION_ENDED");
    // The claim the old message made, and the reason it was harmful.
    expect(outcome.message).not.toContain("task doesn't exist");
  });

  test("a failed read aborts even with NO markers, so the spec cannot be overwritten", () => {
    // The worse half. With a failed read and marker-less content, `specExists`
    // is false, so mt#2400's fail-closed guard (which fires on `specExists &&
    // !hasMarkers`) does not fire and the handler would reach the brand-new-spec
    // direct write — replacing a populated spec with the payload. mt#3674's
    // collapse guard cannot catch it either: `originalContent` is "" after a
    // failed read, so there is no shrink to detect.
    const outcome = decideSpecReadOutcome({
      taskId: TASK_ID,
      specExists: false,
      specReadError: new Error("pool timeout"),
      hasMarkers: false,
      describeError,
    });

    expect(outcome.kind).toBe("read-failed");
  });

  test("a genuinely absent spec still reports the absent-spec error", () => {
    // The pre-existing behaviour, unchanged — this fix narrows what that message
    // is allowed to mean, it does not retire the message.
    const outcome = decideSpecReadOutcome({
      taskId: TASK_ID,
      specExists: false,
      specReadError: null,
      hasMarkers: true,
      describeError,
    });

    expect(outcome.kind).toBe("absent-with-markers");
    if (outcome.kind !== "absent-with-markers") throw new Error("unreachable");
    expect(outcome.message).toContain("task spec is empty or task doesn't exist");
  });

  test("a clean read of an existing spec proceeds", () => {
    expect(
      decideSpecReadOutcome({
        taskId: TASK_ID,
        specExists: true,
        specReadError: null,
        hasMarkers: true,
        describeError,
      })
    ).toEqual({ kind: "proceed" });
  });

  test("a clean read with no spec and no markers proceeds to the brand-new-spec path", () => {
    // Creating a spec that does not exist yet is legitimate; only a read FAILURE
    // makes that path unsafe.
    expect(
      decideSpecReadOutcome({
        taskId: TASK_ID,
        specExists: false,
        specReadError: null,
        hasMarkers: false,
        describeError,
      })
    ).toEqual({ kind: "proceed" });
  });
});
