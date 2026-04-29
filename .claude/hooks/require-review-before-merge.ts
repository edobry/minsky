#!/usr/bin/env bun
// PreToolUse hook: block session_pr_merge if no review exists on the PR,
// the review lacks a spec verification or documentation impact section,
// the review is stale (covers an older commit than PR HEAD),
// or no CI check_runs fired on the PR HEAD (mt#1309 webhook-miss regression detection).
// Ensures code review, spec verification, documentation impact assessment,
// review freshness, AND CI presence before merging.

import { readInput, writeOutput, execSync } from "./types";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// CI check_runs presence — exported for tests
// ---------------------------------------------------------------------------

export interface CheckRunsParseSuccess {
  ok: true;
  count: number;
}
export interface CheckRunsParseFailure {
  ok: false;
  error: string;
}
export type CheckRunsParseResult = CheckRunsParseSuccess | CheckRunsParseFailure;

export interface CheckRunsPresenceResult {
  deny: boolean;
  reason?: string;
}

// Parse a `gh api repos/.../commits/<sha>/check-runs` response. Distinguishes
// API/parse failure (exit code != 0, empty/non-JSON body, missing fields) from
// "zero check_runs" so the merge-gate can give an accurate diagnosis.
export function parseCheckRunsResponse(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): CheckRunsParseResult {
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `gh api exited ${result.exitCode}: ${result.stderr || "(no stderr)"}`,
    };
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) {
    return { ok: false, error: "gh api returned empty response" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      error: `failed to parse gh api response as JSON: ${(e as Error).message}`,
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "gh api response is not an object" };
  }
  const obj = parsed as { total_count?: unknown; check_runs?: unknown };
  if (typeof obj.total_count === "number") {
    return { ok: true, count: obj.total_count };
  }
  if (Array.isArray(obj.check_runs)) {
    return { ok: true, count: obj.check_runs.length };
  }
  return {
    ok: false,
    error: "gh api response missing total_count and check_runs[]",
  };
}

// mt#1309: detect the GitHub Actions webhook-miss class (PR #763 lineage).
// Workflows are configured to fire on every PR, but rare GitHub-side webhook
// drops produce a PR with zero check_runs. Without this gate, such PRs can
// merge with no CI signal at all. The recovery path (push an empty commit to
// wake the webhook) is documented in /review-pr step 7a.
//
// API/parse failures are kept distinct from the webhook-miss case so the
// denial reason is actionable: a transport error needs investigation, not the
// empty-commit recovery.
export function evaluateCheckRunsPresence(
  parseResult: CheckRunsParseResult,
  prNumber: string,
  headSha: string
): CheckRunsPresenceResult {
  if (!parseResult.ok) {
    return {
      deny: true,
      reason:
        `Unable to query CI check_runs for PR #${prNumber} HEAD ${headSha.slice(0, 7)}: ${parseResult.error}. ` +
        `This is distinct from the webhook-miss class — it indicates a gh api transport/parse failure. ` +
        `Investigate the gh api error before retrying. ` +
        `If the failure persists, escalate via the bypass-merge path documented in /review-pr step 7a.`,
    };
  }
  if (parseResult.count > 0) {
    return { deny: false };
  }
  return {
    deny: true,
    reason:
      `No CI check_runs found for PR #${prNumber} HEAD ${headSha.slice(0, 7)}. ` +
      `This is the GitHub Actions webhook-miss class (mt#1309 / PR #763 lineage). ` +
      `Recovery: push an empty commit to wake the webhook ` +
      `(session_commit with noFiles:true, noStage:true), wait ~30s, then retry the merge. ` +
      `If still 0 check_runs, escalate via the bypass-merge path documented in /review-pr step 7a.`,
  };
}

if (import.meta.main) {
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

  // mt#1309: regression-detection for the GitHub Actions webhook-miss class.
  // Skipped when headSha is unavailable (the gh pr list query above returned no row).
  if (headSha) {
    const checkRunsResp = execSync(
      ["gh", "api", `repos/edobry/minsky/commits/${headSha}/check-runs`],
      { timeout: 10000 }
    );
    const parseResult = parseCheckRunsResponse(checkRunsResp);
    const checkRunsResult = evaluateCheckRunsPresence(parseResult, pr, headSha);
    if (checkRunsResult.deny && checkRunsResult.reason) {
      writeOutput({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: checkRunsResult.reason,
        },
      });
      process.exit(0);
    }
  }
}
