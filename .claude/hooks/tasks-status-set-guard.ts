#!/usr/bin/env bun
// PreToolUse hook on mcp__minsky__tasks_status_set: validate transitions against the
// canonical state machine in src/domain/tasks/status-transitions.ts.
//
// Reads the current task status (via the minsky CLI), then calls validateStatusTransition
// against the requested status. Denies the tool call if validation throws.
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
import { validateStatusTransition } from "../../src/domain/tasks/status-transitions";
import { TaskStatus, isValidTaskStatus } from "../../src/domain/tasks/taskConstants";

const TARGET_TOOL = "mcp__minsky__tasks_status_set";

export interface CheckResult {
  decision: "allow" | "deny";
  reason?: string;
}

export interface CheckDeps {
  readCurrentStatus: (taskId: string) => string | null;
}

// Live read via the minsky CLI. Returns null on any failure so the hook fails open
// rather than blocking legitimate calls when the read mechanism is degraded — the
// domain-layer validation in mutation-commands.ts is the second line of defense.
export function readCurrentStatusViaCLI(taskId: string): string | null {
  const result = execWithPath(["minsky", "tasks", "status", "get", taskId, "--json"], {
    timeout: 8000,
  });
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : null;
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
        `Valid: TODO, PLANNING, READY, IN-PROGRESS, IN-REVIEW, DONE, BLOCKED, CLOSED.`,
    };
  }

  const current = deps.readCurrentStatus(taskId);
  if (current === null) {
    // Could not read current status — fail open. Domain layer will catch.
    return { decision: "allow" };
  }
  if (!isValidTaskStatus(current)) {
    // Current status outside the canonical enum — fail open. Domain layer will catch.
    return { decision: "allow" };
  }

  try {
    validateStatusTransition(current as TaskStatus, requested as TaskStatus);
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
    readCurrentStatus: readCurrentStatusViaCLI,
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
