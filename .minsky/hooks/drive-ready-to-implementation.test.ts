import { describe, test, expect } from "bun:test";
import {
  buildReadyChainWalkReminder,
  decideReminder,
  EXEMPT_KIND,
  isOverridden,
  OVERRIDE_ENV_VAR,
  resolveNewStatus,
  resolveTaskId,
  TARGET_TOOL_NAME,
} from "./drive-ready-to-implementation";
import type { ToolHookInput } from "./types";

const TASK_ID = "mt#3373";

/** Deps that never claim a task is state-ops. */
const IMPLEMENTATION_KIND = { readTaskKind: () => "implementation" };
/** Deps whose kind read is degraded (CLI failure) — the fail-open path. */
const UNREADABLE_KIND = { readTaskKind: () => null };

/** Build a minimal `ToolHookInput` for tests. */
function makeInput(overrides: Partial<ToolHookInput> = {}): ToolHookInput {
  return {
    session_id: "test-session",
    cwd: "/test",
    hook_event_name: "PostToolUse",
    tool_name: TARGET_TOOL_NAME,
    tool_input: { taskId: TASK_ID, status: "READY" },
    ...overrides,
  };
}

/** The real `tasks_status_set` success envelope for a PLANNING -> READY transition. */
function readyResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    taskId: TASK_ID,
    message: `Task ${TASK_ID} status changed from PLANNING to READY`,
    previousStatus: "PLANNING",
    newStatus: "READY",
    changed: true,
    status: "READY",
    result: { success: true, taskId: TASK_ID, status: "READY" },
    ...overrides,
  };
}

