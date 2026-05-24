#!/usr/bin/env bun
// PostToolUse hook on `mcp__minsky__session_pr_merge` and
// `mcp__minsky__tasks_status_set` (when result status = DONE): inject an
// `additionalContext` reminder that bridge memories tagged with the completing
// task's ID may exist, and prompt the agent to check redundancy and delete
// if derivative.
//
// Originating incident: 2026-05-23 mt#2056 closeout. Bridge memory `70ba7f79`
// had a budget criterion with no retirement mechanism — no actor, no trigger,
// nothing to execute the retirement. Three rounds of user pushing to reach the
// correct action (delete). The retrospective identified "half-measure
// defaulting under uncertainty" as the cognitive pattern; this hook is the
// structural fix that makes the retirement decision unavoidable at the right
// moment.
//
// The hook does NOT auto-search or auto-delete — the redundancy check requires
// comparing memory content against the task spec and PR body, which requires
// context the hook can't perform. The agent has that context; the hook's job
// is to ensure the agent is prompted to use it.
//
// Architecture: same shape as `.claude/hooks/drive-pr-to-convergence.ts`
// (PostToolUse, inject additionalContext on success, informational — never
// blocks). Uses `readInput()` and `writeOutput()` from `./types.ts`.
//
// Override env var: MINSKY_SKIP_BRIDGE_RETIREMENT — when set to 1/true/yes,
// suppress the context injection and audit-log to stdout.
//
// Cross-references:
// - Memory `76153081` — bridge memory retirement decision rule (behavioral
//   bridge until this hook shipped)
// - `.claude/hooks/drive-pr-to-convergence.ts` — architectural precedent
// - CLAUDE.md §Temporary mechanism budget — parent rule
// - mt#2056 — originating task
// - mt#2062 — this hook's tracking task
// @see mt#2062

import { readInput, writeOutput } from "./types";
import type { ToolHookInput, HookOutput } from "./types";

/** Override env var name (source of truth — used in tests and CLAUDE.md docs). */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_BRIDGE_RETIREMENT";

/** Tool names this hook reacts to. */
const TARGET_TOOLS = new Set(["mcp__minsky__session_pr_merge", "mcp__minsky__tasks_status_set"]);

/**
 * Extract the task ID from the tool input, depending on which tool fired.
 *
 * - `session_pr_merge`: uses `input.tool_input.task` or `input.tool_input.taskId`
 * - `tasks_status_set`: uses `input.tool_input.taskId`
 *
 * Returns null if the task ID cannot be determined.
 */
export function extractTaskId(input: ToolHookInput): string | null {
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== "object") return null;

  // Both tools accept taskId; session_pr_merge additionally accepts `task`
  const taskId =
    typeof toolInput["taskId"] === "string"
      ? toolInput["taskId"]
      : typeof toolInput["task"] === "string"
        ? toolInput["task"]
        : null;

  return taskId;
}

/**
 * Determine whether the tool result indicates a DONE status transition.
 *
 * For `session_pr_merge`: merge succeeds → task transitions to DONE atomically.
 * We fire whenever `success === true`.
 *
 * For `tasks_status_set`: fire only when the resulting status is "DONE".
 * Check `tool_result.status` or `tool_result.task.status` depending on the
 * response shape.
 */
export function isDoneTransition(input: ToolHookInput): boolean {
  const toolName = input.tool_name;
  const result = input.tool_result;

  if (!result || typeof result !== "object") return false;

  if (toolName === "mcp__minsky__session_pr_merge") {
    // Merge success = DONE transition (at-merge handler sets DONE atomically)
    return result["success"] === true;
  }

  if (toolName === "mcp__minsky__tasks_status_set") {
    // Must be successful AND the resulting status must be DONE
    if (result["success"] !== true) return false;
    // Response may carry the new status in different shapes
    const status =
      typeof result["status"] === "string"
        ? result["status"]
        : typeof result["task"] === "object" &&
            result["task"] !== null &&
            typeof (result["task"] as Record<string, unknown>)["status"] === "string"
          ? (result["task"] as Record<string, unknown>)["status"]
          : null;
    return status === "DONE";
  }

  return false;
}

/**
 * Build the additionalContext reminder for the agent.
 *
 * Named fields keep the message grounded in the specific task so the agent
 * doesn't need to infer the task ID from surrounding context.
 */
export function buildReminder(taskId: string): string {
  return [
    `Task ${taskId} has just transitioned to DONE.`,
    "",
    "**Bridge-memory retirement check (required):**",
    `Search for bridge memories associated with this task via:`,
    `  \`mcp__minsky__memory_search\` with query \`"${taskId}"\``,
    "",
    "Filter results for bridge-shaped memories — any memory whose:",
    "- tags include `bridge-memory`, OR",
    "- description/content contains `bridge` or `Tracking task`",
    "",
    "**Decision rule for each bridge candidate:**",
    "1. Compare the memory's content against the task spec and merged PR.",
    "2. If the memory's content is **redundant** with the spec + PR",
    "   (i.e., a reader can find the same information there) →",
    "   **delete via `mcp__minsky__memory_delete`**.",
    "3. If the memory contains **independent value** not captured in the",
    "   spec or PR (e.g., a process lesson, a re-usable rule, a cross-task",
    "   pattern) → **update via `mcp__minsky__memory_update`** to remove the",
    "   bridge framing (remove `bridge-memory` tag, rewrite the description",
    '   as a standing rule rather than a "until X ships" interim).',
    "",
    "Silent skip is acceptable only when `memory_search` returns zero bridge",
    "candidates. A non-empty candidate list always requires an explicit",
    'decision per rule (2) or (3) above — not a deferred "I\'ll check later".',
  ].join("\n");
}

/**
 * Main decision function. Returns the context string to inject, or null if
 * the hook should be silent (non-matching tool, failed result, not a DONE
 * transition, override env var set).
 *
 * Exported for testability.
 */
export function decide(input: ToolHookInput): string | null {
  // Non-matching tool: silent.
  if (!TARGET_TOOLS.has(input.tool_name)) return null;

  // Override env var: suppress with audit log.
  const override = process.env[OVERRIDE_ENV_VAR];
  if (override === "1" || override === "true" || override === "yes") {
    process.stdout.write(
      `[bridge-memory-retirement] override active (${OVERRIDE_ENV_VAR}=${override}) — skipping reminder\n`
    );
    return null;
  }

  // Not a DONE transition: silent.
  if (!isDoneTransition(input)) return null;

  // Extract task ID for the reminder.
  const taskId = extractTaskId(input);
  if (!taskId) return null;

  return buildReminder(taskId);
}

/**
 * Main entrypoint. Reads ToolHookInput from stdin; emits HookOutput JSON to
 * stdout when the hook should fire. Always exits 0 — the hook is informational
 * and must never block the tool call's success surfacing.
 */
async function main(): Promise<void> {
  let input: ToolHookInput;
  try {
    input = await readInput<ToolHookInput>();
  } catch {
    // Malformed stdin — exit silently. Never block.
    process.exit(0);
  }

  const reminder = decide(input);
  if (reminder === null) {
    process.exit(0);
  }

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: reminder,
    },
  };
  writeOutput(output);
  process.exit(0);
}

if (import.meta.main) {
  main();
}
