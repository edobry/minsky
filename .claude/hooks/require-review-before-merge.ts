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
// API/parse failure (exit code != 0, timeout, empty/non-JSON body, missing
// fields) from "zero check_runs" so the merge-gate can give an accurate
// diagnosis.
//
// The response shape is GitHub's Checks API: { total_count, check_runs[] }.
// We always trust total_count when present (canonical, pagination-safe). The
// caller queries with ?per_page=1 to keep the call cheap; check_runs.length is
// only a defensive fallback for unexpected response shapes — it is NOT a valid
// substitute for total_count when pagination is in play.
export function parseCheckRunsResponse(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}): CheckRunsParseResult {
  if (result.timedOut) {
    return {
      ok: false,
      error: `gh api timed out: ${result.stderr || "(no stderr)"}`,
    };
  }
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

// ---------------------------------------------------------------------------
// Bundle-boot smoke check (mt#1787) — exported for tests
// ---------------------------------------------------------------------------

// The check_run name produced by .github/workflows/bundle-boot-smoke.yml.
// Single source of truth so tests, the workflow, and the gate cannot drift.
export const BUNDLE_BOOT_SMOKE_CHECK_NAME = "bundle-boot-smoke";

// Override env var honored by the gate. Registered as hook-only in
// src/domain/configuration/sources/environment.ts (mt#1788 rule).
export const BUNDLE_BOOT_SMOKE_OVERRIDE_ENV = "MINSKY_SKIP_BUNDLE_SMOKE";

interface BundleBootCheckRun {
  // GitHub's Checks-API check_run shape, narrowed to the fields we read.
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
}

// Defensive name match (PR #1083 R1 NON-BLOCKING #3): GitHub's API typically
// returns `name` as the bare job name, but matrix jobs and certain
// workflow-name compositions can produce "<workflow-name> / <job-name>".
// Accept both shapes so future GitHub UX/API drift doesn't false-deny merges
// for a workflow that actually fired and passed.
function matchesBundleBootSmokeName(name: string): boolean {
  return (
    name === BUNDLE_BOOT_SMOKE_CHECK_NAME || name.endsWith(`/ ${BUNDLE_BOOT_SMOKE_CHECK_NAME}`)
  );
}

export interface BundleBootSmokeParseSuccess {
  ok: true;
  // Filtered to runs whose name matches BUNDLE_BOOT_SMOKE_CHECK_NAME (exactly
  // OR by `endsWith("/" + name)` to handle GitHub's "<workflow> / <job>"
  // naming variants). Sorted **latest-first** by completedAt (or startedAt
  // when not yet completed). PR #1083 R1 BLOCKING — recency matters: a later
  // failed re-run must override an earlier successful one. The eval function
  // below relies on `runs[0]` being the most-recent run.
  runs: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    htmlUrl: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
}
export type BundleBootSmokeParseResult = BundleBootSmokeParseSuccess | CheckRunsParseFailure;

export interface BundleBootSmokeEvalResult {
  deny: boolean;
  reason?: string;
}

// Parse a `gh api .../check-runs?check_name=bundle-boot-smoke` response.
// Distinguishes API/parse failure from "the workflow ran but conclusion is X"
// so the gate can give an accurate, actionable diagnosis.
export function parseBundleBootSmokeResponse(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}): BundleBootSmokeParseResult {
  if (result.timedOut) {
    return {
      ok: false,
      error: `gh api timed out: ${result.stderr || "(no stderr)"}`,
    };
  }
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
  const obj = parsed as { check_runs?: unknown };
  if (!Array.isArray(obj.check_runs)) {
    return { ok: false, error: "gh api response missing check_runs[]" };
  }
  const runs = (obj.check_runs as BundleBootCheckRun[])
    .filter((r) => typeof r?.name === "string" && matchesBundleBootSmokeName(r.name))
    .map((r) => ({
      name: r.name as string,
      status: typeof r.status === "string" ? r.status : "unknown",
      conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
      htmlUrl: typeof r.html_url === "string" ? r.html_url : null,
      startedAt: typeof r.started_at === "string" ? r.started_at : null,
      completedAt: typeof r.completed_at === "string" ? r.completed_at : null,
    }))
    // Sort latest-first by completedAt (preferred — tells us which run is
    // the most recent terminal verdict) with startedAt as a fallback for
    // runs that haven't yet completed. PR #1083 R1 BLOCKING — without this
    // the eval would treat `runs[0]` as the API's order, which is not a
    // documented sort guarantee for the check_name-filtered endpoint.
    .sort((a, b) => {
      const aKey = a.completedAt ?? a.startedAt ?? "";
      const bKey = b.completedAt ?? b.startedAt ?? "";
      if (aKey === bKey) return 0;
      return aKey < bKey ? 1 : -1;
    });
  return { ok: true, runs };
}

