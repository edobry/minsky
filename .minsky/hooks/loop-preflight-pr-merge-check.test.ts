import { describe, expect, it } from "bun:test";

import {
  extractPrNumbers,
  extractTaskIds,
  checkPrState,
  checkTaskState,
  runLoopPreflightCheck,
  formatBlockMessage,
  TERMINAL_TASK_STATUSES,
  type TaskCheckOutcome,
} from "./loop-preflight-pr-merge-check";

// ---------------------------------------------------------------------------
// extractPrNumbers
// ---------------------------------------------------------------------------

describe("extractPrNumbers", () => {
  it("extracts PR with hash prefix (PR #NNN)", () => {
    expect(extractPrNumbers("See PR #922")).toEqual([922]);
  });

  it("extracts multiple PR-cued numbers in one phrase (PR #1002 R1#2: only PR-cued counts)", () => {
    // Only "PR #920" matches the PR cue; bare "#921" and "#922" are
    // intentionally NOT extracted (they could be issue refs).
    expect(extractPrNumbers("drive PR #920 #921 #922 to convergence")).toEqual([920]);
  });

  it("extracts PR NNN (bare number after PR word)", () => {
    expect(extractPrNumbers("drive PR 922 to convergence")).toEqual([922]);
  });

  it("extracts from GitHub URL pull/NNN path", () => {
    expect(extractPrNumbers("see https://github.com/org/repo/pull/922")).toEqual([922]);
  });

  it("extracts from GitHub URL pulls/NNN path", () => {
    expect(extractPrNumbers("see /pulls/922")).toEqual([922]);
  });

  it("does NOT extract task IDs like mt#922 as PR numbers", () => {
    expect(extractPrNumbers("mt#922 task")).toEqual([]);
  });

  it("does NOT extract md#922 as a PR number", () => {
    expect(extractPrNumbers("md#409 task")).toEqual([]);
  });

  it("does NOT extract bare hash refs without PR cue (PR #1002 R1#2)", () => {
    // "investigate #922" likely refers to an issue, not a PR. Hook must
    // not over-match — only explicit `PR <num>`, `PR #<num>`, or
    // `pull(s)?/<num>` count.
    expect(extractPrNumbers("investigate #922")).toEqual([]);
    expect(extractPrNumbers("close #100")).toEqual([]);
    expect(extractPrNumbers("see #922 and #921")).toEqual([]);
  });

  it("deduplicates repeated PR-cued numbers", () => {
    expect(extractPrNumbers("PR #922 and also PR #922")).toEqual([922]);
  });

  it("returns empty array when no PRs found", () => {
    expect(extractPrNumbers("check the deploy on staging")).toEqual([]);
  });

  it("handles mixed PR and task references without confusion", () => {
    const result = extractPrNumbers("drive PR #920 and mt#1497 to completion");
    expect(result).toEqual([920]);
    expect(result).not.toContain(1497);
  });
});

// ---------------------------------------------------------------------------
// extractTaskIds
// ---------------------------------------------------------------------------

describe("extractTaskIds", () => {
  it("extracts mt# task IDs", () => {
    expect(extractTaskIds("drive mt#1497 to completion")).toEqual(["mt#1497"]);
  });

  it("extracts md# task IDs", () => {
    expect(extractTaskIds("drive md#409 to completion")).toEqual(["md#409"]);
  });

  it("extracts multiple task IDs", () => {
    const result = extractTaskIds("mt#1497 and md#409");
    expect(result).toContain("mt#1497");
    expect(result).toContain("md#409");
    expect(result).toHaveLength(2);
  });

  it("deduplicates repeated task IDs", () => {
    expect(extractTaskIds("mt#1497 and mt#1497")).toEqual(["mt#1497"]);
  });

  it("normalizes prefix to lowercase", () => {
    // If somehow MT#1497 appears (mixed case), normalize it
    expect(extractTaskIds("MT#1497")).toEqual(["mt#1497"]);
  });

  it("returns empty array when no task IDs found", () => {
    expect(extractTaskIds("check the deploy on staging")).toEqual([]);
  });

  it("handles mixed PR and task references without double-extraction", () => {
    const result = extractTaskIds("drive PR #920 and mt#1497 to completion");
    expect(result).toEqual(["mt#1497"]);
    expect(result).not.toContain("920");
  });
});

// ---------------------------------------------------------------------------
// TERMINAL_TASK_STATUSES
// ---------------------------------------------------------------------------

