#!/usr/bin/env bun
// PreToolUse hook: block session_pr_merge if no review exists on the PR,
// the review lacks a spec verification or documentation impact section,
// or the review is stale (covers an older commit than PR HEAD).
// Ensures code review, spec verification, documentation impact assessment,
// AND review freshness before merging.

import { readInput, writeOutput, execSync } from "./types";
import type { ToolHookInput } from "./types";

const input = await readInput<ToolHookInput>();

const task = (input.tool_input.task as string | undefined) ?? "";
if (!task) process.exit(0);

const branch = `task/${task.replace("#", "-")}`;

// Get PR number and head SHA for this branch
const prResult = execSync([
  "gh",
  "pr",
  "list",
  "--repo",
  "edobry/minsky",
  "--head",
  branch,
  "--json",
  "number,headRefOid",
  "--jq",
  ".[0] | [.number, .headRefOid] | @tsv",
]);
const prParts = prResult.stdout.trim().split("\t");
const pr = prParts[0];
const headSha = prParts[1];
if (!pr) process.exit(0);

// Get all reviews
const reviewsJson = execSync(["gh", "api", `repos/edobry/minsky/pulls/${pr}/reviews`]);
let reviews: Array<{ body: string; commit_id: string; submitted_at: string }>;
try {
  reviews = JSON.parse(reviewsJson.stdout.trim());
} catch {
  reviews = [];
}

// Check that at least one review exists
if (reviews.length === 0) {
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
const hasSpec = reviews.some((r) => r.body && /spec[- ]verification/i.test(r.body));
if (!hasSpec) {
  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Review on PR #${pr} lacks spec verification section. Use /review-pr to post a review that includes spec verification before merging.`,
    },
  });
  process.exit(0);
}

// Check that at least one review contains documentation impact assessment
const hasDocImpact = reviews.some((r) => r.body && /documentation[- ]impact/i.test(r.body));
if (!hasDocImpact) {
  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Review on PR #${pr} lacks documentation impact section. Use /review-pr to post a review that includes documentation impact assessment before merging.`,
    },
  });
  process.exit(0);
}

// Check that the most recent review with spec verification covers the current HEAD
if (headSha) {
  const specReviews = reviews
    .filter((r) => r.body && /spec[- ]verification/i.test(r.body))
    .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
  const latestReview = specReviews[0];
  if (latestReview && latestReview.commit_id !== headSha) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Review on PR #${pr} is stale — covers commit ${latestReview.commit_id.slice(0, 7)} ` +
          `but PR HEAD is ${headSha.slice(0, 7)}. Re-run /review-pr to review the latest changes.`,
      },
    });
    process.exit(0);
  }
}