describe("drive-ready-to-implementation hook (mt#3373)", () => {
  describe("decideReminder — fires on the READY transition", () => {
    test("emits the reminder on a successful PLANNING -> READY transition", () => {
      const result = decideReminder(makeInput({ tool_result: readyResult() }), IMPLEMENTATION_KIND);
      expect(result).toBe(buildReadyChainWalkReminder(TASK_ID));
    });

    test("emits when the kind read is degraded (fails open toward firing)", () => {
      const result = decideReminder(makeInput({ tool_result: readyResult() }), UNREADABLE_KIND);
      expect(result).not.toBeNull();
    });

    test("emits when the result carries only the nested result.status shape", () => {
      const tool_result = {
        success: true,
        taskId: TASK_ID,
        changed: true,
        result: { status: "READY" },
      };
      expect(decideReminder(makeInput({ tool_result }), IMPLEMENTATION_KIND)).not.toBeNull();
    });

    test("names the task in the reminder so the next action is directly invocable", () => {
      const result = decideReminder(makeInput({ tool_result: readyResult() }), IMPLEMENTATION_KIND);
      expect(result).toContain(`/implement-task ${TASK_ID}`);
    });
  });

  describe("decideReminder — silent on every non-READY status", () => {
    // Acceptance test 1: only READY fires.
    const others = ["TODO", "PLANNING", "IN-PROGRESS", "IN-REVIEW", "DONE", "CLOSED", "BLOCKED"];
    for (const status of others) {
      test(`silent on a transition to ${status}`, () => {
        const tool_result = readyResult({ newStatus: status, status, result: { status } });
        expect(decideReminder(makeInput({ tool_result }), IMPLEMENTATION_KIND)).toBeNull();
      });
    }
  });

  describe("decideReminder — silent on no-op re-sets", () => {
    test("silent when changed is false", () => {
      const tool_result = readyResult({ changed: false, previousStatus: "READY" });
      expect(decideReminder(makeInput({ tool_result }), IMPLEMENTATION_KIND)).toBeNull();
    });

    test("silent when previousStatus was already READY even if changed is absent", () => {
      const tool_result = readyResult({ previousStatus: "READY" });
      delete tool_result["changed"];
      expect(decideReminder(makeInput({ tool_result }), IMPLEMENTATION_KIND)).toBeNull();
    });
  });

  describe("decideReminder — state-ops carve-out", () => {
    // Acceptance test 2: a state-ops task reaching READY emits nothing, because
    // /plan-task Step 4 walks that kind READY -> IN-PROGRESS in main-agent
    // context rather than via /implement-task.
    test("silent for a state-ops task reaching READY", () => {
      const deps = { readTaskKind: () => EXEMPT_KIND };
      expect(decideReminder(makeInput({ tool_result: readyResult() }), deps)).toBeNull();
    });

    test("reads the kind for the task the result names", () => {
      const seen: string[] = [];
      const deps = {
        readTaskKind: (id: string) => {
          seen.push(id);
          return "implementation";
        },
      };
      decideReminder(makeInput({ tool_result: readyResult() }), deps);
      expect(seen).toEqual([TASK_ID]);
    });

    test("does not attempt a kind read when no task id is resolvable", () => {
      let called = false;
      const deps = {
        readTaskKind: () => {
          called = true;
          return EXEMPT_KIND;
        },
      };
      const tool_result = { success: true, changed: true, newStatus: "READY" };
      const input = makeInput({ tool_input: {}, tool_result });
      expect(decideReminder(input, deps)).not.toBeNull();
      expect(called).toBe(false);
    });
  });

  describe("decideReminder — silent on malformed or non-matching input", () => {
    test("silent on a non-matching tool name", () => {
      const input = makeInput({
        tool_name: "mcp__minsky__session_commit",
        tool_result: readyResult(),
      });
      expect(decideReminder(input, IMPLEMENTATION_KIND)).toBeNull();
    });

    test("silent on session_pr_merge, which also transitions a task", () => {
      const input = makeInput({
        tool_name: "mcp__minsky__session_pr_merge",
        tool_result: readyResult(),
      });
      expect(decideReminder(input, IMPLEMENTATION_KIND)).toBeNull();
    });

    test("silent when tool_result is missing", () => {
      expect(decideReminder(makeInput({ tool_result: undefined }), IMPLEMENTATION_KIND)).toBeNull();
    });

    test("silent when the call failed", () => {
      const tool_result = { success: false, error: "invalid transition" };
      expect(decideReminder(makeInput({ tool_result }), IMPLEMENTATION_KIND)).toBeNull();
    });

    test("silent when success is truthy but not strictly true", () => {
      const tool_result = readyResult({ success: "true" });
      expect(decideReminder(makeInput({ tool_result }), IMPLEMENTATION_KIND)).toBeNull();
    });
  });

  describe("resolveNewStatus", () => {
    test("prefers newStatus over the sibling status fields", () => {
      expect(resolveNewStatus({ newStatus: "READY", status: "PLANNING" })).toBe("READY");
    });

    test("falls back through status, result.status, then task.status", () => {
      expect(resolveNewStatus({ status: "READY" })).toBe("READY");
      expect(resolveNewStatus({ result: { status: "READY" } })).toBe("READY");
      expect(resolveNewStatus({ task: { status: "READY" } })).toBe("READY");
    });

    test("returns null when no status field is present", () => {
      expect(resolveNewStatus({ success: true })).toBeNull();
    });
  });

  describe("resolveTaskId", () => {
    test("prefers the result's task id over the input's", () => {
      const input = makeInput({
        tool_input: { taskId: "mt#1" },
        tool_result: { taskId: "mt#2" },
      });
      expect(resolveTaskId(input)).toBe("mt#2");
    });

    test("falls back to the tool input when the result omits it", () => {
      const input = makeInput({ tool_input: { taskId: "mt#1" }, tool_result: { success: true } });
      expect(resolveTaskId(input)).toBe("mt#1");
    });

    test("returns null when neither carries a task id", () => {
      expect(resolveTaskId(makeInput({ tool_input: {}, tool_result: {} }))).toBeNull();
    });
  });

  describe("isOverridden", () => {
    test("recognizes the documented affirmative values", () => {
      for (const value of ["1", "true", "yes", "TRUE", " yes "]) {
        expect(isOverridden({ [OVERRIDE_ENV_VAR]: value })).toBe(true);
      }
    });

    test("is false when unset or set to a non-affirmative value", () => {
      expect(isOverridden({})).toBe(false);
      expect(isOverridden({ [OVERRIDE_ENV_VAR]: "0" })).toBe(false);
      expect(isOverridden({ [OVERRIDE_ENV_VAR]: "" })).toBe(false);
    });
  });

  describe("reminder content", () => {
    const reminder = buildReadyChainWalkReminder(TASK_ID);

    test("names the required next action explicitly", () => {
      expect(reminder).toContain(`/implement-task ${TASK_ID}`);
      expect(reminder).toContain("do not end the turn here");
    });

    test("cites the corpus rule for traceability", () => {
      expect(reminder).toContain("§Skill-chain semantics");
    });

    test("preserves the three documented legitimate halts", () => {
      expect(reminder).toContain("just plan it");
      expect(reminder).toContain("NEW blocking signal");
      expect(reminder).toContain("asks_create");
    });

    test("forbids the originating incident's turn-closer", () => {
      // The 2026-07-30 mt#3305 deferral, verbatim in shape.
      expect(reminder).toContain("Want me to go, or stop here?");
    });

    test("names the confabulated halt rationales as invalid", () => {
      expect(reminder).toContain("implementation is a separate skill");
      expect(reminder).toContain("review the gate report");
    });

    test("degrades to a task-agnostic instruction when the id is unknown", () => {
      const generic = buildReadyChainWalkReminder(null);
      expect(generic).toContain("/implement-task");
      expect(generic).not.toContain("null");
    });
  });
});
