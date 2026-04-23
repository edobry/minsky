#!/usr/bin/env bun
// PostToolUse hook: after session_pr_create succeeds, inject a system-reminder
// requiring /review-pr invocation before turn end. Structural enforcement of
// feedback_review_pr_process.md rule: "Never ask user to review — use the skill,
// post to GitHub yourself."
//
// Fires only on successful mcp__minsky__session_pr_create calls. The reminder
// surfaces at the exact boundary where the rule failed in prior incidents (the
// pr_create → summary transition) and cannot be deprioritized in favor of
// task-completion pressure the way an ambient memory rule can.

import { readInput, writeOutput } from "./types";
import type { HookOutput, ToolHookInput } from "./types";

const input = await readInput<ToolHookInput>();

// Defensive: settings.json matcher already filters, but re-check in case of
// broad matchers in future.
if (input.tool_name !== "mcp__minsky__session_pr_create") process.exit(0);

const result = input.tool_result ?? {};

// Only fire on success. PostToolUse runs regardless of success/failure; we
// explicitly want to skip failure paths so the agent can retry without
// spurious review prompts.
if (!result.success) process.exit(0);

// Extract PR URL and number. tool_result shape from session_pr_create includes
// { success: true, url: "https://github.com/.../pull/N", ... }.
const url = typeof result.url === "string" ? result.url : "";
const prMatch = url.match(/\/pull\/(\d+)/);
const prNumber = prMatch ? prMatch[1] : null;

const prRef = prNumber ? `#${prNumber}` : "(number unavailable — check tool output)";
const reviewCmd = prNumber ? `/review-pr ${prNumber}` : "/review-pr <PR number>";
const urlSuffix = url ? ` at ${url}` : "";

const reminder = [
  `PR ${prRef} was just created${urlSuffix}.`,
  ``,
  `MANDATORY NEXT STEP: Invoke \`${reviewCmd}\` before ending this turn or writing any summary for the user. You MUST review your own PR and post the review to GitHub via MCP tools (session_pr_review_submit).`,
  ``,
  `Do NOT:`,
  `- Write a summary ending with "next step: review this PR" or equivalent`,
  `- Ask the user to review before you have reviewed`,
  `- Declare the task done without posting a review`,
  ``,
  `Per feedback_review_pr_process.md: "Never ask user to review — use the skill, post to GitHub yourself."`,
].join("\n");

const output: HookOutput = {
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: reminder,
  },
};

writeOutput(output);
