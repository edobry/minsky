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
  findKillInvocation,
  findKillVerb,
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

describe("PR #2954 R1 — parse robustness", () => {
  test("a kill verb inside a quoted commit message is not a kill", () => {
    // The finding's own example (`echo skill 1 2 3`) never matched — verified against the
    // pre-fix regex — but this one did: quote characters are not segment separators.
    expect(findBulkKill("git commit -m 'fix: kill 111 222 333 retry loop'")).toBeNull();
    expect(findBulkKill("echo 'kill 111 222 333'")).toBeNull();
  });

  test("a substring of a longer word is not a kill verb", () => {
    expect(findBulkKill("echo skill 1 2 3")).toBeNull();
    expect(findBulkKill("bun run skill 111 222 333")).toBeNull();
  });

  test("a path-qualified kill is still a kill", () => {
    expect(findBulkKill("/bin/kill 111 222 333")?.pids.length).toBe(3);
    expect(findBulkKill("/usr/bin/killall claude")?.target).toBe("claude");
  });

  test("findKillVerb is the shared parse the detector imports", () => {
    expect(findKillVerb("kill 111")).toBe("kill");
    expect(findKillVerb("git commit -m 'kill the loop'")).toBeNull();
    expect(findKillVerb("echo done && killall node")).toBe("killall");
  });
});

describe("mt#4193 — a redirection is not a target", () => {
  /**
   * The under-deny direction. Each of these denies WITHOUT the redirect, and the redirect is
   * the only difference — so a pass here is the guard reading the same command the same way
   * however the operator wrote its output plumbing.
   */
  const REDIRECT_FORMS: ReadonlyArray<readonly [string, string]> = [
    ["attached, stderr", "pkill -f node 2>/dev/null"],
    ["attached, stdout", "pkill -f node >/dev/null"],
    ["separated, stdout", "pkill -f node > /dev/null"],
    ["separated, stderr", "pkill -f node 2> /dev/null"],
    ["append", "pkill -f node >> /tmp/log"],
    ["killall form", "killall node 2>/dev/null"],
  ];

  test.each(REDIRECT_FORMS)("denies an interactive-class kill: %s", (_label, command) => {
    expect(findBulkKill(command)?.target).toBe("node");
  });

  test("the baseline it is measured against still denies", () => {
    expect(findBulkKill("pkill -f node")?.target).toBe("node");
  });

  test("SC3: a redirect does not create a denial where none existed", () => {
    // `minsky-mcp` is not an interactive process class — a documented MISS, and the widening
    // must not turn it into a hit.
    expect(findBulkKill("pkill -f minsky-mcp")).toBeNull();
    expect(findBulkKill("pkill -f minsky-mcp 2>/dev/null")).toBeNull();
  });

  test("the bulk-PID path is unaffected in both directions", () => {
    expect(findBulkKill("kill 111 222 333 2>/dev/null")?.pids.length).toBe(3);
    expect(findBulkKill("kill 111 222 2>/dev/null")).toBeNull();
  });

  /**
   * The over-count direction (SC5) — the same defect reaching the other consumer. A redirect
   * PATH read as a target turns a one-process cleanup into a multi-target kill, which is what
   * `operator-deferral`'s act-path surface counts.
   */
  test.each([
    ["separated, stdout", "kill 4821 > /dev/null"],
    ["separated, stderr", "kill 4821 2> /dev/null"],
    ["attached", "kill 4821 >/dev/null 2>&1"],
    ["trailing 2>&1, split at the &", "kill 4821 2>&1"],
  ])("a single-PID kill names one target: %s", (_label, command) => {
    expect(findKillInvocation(command)?.targets).toEqual(["4821"]);
  });

  test("a genuine multi-target kill still counts them all", () => {
    expect(findKillInvocation("kill 4821 4822 > /dev/null")?.targets).toEqual(["4821", "4822"]);
  });

  test("SC2: `&>` is correct by a DIFFERENT mechanism, and is pinned here for that reason", () => {
    // `&` is a segment separator, so `&>` never reaches `stripRedirections` — the segment simply
    // ends before it. The outcome matches the other forms; the route does not. Without this test
    // a change to the segment split could break `&>` while every redirect test stayed green.
    expect(findBulkKill("pkill -f node &> /dev/null")?.target).toBe("node");
    expect(findBulkKill("killall node &>/dev/null")?.target).toBe("node");
    expect(findKillInvocation("kill 4821 &> /dev/null")?.targets).toEqual(["4821"]);
  });
});