describe("TERMINAL_TASK_STATUSES", () => {
  it("includes DONE", () => {
    expect(TERMINAL_TASK_STATUSES.has("DONE")).toBe(true);
  });

  it("includes CLOSED", () => {
    expect(TERMINAL_TASK_STATUSES.has("CLOSED")).toBe(true);
  });

  it("does not include IN-PROGRESS", () => {
    expect(TERMINAL_TASK_STATUSES.has("IN-PROGRESS")).toBe(false);
  });

  it("does not include TODO", () => {
    expect(TERMINAL_TASK_STATUSES.has("TODO")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runLoopPreflightCheck (with injectable deps)
// ---------------------------------------------------------------------------

// Helper: make a checkPr dep that returns terminal for specific PR numbers
function makeTerminalPrDep(terminalPrNumbers: number[]): typeof checkPrState {
  return (_repoDir, prNumber, _warnings, _timeoutMs) => {
    if (terminalPrNumbers.includes(prNumber)) {
      return {
        kind: "terminal",
        result: { prNumber, state: "closed", merged: true, title: `PR #${prNumber} title` },
      };
    }
    return {
      kind: "active",
      result: { prNumber, state: "open", merged: false, title: `PR #${prNumber} title` },
    };
  };
}

// Helper: make a checkTask dep that returns terminal for specific task IDs
function makeTerminalTaskDep(terminalTaskIds: string[]): typeof checkTaskState {
  return (taskId, warnings, _timeoutMs) => {
    if (terminalTaskIds.includes(taskId)) {
      return { kind: "terminal", result: { taskId, status: "DONE" } };
    }
    return { kind: "active", result: { taskId, status: "TODO" } };
  };
}

// Helper: make a checkPr dep that errors for specific PR numbers
function makeErrorPrDep(errorPrNumbers: number[]): typeof checkPrState {
  return (_repoDir, prNumber, warnings, _timeoutMs) => {
    if (errorPrNumbers.includes(prNumber)) {
      const warning = `Could not check PR #${prNumber}: gh exited 404: Not Found`;
      warnings.push(warning);
      return { kind: "error", prNumber, warning };
    }
    return {
      kind: "active",
      result: { prNumber, state: "open", merged: false, title: `PR #${prNumber} title` },
    };
  };
}

describe("runLoopPreflightCheck", () => {
  // Acceptance Test 1: PR #922 merged → block
  it("blocks when a referenced PR is merged (Test 1)", () => {
    const warnings: string[] = [];
    const result = runLoopPreflightCheck(
      [922],
      [],
      "edobry/minsky",
      warnings,
      5000,
      makeTerminalPrDep([922]),
      makeTerminalTaskDep([])
    );
    expect(result.blocked).toBe(true);
    expect(result.terminalPrs).toHaveLength(1);
    expect(result.terminalPrs[0]?.prNumber).toBe(922);
    expect(result.terminalPrs[0]?.merged).toBe(true);
  });

  // Acceptance Test 2: mt#1497 TODO → permit
  it("permits when a referenced task is active (Test 2)", () => {
    const warnings: string[] = [];
    const result = runLoopPreflightCheck(
      [],
      ["mt#1497"],
      "edobry/minsky",
      warnings,
      5000,
      makeTerminalPrDep([]),
      makeTerminalTaskDep([]) // mt#1497 is NOT in terminal list → active
    );
    expect(result.blocked).toBe(false);
    expect(result.terminalTasks).toHaveLength(0);
  });

  // Acceptance Test 3: Three merged PRs → block, all named
  it("blocks with all three named when three merged PRs referenced (Test 3)", () => {
    const warnings: string[] = [];
    const result = runLoopPreflightCheck(
      [920, 921, 922],
      [],
      "edobry/minsky",
      warnings,
      5000,
      makeTerminalPrDep([920, 921, 922]),
      makeTerminalTaskDep([])
    );
    expect(result.blocked).toBe(true);
    expect(result.terminalPrs).toHaveLength(3);
    const prNums = result.terminalPrs.map((p) => p.prNumber);
    expect(prNums).toContain(920);
    expect(prNums).toContain(921);
    expect(prNums).toContain(922);
  });

  // Acceptance Test 5: No PR/task references → permit
  it("permits when there are no PR/task references (Test 5)", () => {
    const warnings: string[] = [];
    const result = runLoopPreflightCheck(
      [], // no PR numbers extracted
      [], // no task IDs extracted
      "edobry/minsky",
      warnings,
      5000,
      makeTerminalPrDep([]),
      makeTerminalTaskDep([])
    );
    expect(result.blocked).toBe(false);
    expect(result.terminalPrs).toHaveLength(0);
    expect(result.terminalTasks).toHaveLength(0);
  });

  // Acceptance Test 6: PR 404 → log warning, permit
  it("logs warning and permits when PR lookup returns 404 (Test 6)", () => {
    const warnings: string[] = [];
    const result = runLoopPreflightCheck(
      [9999],
      [],
      "edobry/minsky",
      warnings,
      5000,
      makeErrorPrDep([9999]), // PR 9999 returns an error (404)
      makeTerminalTaskDep([])
    );
    expect(result.blocked).toBe(false);
    expect(result.terminalPrs).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/Could not check PR #9999/);
  });

  it("permits when task is DONE but also has active PRs — tasks block independently", () => {
    const warnings: string[] = [];
    const result = runLoopPreflightCheck(
      [100], // active PR
      ["mt#1497"], // DONE task
      "edobry/minsky",
      warnings,
      5000,
      makeTerminalPrDep([]), // PR 100 is active
      makeTerminalTaskDep(["mt#1497"]) // task mt#1497 is DONE
    );
    expect(result.blocked).toBe(true);
    expect(result.terminalTasks).toHaveLength(1);
    expect(result.terminalPrs).toHaveLength(0);
  });

  it("blocks when a task is CLOSED", () => {
    const warnings: string[] = [];
    const checkTask = (taskId: string, w: string[], _t: number): TaskCheckOutcome => ({
      kind: "terminal",
      result: { taskId, status: "CLOSED" },
    });
    const result = runLoopPreflightCheck(
      [],
      ["mt#1234"],
      "edobry/minsky",
      warnings,
      5000,
      makeTerminalPrDep([]),
      checkTask
    );
    expect(result.blocked).toBe(true);
    expect(result.terminalTasks[0]?.status).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// formatBlockMessage
// ---------------------------------------------------------------------------

describe("formatBlockMessage", () => {
  it("names merged PR in the block message", () => {
    const msg = formatBlockMessage(
      [{ prNumber: 922, title: "Fix severity monotonicity", state: "closed", merged: true }],
      []
    );
    expect(msg).toContain("PR #922");
    expect(msg).toContain("MERGED");
    expect(msg).toContain("Fix severity monotonicity");
  });

  it("names closed (non-merged) PR in the block message", () => {
    const msg = formatBlockMessage(
      [{ prNumber: 500, title: "Old PR", state: "closed", merged: false }],
      []
    );
    expect(msg).toContain("PR #500");
    expect(msg).toContain("CLOSED");
  });

  it("names DONE task in the block message", () => {
    const msg = formatBlockMessage([], [{ taskId: "mt#1497", status: "DONE" }]);
    expect(msg).toContain("mt#1497");
    expect(msg).toContain("DONE");
  });

  it("includes override instruction", () => {
    const msg = formatBlockMessage(
      [{ prNumber: 922, title: "test", state: "closed", merged: true }],
      []
    );
    expect(msg).toContain("MINSKY_FORCE_LOOP_TERMINAL=1");
  });

  it("names all three PRs when three are terminal (Test 3 message shape)", () => {
    const msg = formatBlockMessage(
      [
        { prNumber: 920, title: "PR 920", state: "closed", merged: true },
        { prNumber: 921, title: "PR 921", state: "closed", merged: true },
        { prNumber: 922, title: "PR 922", state: "closed", merged: true },
      ],
      []
    );
    expect(msg).toContain("PR #920");
    expect(msg).toContain("PR #921");
    expect(msg).toContain("PR #922");
  });
});

// ---------------------------------------------------------------------------
// Override (Test 4) — tested at the env-var level, not the runLoopPreflightCheck
// level since the override happens in the main entrypoint before check logic.
// We verify the env var name is correct in the message.
// ---------------------------------------------------------------------------

describe("override env var", () => {
  it("block message documents the MINSKY_FORCE_LOOP_TERMINAL=1 override", () => {
    const msg = formatBlockMessage(
      [{ prNumber: 922, title: "test PR", state: "closed", merged: true }],
      []
    );
    expect(msg).toContain("MINSKY_FORCE_LOOP_TERMINAL=1");
  });
});
