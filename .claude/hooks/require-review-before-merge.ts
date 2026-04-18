#!/usr/bin/env bun
// PreToolUse hook: block session_pr_merge if no review exists on the PR
// or if the review lacks a spec verification section.
// Ensures code review AND spec verification are complete before merging.

import { readInput, writeOutput, execSync } from "./types";
import type { ToolHookInput } from "./types";

const input = await readInput<ToolHookInput>();

const task = (input.tool_input.task as string | undefined) ?? "";
if (!task) process.exit(0);

const branch = `task/${task.replace("#", "-")}`;

// Get PR number for this branch
const prResult = execSync([
  "gh",
  "pr",
  "list",
  "--repo",
  "edobry/minsky",
  "--head",
  branch,
  "--json",
  "number",
  "--jq",
  ".[0].number",
]);
const pr = prResult.stdout.trim();
if (!pr) process.exit(0);

// Check that at least one review exists
const reviewsResult = execSync([
  "gh",
  "api",
  `repos/edobry/minsky/pulls/${pr}/reviews`,
  "--jq",
  "length",
]);
const reviews = reviewsResult.stdout.trim();
if (reviews === "0" || !reviews) {
  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `No review on PR #${pr}. Use /review-pr to submit a review before merging.`,
    },
  });
  process.exit(0);
}

// Check that at least one review contains spec verification
const hasSpecResult = execSync([
  "gh",
  "api",
  `repos/edobry/minsky/pulls/${pr}/reviews`,
  "--jq",
  '[.[].body] | any(test("Spec verification|spec verification|SPEC VERIFICATION"))',
]);
const hasSpec = hasSpecResult.stdout.trim();
if (hasSpec !== "true") {
  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Review on PR #${pr} lacks spec verification section. Use /review-pr to post a review that includes spec verification before merging.`,
    },
  });
  process.exit(0);
}
