/**
 * Tests for the bulk process-kill guard (mt#4081).
 *
 * The load-bearing properties are the trigger's narrowness and the deny's precision. This guard
 * sits on `kill`, a verb the agent uses legitimately all the time, so the no-fire cases carry
 * more weight than the deny case: a guard that fired on a single-PID kill or a `kill -0`
 * liveness probe would be turned off within a day.
 *
 * The decision is pure over the command string — no process table, no patching (`testing-
 * standards.mdc` §Testable Design).
 */

import { describe, expect, test } from "bun:test";

import {
  BULK_PID_THRESHOLD,
  buildDenialReason,
  findBulkKill,
  OVERRIDE_ENV,
  run,
} from "./block-bulk-process-kill";
import type { DispatchContext } from "./registry";
import type { ToolHookInput } from "./types";

/** The command from the originating incident, trimmed to its shape. */
const INCIDENT_COMMAND = "kill 544 654 818 88112 966 1106 1194 1282";

const ctx = {} as DispatchContext;

function input(command: string): ToolHookInput {
  return {
    tool_name: "Bash",
    tool_input: { command },
    session_id: "s1",
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
  } as ToolHookInput;
}

describe("findBulkKill", () => {
  test("fires on the originating incident's command", () => {
    const found = findBulkKill(INCIDENT_COMMAND);
    expect(found?.verb).toBe("kill");
    expect(found?.pids.length).toBe(8);
  });

  test("fires at exactly the threshold, not below it", () => {
    expect(findBulkKill("kill 111 222")).toBeNull();
    expect(findBulkKill("kill 111 222 333")?.pids.length).toBe(BULK_PID_THRESHOLD);
  });

  test("does not fire on a single-PID kill, with or without a signal", () => {
    expect(findBulkKill("kill 111")).toBeNull();
    expect(findBulkKill("kill -9 111")).toBeNull();
    expect(findBulkKill("kill -TERM 111")).toBeNull();
  });

  test("does not fire on a liveness probe, however many PIDs", () => {
    expect(findBulkKill("kill -0 111 222 333 444")).toBeNull();
    expect(findBulkKill("kill -s 0 111 222 333 444")).toBeNull();
  });

  test("counts PIDs after a signal flag", () => {
    expect(findBulkKill("kill -9 111 222 333")?.pids.length).toBe(3);
    expect(findBulkKill("kill -s TERM 111 222 333")?.pids.length).toBe(3);
  });

  test("fires on pkill/killall against an interactive class", () => {
    expect(findBulkKill("killall claude")?.target).toBe("claude");
    expect(findBulkKill("pkill -f node")?.target).toBe("node");
    expect(findBulkKill("killall /usr/bin/zsh")?.target).toBe("zsh");
  });

  test("does not fire on pkill/killall against an ordinary process", () => {
    expect(findBulkKill("killall my-test-runner")).toBeNull();
    expect(findBulkKill("pkill -f webpack-dev-server")).toBeNull();
  });

  test("finds a kill in a later segment of a chained command", () => {
    expect(findBulkKill("echo done && kill 111 222 333")?.pids.length).toBe(3);
  });

  test("a quoted semicolon cannot manufacture a match", () => {
    expect(findBulkKill("echo 'kill 111 222 333'")).toBeNull();
  });

  test("does not fire on a PID list it cannot see", () => {
    // Recall-only degradation, documented in the guard's own header.
    expect(findBulkKill("kill $(pgrep -f claude)")).toBeNull();
  });
});

describe("run", () => {
  test("denies the incident command and names the override", () => {
    const outcome = run(input(INCIDENT_COMMAND), ctx);
    expect(outcome?.deny).toBeDefined();
    expect(outcome?.deny?.reason).toContain(OVERRIDE_ENV);
    expect(outcome?.calibration?.["outcome"]).toBe("matched");
  });

  test("the denial names the move-vs-recreate alternative", () => {
    const reason = buildDenialReason({ verb: "kill", pids: [1, 2, 3], target: null });
    expect(reason.toLowerCase()).toContain("move");
    expect(reason.toLowerCase()).toContain("capability");
  });

  test("returns null for a command it does not govern", () => {
    expect(run(input("kill 111"), ctx)).toBeNull();
    expect(run(input("ls -la"), ctx)).toBeNull();
  });

  test("records the override instead of going silent", () => {
    const prior = process.env[OVERRIDE_ENV];
    process.env[OVERRIDE_ENV] = "1";
    try {
      const outcome = run(input(INCIDENT_COMMAND), ctx);
      expect(outcome?.deny).toBeUndefined();
      expect(outcome?.calibration?.["outcome"]).toBe("overridden");
    } finally {
      if (prior === undefined) delete process.env[OVERRIDE_ENV];
      else process.env[OVERRIDE_ENV] = prior;
    }
  });

  test("carries a bounded diversity phrase, not the raw command", () => {
    const outcome = run(input("killall claude"), ctx);
    expect(outcome?.calibration?.["phrase"]).toBe("killall claude");
  });
});
