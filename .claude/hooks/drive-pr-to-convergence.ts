#!/usr/bin/env bun
// PostToolUse hook on `mcp__minsky__session_pr_create`: when PR creation
// succeeds, inject an `additionalContext` reminder that the agent's required
// next action is to drive the PR to convergence (via `session_pr_wait-for-review`
// or a Chinese-wall reviewer subagent on webhook-miss) — NOT to end the turn
// with deferral language like "ping me when done" / "let me know when ready."
//
// Originating incidents:
//   - 2026-05-12 PR #1076 (mt#1791): agent ended turn with "ping me to wire
//     the SDK once merged and you've set the key." User had to poke.
//   - 2026-04-22 PR #677 (mt#1057): agent created PR and ended turn without
//     invoking /review-pr; required user-initiated correction. Originated
//     mt#1066's `require-review-after-pr-create.ts` proposal (PR #684,
//     superseded by this hook).
//
// This hook is the structural escalation of two adjacent corpus rules:
//   - `decision-defaults.mdc §User does not review PRs in the loop` —
//     drives the rule that the agent (not the user) is responsible for
//     PR convergence
//   - The "Slow-ask variant" under that section (added 2026-05-12 R4) —
//     "ping me when done" / "let me know when ready" is the same anti-
//     pattern as "ready for your review", just deferred in time
//
// Both rules failed memory-tier and corpus-tier enforcement (the rules
// were loaded into context when the violating turns happened). Per the
// retrospective skill's escalation policy, the tier escalates to hook.
//
// The hook is INFORMATIONAL — it injects guidance, does NOT block any
// tool call. Failure paths and non-matching tools exit silently.
//
// Supersedes the abandoned mt#1066 / PR #684 (`require-review-after-pr-create.ts`)
// which addressed a narrower slice (/review-pr only). This hook's reminder
// covers both /review-pr-as-fallback and the broader drive-to-convergence
// discipline.
//
// @see mt#1793 — this task
// @see mt#1066 / PR #684 — superseded predecessor
// @see decision-defaults.mdc §User does not review PRs in the loop
// @see feedback_drive_pr_to_convergence_dont_end_on_ping_me — bridge memory

import { readInput } from "./types";
import type { ToolHookInput, HookOutput } from "./types";

/**
 * The reminder injected into the agent's next context after `session_pr_create`
 * succeeds. The text encodes the discipline at three levels:
 *
 *   1. Required next action (positive): `session_pr_wait-for-review` or
 *      reviewer subagent on webhook-miss.
 *   2. Forbidden behavior (negative): deferral language as turn-closing.
 *   3. Reference to the corpus rules so the agent can re-read them on the
 *      next turn if context budget allows.
 */
export const DRIVE_TO_CONVERGENCE_REMINDER = [
  "PR created successfully. Drive it to convergence per `decision-defaults.mdc",
  "§User does not review PRs in the loop` — the user is NOT the next actor.",
  "",
  "**Required next action (do not end the turn here):**",
  "- Call `mcp__minsky__session_pr_wait-for-review` to block until",
  "  `minsky-reviewer[bot]` posts (typical 30s–2min after push).",
  "- On webhook-miss (>5min silent): diagnose per `feedback_self_authored_pr_merge_constraints`",
  "  step 5; dispatch `/review-pr` for a Chinese-wall reviewer subagent if",
  "  the bot is unhealthy.",
  "- On APPROVE: call `mcp__minsky__session_pr_merge`.",
  "- On CHANGES_REQUESTED: apply fixes per §7 Convergence Checklist (class-",
  "  not-instance + cascade-defense), push, re-wait.",
  "",
  "**Forbidden — these phrases end the turn prematurely:**",
  '- "Ping me when done"',
  '- "Let me know when merged"',
  '- "I\'ll wait for your signal"',
  '- "Ready for your review/merge"',
  "- Any equivalent deferral that ends the turn before merge.",
  "",
  "The slow-ask variant (deferring to a later user ping) is forbidden under",
  "the same rule as the immediate-ask variant. Drive to merge first; surface",
  "only at merge or on a genuinely-blocking failure (CI failure, structural",
  "convergence failure documented in feedback_bot_authored_pr_convergence).",
].join("\n");

/** The MCP tool this hook reacts to. */
const TARGET_TOOL_NAME = "mcp__minsky__session_pr_create";

/**
 * Decide whether to emit the reminder. Returns null if the hook should be
 * silent (non-matching tool, failure result, malformed input).
 *
 * Exported for testability.
 */
export function decideReminder(input: ToolHookInput): string | null {
  // Non-matching tool: silent.
  if (input.tool_name !== TARGET_TOOL_NAME) {
    return null;
  }

  // No tool_result (the call didn't return): silent. The agent will get
  // the failure surface from the call itself.
  if (!input.tool_result || typeof input.tool_result !== "object") {
    return null;
  }

  // Failure path: silent. The agent gets the error from the call result.
  // The reminder applies only when the PR was successfully created and
  // the agent is at risk of ending the turn prematurely.
  const success = input.tool_result["success"];
  if (success !== true) {
    return null;
  }

  return DRIVE_TO_CONVERGENCE_REMINDER;
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

  const reminder = decideReminder(input);
  if (reminder === null) {
    process.exit(0);
  }

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: reminder,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

if (import.meta.main) {
  main();
}
