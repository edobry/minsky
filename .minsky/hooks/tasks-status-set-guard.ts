#!/usr/bin/env bun
// PreToolUse hook on mcp__minsky__tasks_status_set: validate transitions against the
// canonical state machine in src/domain/tasks/status-transitions.ts.
//
// Reads the current task status AND kind in a single `minsky tasks get --json`
// CLI call, then calls validateStatusTransition against the requested status.
// Denies the tool call if validation throws.
//
// Kind-aware dispatch (mt#1862): the validator's signature is
// `validateStatusTransition(from, to, kind?)` and dispatches on `kind` to select
// the per-kind workflow (implementation vs. umbrella; see workflows.ts, mt#1812).
// This hook reads `kind` from the same CLI surface as `status` (single call) and
// forwards it. When the read fails (timeout, malformed JSON, etc.), the kind
// argument is omitted and the validator falls back to "implementation" — the
// safer default.
//
// Origin: mt#1504. The domain layer at mutation-commands.ts:97-110 already validates, but
// (a) the `if (task.status)` short-circuit (now removed as a ride-along in this PR) silently
// skipped validation when status was falsy, and (b) backend-direct setTaskStatus calls
// (session-merge-operations, session-approve-operations, start-session-operations) bypass
// the domain wrapper entirely. This hook runs at the agent harness layer regardless of
// downstream code path, completing the lifecycle write surface guard ladder
// (status_set + session_start [mt#1362] + tasks_create [mt#1435]).

import { execWithPath, readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";
import { validateStatusTransition } from "../../packages/domain/src/tasks/status-transitions";
import { TaskStatus, isValidTaskStatus } from "../../packages/domain/src/tasks/taskConstants";

const TARGET_TOOL = "mcp__minsky__tasks_status_set";

export interface CheckResult {
  decision: "allow" | "deny";
  reason?: string;
}

export interface CurrentTaskFields {
  status: string | null;
  kind: string | null;
}

export interface CheckDeps {
  // Single read of the task's current status and kind. Returns null when the
  // read mechanism is degraded; checkTransition fails open in that case.
  readCurrentTask: (taskId: string) => CurrentTaskFields | null;
}

// Live read of the task's status and kind via `minsky tasks get <id> --json`.
// Returns null on any failure (non-zero exit, malformed JSON, missing `task`)
// so the hook fails open rather than blocking legitimate calls when the read
// mechanism is degraded — the domain-layer validation in mutation-commands.ts
// is the second line of defense.
export function readCurrentTaskViaCLI(taskId: string): CurrentTaskFields | null {
  const result = execWithPath(["minsky", "tasks", "get", taskId, "--json"], {
    timeout: 8000,
  });
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { task?: { status?: unknown; kind?: unknown } };
    if (!parsed.task) return null;
    return {
      status: typeof parsed.task.status === "string" ? parsed.task.status : null,
      kind: typeof parsed.task.kind === "string" ? parsed.task.kind : null,
    };
  } catch {
    return null;
  }
}

export function checkTransition(
  toolName: string,
  toolInput: Record<string, unknown>,
  deps: CheckDeps
): CheckResult {
  if (toolName !== TARGET_TOOL) return { decision: "allow" };

  const taskId = toolInput.taskId;
  const requested = toolInput.status;

  if (typeof taskId !== "string" || taskId.length === 0) return { decision: "allow" };
  if (typeof requested !== "string" || requested.length === 0) return { decision: "allow" };

  if (!isValidTaskStatus(requested)) {
    return {
      decision: "deny",
      reason:
        `Refused tasks_status_set on ${taskId}: requested status "${requested}" is not a valid TaskStatus. ` +
        `Valid: TODO, PLANNING, READY, IN-PROGRESS, IN-REVIEW, DONE, COMPLETED, BLOCKED, CLOSED.`,
    };
  }

  const taskFields = deps.readCurrentTask(taskId);
  if (taskFields === null) {
    // Could not read task — fail open. Domain layer will catch.
    return { decision: "allow" };
  }
  const current = taskFields.status;
  if (current === null || !isValidTaskStatus(current)) {
    // Current status missing or outside the canonical enum — fail open. Domain layer will catch.
    return { decision: "allow" };
  }

  // Forward kind so the validator can dispatch to the right per-kind workflow (mt#1812).
  // When kind is null (CLI returned a task without the field), we pass undefined and
  // the validator defaults to "implementation" — the safer/more restrictive default.
  const kind = taskFields.kind ?? undefined;

  try {
    validateStatusTransition(current as TaskStatus, requested as TaskStatus, kind);
    return { decision: "allow" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: "deny",
      reason:
        `Refused tasks_status_set on ${taskId}: ${message}\n\n` +
        `If the current status is wrong (e.g., stale local belief), read it first via ` +
        `mcp__minsky__tasks_status_get and reconcile before retrying.`,
    };
  }
}

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();
  const result = checkTransition(input.tool_name, input.tool_input ?? {}, {
    readCurrentTask: readCurrentTaskViaCLI,
  });
  if (result.decision === "deny") {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.reason ?? "",
      },
    });
  }
  process.exit(0);
}