// Evaluate whether a PR's HEAD commit has a passing bundle-boot-smoke
// check_run. Four denial classes:
//
//   1. API/parse failure — gh transport error, malformed response.
//      Distinct reason so operators investigate gh, not the workflow.
//   2. No matching check_run — the workflow never fired (most likely
//      cause: PR predates the workflow being added, or webhook miss
//      analogous to mt#1309).
//   3. Latest run still in progress / queued — wait for completion.
//   4. Latest run completed but conclusion !== "success" — the bundle
//      didn't boot cleanly. Even if an earlier run succeeded, a later
//      re-run failure overrides — the gate must reflect current state.
//
// Pass: the LATEST run (sorted by completedAt then startedAt descending in
// `parseBundleBootSmokeResponse`) has conclusion === "success". This is the
// PR #1083 R1 BLOCKING fix — the prior `find(success)` semantics treated
// the presence of any historical success as sufficient, ignoring later
// re-run failures and rendering the gate unsafe.
export function evaluateBundleBootSmokePresence(
  parseResult: BundleBootSmokeParseResult,
  prNumber: string,
  headSha: string
): BundleBootSmokeEvalResult {
  if (!parseResult.ok) {
    return {
      deny: true,
      reason:
        `Unable to query bundle-boot-smoke check_run for PR #${prNumber} HEAD ${headSha.slice(0, 7)}: ${parseResult.error}. ` +
        `This is a gh api transport/parse failure — investigate before retrying. ` +
        `If the failure persists, set ${BUNDLE_BOOT_SMOKE_OVERRIDE_ENV}=1 to bypass after confirming local bundle-boot succeeds.`,
    };
  }
  if (parseResult.runs.length === 0) {
    return {
      deny: true,
      reason:
        `No "${BUNDLE_BOOT_SMOKE_CHECK_NAME}" check_run found for PR #${prNumber} HEAD ${headSha.slice(0, 7)} (mt#1787). ` +
        `This is the bundle-boot smoke CI gate — it builds dist/minsky.js and verifies /health responds 200 within 30s. ` +
        `Likely causes: (a) PR predates the workflow (rebase on main); ` +
        `(b) webhook miss (push an empty commit to wake it: session_commit { noFiles: true, noStage: true }); ` +
        `(c) workflow file is malformed (check the Actions tab). ` +
        `Override after confirming local bundle-boot succeeds: set ${BUNDLE_BOOT_SMOKE_OVERRIDE_ENV}=1.`,
    };
  }
  // Latest-first sort happens in the parser; runs[0] is the most recent.
  // Defensive destructuring for lint:strict (length check above guarantees
  // non-empty, but `!` is forbidden).
  const [latest] = parseResult.runs;
  if (!latest) {
    return {
      deny: true,
      reason:
        `bundle-boot-smoke check_run state for PR #${prNumber} HEAD ${headSha.slice(0, 7)} ` +
        `is internally inconsistent (mt#1787). Investigate gh api output and the parser.`,
    };
  }
  if (latest.conclusion === "success") {
    return { deny: false };
  }
  // Latest run did not succeed. Discriminate "still running" from "completed but failed."
  if (latest.status !== "completed") {
    return {
      deny: true,
      reason:
        `bundle-boot-smoke check_run for PR #${prNumber} HEAD ${headSha.slice(0, 7)} is still ${latest.status} (mt#1787). ` +
        `Wait for the latest run to complete before merging.`,
    };
  }
  // Latest is completed and conclusion is not success — fail.
  const urlSuffix = latest.htmlUrl ? ` See: ${latest.htmlUrl}` : "";
  return {
    deny: true,
    reason:
      `Latest bundle-boot-smoke check_run for PR #${prNumber} HEAD ${headSha.slice(0, 7)} concluded ${latest.conclusion ?? "(no conclusion)"} (mt#1787). ` +
      `The deployed bundle did not boot cleanly — fix before merging.${urlSuffix} ` +
      `Override after manual verification: set ${BUNDLE_BOOT_SMOKE_OVERRIDE_ENV}=1.`,
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
  // ?per_page=1 keeps the response tiny — the gate only reads total_count, which
  // is the canonical pagination-safe field on GitHub's Checks API.
  if (headSha) {
    const checkRunsResp = execSync(
      ["gh", "api", `repos/edobry/minsky/commits/${headSha}/check-runs?per_page=1`],
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

  // mt#1787: bundle-boot smoke gate — verify the deployed bundle actually boots.
  // Honors BUNDLE_BOOT_SMOKE_OVERRIDE_ENV escape valve for cases where the
  // operator has manually verified local boot but CI cannot run the workflow
  // (e.g., the workflow file itself is broken on the PR being merged).
  const skipBundleSmoke = process.env[BUNDLE_BOOT_SMOKE_OVERRIDE_ENV];
  if (skipBundleSmoke && /^(1|true|yes)$/i.test(skipBundleSmoke)) {
    process.stdout.write(
      `[require-review-before-merge] bundle-boot smoke skipped via ${BUNDLE_BOOT_SMOKE_OVERRIDE_ENV}=${skipBundleSmoke} ` +
        `(PR #${pr}, HEAD ${headSha?.slice(0, 7) ?? "(unknown)"}, ${new Date().toISOString()})\n`
    );
  } else if (headSha) {
    const bundleSmokeResp = execSync(
      [
        "gh",
        "api",
        `repos/edobry/minsky/commits/${headSha}/check-runs?check_name=${BUNDLE_BOOT_SMOKE_CHECK_NAME}`,
      ],
      { timeout: 10000 }
    );
    const bundleParseResult = parseBundleBootSmokeResponse(bundleSmokeResp);
    const bundleResult = evaluateBundleBootSmokePresence(bundleParseResult, pr, headSha);
    if (bundleResult.deny && bundleResult.reason) {
      writeOutput({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: bundleResult.reason,
        },
      });
      process.exit(0);
    }
  }
}
