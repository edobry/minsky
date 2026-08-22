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
// The decision — which tool this rule is about, and that only a SUCCESSFUL
// creation warrants the reminder — lives in
// `packages/domain/src/detectors/pr-convergence-reminder.ts` (mt#4374's first
// extraction wave). This file is the thin binding: it owns the payload shape
// (absent `tool_result`, a non-object envelope, a truthy-but-not-`true`
// success field) and nothing else.
//
// @see mt#1793 — original task
// @see mt#2122 — updated to remove /review-pr fallback (2026-05-26)
// @see mt#4374 — the extraction wave that moved the decision out
// @see decision-defaults.mdc §User does not review PRs in the loop
// @see feedback_drive_pr_to_convergence_dont_end_on_ping_me — bridge memory
// @see memory 5695cd2b — never dispatch reviewer subagents in convergence loop

import { readInput } from "./types";
import type { ToolHookInput, HookOutput } from "./types";
import { decidePrConvergenceReminder } from "@minsky/domain/detectors/pr-convergence-reminder";

/**
 * Parse a hook payload into the decision's inputs, then relay the verdict.
 *
 * This is the BINDING, not the decision: every branch below is about the shape
 * of the result envelope. `success` is compared with `=== true` rather than for
 * truthiness so a malformed envelope carrying a truthy non-boolean does not
 * read as a successful creation.
 *
 * Exported so `types.test.ts` can assert the `normalizeToolResult` →
 * parse → decide chain end-to-end, which is the parsing seam it has always
 * exercised through this module.
 */
export function decideReminderFromPayload(input: ToolHookInput): string | null {
  const result = input.tool_result;
  const succeeded =
    !!result &&
    typeof result === "object" &&
    (result as Record<string, unknown>)["success"] === true;

  return decidePrConvergenceReminder({ toolName: input.tool_name, succeeded });
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

  const reminder = decideReminderFromPayload(input);
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
