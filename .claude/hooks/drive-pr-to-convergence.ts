#!/usr/bin/env bun
// PostToolUse hook on `mcp__minsky__session_pr_create`: when PR creation
// succeeds, inject an `additionalContext` reminder that the agent's required
// next action is to drive the PR to convergence (via `session_pr_wait-for-review`
// with `minsky-reviewer[bot]` as the review surface) — NOT to end the turn
// with deferral language like "ping me when done" / "let me know when ready."
//
// Originating incidents:
//   - 2026-05-12 PR #1076 (mt#1791): agent ended turn with "ping me to wire
//     the SDK once merged and you've set the key." User had to poke.
//   - 2026-04-22 PR #677 (mt#1057): agent created PR and ended turn without
//     driving to convergence; required user-initiated correction.
//   - 2026-05-26 PRs #1298, #1304, #1313: agent proactively dispatched
//     Chinese-wall reviewer subagents instead of waiting for the bot.
//     Retrospective: the old hook text instructed "/review-pr" as fallback.
//
// This hook is the structural escalation of two adjacent corpus rules:
//   - `decision-defaults.mdc §User does not review PRs in the loop`
//   - The "Slow-ask variant" under that section (added 2026-05-12 R4)
//
// The hook is INFORMATIONAL — it injects guidance, does NOT block any
// tool call. Failure paths and non-matching tools exit silently.
//
// @see mt#1793 — original task
// @see mt#2122 — updated to remove /review-pr fallback (2026-05-26)
// @see decision-defaults.mdc §User does not review PRs in the loop
// @see feedback_drive_pr_to_convergence_dont_end_on_ping_me — bridge memory
// @see memory 5695cd2b — never dispatch reviewer subagents in convergence loop

import { readInput } from "./types";
import type { ToolHookInput, HookOutput } from "./types";

/**
 * The reminder injected into the agent's next context after `session_pr_create`
 * succeeds. The text encodes the discipline at three levels:
 *
 *   1. Required next action (positive): `session_pr_wait-for-review` with
 *      `minsky-reviewer[bot]`. On webhook-miss: empty commit wake, re-wait,
 *      then bypass merge.
 *   2. Forbidden behavior (negative): deferral language as turn-closing,
 *      and dispatching reviewer subagents.
 *   3. Reference to the corpus rules so the agent can re-read them on the
 *      next turn if context budget allows.
 */
export const DRIVE_TO_CONVERGENCE_REMINDER = [
  "PR created successfully. Drive it to convergence per the §User-does-not-review-PRs",
  "rule in `decision-defaults.mdc` — the user is NOT the next actor.",
  "",
  "**Required next action (do not end the turn here):**",
  "- Call `mcp__minsky__session_pr_wait-for-review` with `reviewer: 'minsky-reviewer[bot]'`",
  "  to block until the reviewer bot posts (typical 30s–2min after push).",
  "- On webhook-miss (>5min silent): push an empty commit to wake the webhook",
  "  (`session_commit` with `noFiles: true, noStage: true`), then re-wait.",
  "  If still silent after the second wait, proceed to bypass merge.",
  "- On APPROVE: call `mcp__minsky__session_pr_merge`.",
  "- On CHANGES_REQUESTED: apply fixes per §7 Convergence Checklist (class-",
  "  not-instance + cascade-defense), push, re-wait.",
  "",
  "**Do NOT dispatch a reviewer subagent or invoke /review-pr.**",
  "The reviewer bot (`minsky-reviewer[bot]`) is the only review surface.",
  "See memory `5695cd2b` for the full rationale.",
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
