#!/usr/bin/env bun
/**
 * Diff-scope-bounded replay harness for mt#1875.
 *
 * Replays the diff-scope-bounded downgrade logic (Fix 3, mt#1640) against
 * historical PR review data, showing whether out-of-scope findings would have
 * been downgraded on each round, without re-running the AI model.
 *
 * Data sources:
 *   - reviewer_convergence_metrics table (DB): per-round BLOCKING counts
 *   - GitHub API (read-only): prior review bodies (for file:line evidence)
 *   - GitHub API (read-only): PR diff (for scope range extraction)
 *
 * The script does NOT post anything to GitHub or modify any state.
 *
 * Usage:
 *   bun services/reviewer/scripts/replay-diff-scope-bounded.ts --pr=743
 *   bun services/reviewer/scripts/replay-diff-scope-bounded.ts --pr=1143 --owner=edobry --repo=minsky
 *
 * Environment:
 *   MINSKY_SESSIONDB_POSTGRES_URL or MINSKY_POSTGRES_URL — required for DB access
 *   GITHUB_TOKEN — required for GitHub API access
 *
 * Output:
 *   Structured JSON to stdout describing the per-round detection result.
 */

import { Octokit } from "@octokit/rest";
import { eq, and } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { convergenceMetricsTable } from "../src/db/schemas/convergence-metrics-schema";
import {
  extractFixCommitDiff,
  applyDiffScopeBoundedDowngrade,
  isLineInScope,
} from "../src/diff-scoper";
import { parsePriorBodyFindings } from "../src/severity-recovery";
import { ALLOWED_REVIEWER_BOT_LOGINS, CHINESE_WALL_MARKER } from "../src/prior-review-summary";

// ---------------------------------------------------------------------------
// Environment gates
// ---------------------------------------------------------------------------

const dbUrl = process.env.MINSKY_SESSIONDB_POSTGRES_URL ?? process.env.MINSKY_POSTGRES_URL;
if (!dbUrl) {
  console.error(
    "SKIP: MINSKY_SESSIONDB_POSTGRES_URL or MINSKY_POSTGRES_URL not set; skipping DB-backed replay."
  );
  console.error("Set one of these env vars to point at the Postgres instance.");
  process.exit(0);
}

import { resolveGitHubTokenOrSkip, getAuthSource } from "./harness-auth";
const githubToken = resolveGitHubTokenOrSkip();

// ---------------------------------------------------------------------------
// Known limitation (mt#1875 R2)
// ---------------------------------------------------------------------------

/**
 * SCOPE_WARNING — KNOWN LIMITATION of this replay harness (mt#1875 R2).
 *
 * The harness computes a per-round priorTimestamp from the immediately preceding
 * bot review's submittedAt, but `extractFixCommitDiff` does NOT filter the diff
 * string by that timestamp — it just parses whatever diff is passed in. Since
 * the full PR diff is what gets passed, the resulting lineRange is identical
 * for every round. The replay shows whether findings fall inside the PR-wide
 * scope, NOT whether per-round narrowing changes outcomes across rounds.
 *
 * The same placeholder exists in the production runReview path (review-worker.ts
 * lines 933-937, "placeholder — real per-commit filtering is future work").
 *
 * Real per-commit-since-priorTimestamp filtering is tracked as mt#1882.
 * When mt#1882 ships, this warning can be removed and the harness will reflect
 * actual per-round narrowing.
 *
 * Operators reading the JSON report should treat per-round downgrade signals
 * as a lower bound (worst case: full-PR scope). Real per-round narrowing will
 * be at least as aggressive as what this harness shows.
 */
const SCOPE_WARNING =
  "KNOWN LIMITATION (mt#1875 R2): per-round scopes are derived from the FULL PR diff, " +
  "not from commits-since-prior-review-timestamp. The lineRange is identical across rounds. " +
  "Real per-commit-since-priorTimestamp filtering is tracked as mt#1882. Treat per-round " +
  "downgrade signals as a lower bound (real narrowing will be at least as aggressive).";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  prNumber: number;
  owner: string;
  repo: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let prNumber: number | undefined;
  let owner = "edobry";
  let repo = "minsky";

  for (const arg of args) {
    if (arg.startsWith("--pr=")) {
      const parsed = parseInt(arg.slice("--pr=".length).trim(), 10);
      if (!isNaN(parsed) && parsed > 0) prNumber = parsed;
    } else if (arg.startsWith("--owner=")) {
      owner = arg.slice("--owner=".length).trim();
    } else if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length).trim();
    }
  }

  if (prNumber === undefined) {
    console.error("Error: --pr=<number> is required.");
    console.error("Usage: bun services/reviewer/scripts/replay-diff-scope-bounded.ts --pr=743");
    process.exit(2);
  }

  return { prNumber, owner, repo };
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

interface PriorReviewRecord {
  id: number;
  state: string;
  submittedAt: string;
  commitId: string;
  userLogin: string;
  body: string;
}

/**
 * Fetch all bot reviews on a PR (oldest-first), including DISMISSED.
 */
async function fetchBotReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PriorReviewRecord[]> {
  const allReviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return allReviews
    .map(
      (r): PriorReviewRecord => ({
        id: r.id,
        state: r.state,
        submittedAt: r.submitted_at ?? new Date(0).toISOString(),
        commitId: r.commit_id ?? "",
        userLogin: r.user?.login ?? "",
        body: r.body ?? "",
      })
    )
    .filter((r) => {
      if (r.state === "PENDING") return false;
      if (!ALLOWED_REVIEWER_BOT_LOGINS.has(r.userLogin)) return false;
      return r.body.includes(CHINESE_WALL_MARKER);
    })
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

/**
 * Fetch the PR diff from GitHub.
 */
async function fetchPrDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: prNumber,
      headers: { accept: "application/vnd.github.v3.diff" },
    });
    return typeof response.data === "string" ? response.data : "";
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: failed to fetch PR diff: ${message}`);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Per-round result types
// ---------------------------------------------------------------------------

interface FindingReplayResult {
  file: string;
  line?: number;
  lineEnd?: number;
  severity: string;
  inScope: boolean;
  wouldBeDowngraded: boolean;
}

interface RoundReplayResult {
  /** 1-based iteration index. */
  iterationIndex: number;
  /** BLOCKING count from DB (new_blocker_count). */
  currentBlockingCountFromDb: number;
  /** Number of prior review bodies fetched from GitHub. */
  priorReviewBodyCount: number;
  /** Whether this is R≥2 (prior reviews exist). */
  isPriorRoundPresent: boolean;
  /** Number of files in the fix-commit diff scope. */
  filesInScope: number;
  /** Per-finding analysis for this round. */
  findingResults: FindingReplayResult[];
  /** Number of BLOCKINGs that would have been downgraded. */
  wouldHaveDowngradedCount: number;
  /** Whether any downgrade would have fired. */
  downgradeApplied: boolean;
}

interface ReplayReport {
  runStartedAt: string;
  prOwner: string;
  prRepo: string;
  prNumber: number;
  dbRowCount: number;
  githubBotReviewCount: number;
  diffLinesExtracted: number;
  scopeWarning: string;
  roundResults: RoundReplayResult[];
  summary: {
    totalRounds: number;
    roundsWithPriorReviews: number;
    roundsWithDowngrade: number;
    totalDowngrades: number;
  };
}

// ---------------------------------------------------------------------------
// Main replay logic
// ---------------------------------------------------------------------------

async function replayPr(owner: string, repo: string, prNumber: number): Promise<ReplayReport> {
  const runStartedAt = new Date().toISOString();

  // 1. Fetch DB rows for this PR
  const db = createDb();
  const dbRows = await db
    .select()
    .from(convergenceMetricsTable)
    .where(
      and(
        eq(convergenceMetricsTable.prOwner, owner),
        eq(convergenceMetricsTable.prRepo, repo),
        eq(convergenceMetricsTable.prNumber, prNumber)
      )
    )
    .orderBy(convergenceMetricsTable.iterationIndex);

  if (dbRows.length === 0) {
    console.error(
      `No rows found in reviewer_convergence_metrics for ${owner}/${repo}#${prNumber}.`
    );
    console.error(
      "This PR may predate the convergence_metrics table, or the feature flag was never enabled."
    );
  }

  // 2. Fetch GitHub bot reviews and PR diff
  const octokit = new Octokit({ auth: githubToken });
  const [botReviews, prDiff] = await Promise.all([
    fetchBotReviews(octokit, owner, repo, prNumber),
    fetchPrDiff(octokit, owner, repo, prNumber),
  ]);

  console.error(
    `Fetched ${dbRows.length} DB row(s), ${botReviews.length} bot review(s), diff length=${prDiff.length} chars.`
  );

  console.error(`PR diff fetched: ${prDiff.length} chars.`);

  // 3. Build per-round results.
  //    For each round at R≥2, derive a per-round fix-commit scope from the
  //    timestamp of the immediately preceding bot review. This mirrors the
  //    production runReview logic: the scope is relative to the LAST reviewer
  //    round, not the PR-wide epoch. Using a shared epoch (new Date(0)) overstates
  //    in-scope lines and cannot show whether per-round narrowing changes outcomes.
  const roundResults: RoundReplayResult[] = [];

  for (const row of dbRows) {
    const { iterationIndex, newBlockerCount } = row;
    // iterationIndex is 1-based; convert to 0-based for botReviews array lookups.
    const botReviewArrayIdx = iterationIndex - 1;

    // Prior review bodies: reviews at array indices [0, botReviewArrayIdx).
    const priorReviewBodies = botReviews.slice(0, botReviewArrayIdx).map((r) => r.body);
    const isPriorRoundPresent = priorReviewBodies.length > 0;

    // Per-round fix-commit scope: use the timestamp of the immediately preceding
    // bot review when R≥2. For R1 (no prior reviews), use an empty lineRange
    // (conservative: all findings preserved) matching the production behavior.
    let roundFixCommitLineRange: ReturnType<typeof extractFixCommitDiff>["lineRange"] = new Map();
    if (isPriorRoundPresent) {
      // The preceding review is at botReviewArrayIdx - 1.
      const precedingReview = botReviews[botReviewArrayIdx - 1];
      const priorTimestamp =
        precedingReview !== undefined ? precedingReview.submittedAt : new Date(0).toISOString(); // fallback: epoch (conservative)
      try {
        const fixCommitResult = extractFixCommitDiff(prDiff, priorTimestamp);
        roundFixCommitLineRange = fixCommitResult.lineRange;
      } catch {
        // Defensive: malformed diff — leave lineRange empty (conservative).
        roundFixCommitLineRange = new Map();
      }
    }
    const filesInScope = roundFixCommitLineRange.size;

    // Current review body (if available from GitHub).
    const currentReviewBody = botReviews[botReviewArrayIdx]?.body;

    // Parse findings from current review body.
    const currentFindings = currentReviewBody ? parsePriorBodyFindings(currentReviewBody) : [];
    const currentBlockings = currentFindings.filter((f) => f.severity === "BLOCKING");

    // Per-finding scope analysis using the per-round lineRange.
    const findingResults: FindingReplayResult[] = currentBlockings.map((f) => {
      const inScope = isLineInScope(f.file, f.line, f.lineEnd, roundFixCommitLineRange);
      return {
        file: f.file,
        ...(f.line !== undefined ? { line: f.line } : {}),
        ...(f.lineEnd !== undefined ? { lineEnd: f.lineEnd } : {}),
        severity: f.severity,
        inScope,
        // Would be downgraded when: R≥2 AND out of scope
        wouldBeDowngraded: isPriorRoundPresent && !inScope,
      };
    });

    // Build synthetic tool calls for the downgrade check (only when R≥2).
    let downgradeApplied = false;
    let wouldHaveDowngradedCount = 0;

    if (isPriorRoundPresent && newBlockerCount > 0 && currentBlockings.length > 0) {
      const syntheticToolCalls = currentBlockings.map((f) => ({
        name: "submit_finding" as const,
        args: {
          severity: "BLOCKING" as const,
          file: f.file,
          line: f.line ?? 1,
          summary: "(synthetic for replay)",
          details: "(synthetic for replay)",
        },
      }));

      const result = applyDiffScopeBoundedDowngrade(syntheticToolCalls, roundFixCommitLineRange);
      downgradeApplied = result.downgradeApplied;
      wouldHaveDowngradedCount = result.downgrades.length;
    }

    roundResults.push({
      iterationIndex,
      currentBlockingCountFromDb: newBlockerCount,
      priorReviewBodyCount: priorReviewBodies.length,
      isPriorRoundPresent,
      filesInScope,
      findingResults,
      wouldHaveDowngradedCount,
      downgradeApplied,
    });
  }

  const totalRounds = roundResults.length;
  const roundsWithPriorReviews = roundResults.filter((r) => r.isPriorRoundPresent).length;
  const roundsWithDowngrade = roundResults.filter((r) => r.downgradeApplied).length;
  const totalDowngrades = roundResults.reduce((sum, r) => sum + r.wouldHaveDowngradedCount, 0);

  return {
    runStartedAt,
    prOwner: owner,
    prRepo: repo,
    prNumber,
    dbRowCount: dbRows.length,
    githubBotReviewCount: botReviews.length,
    diffLinesExtracted: prDiff.split("\n").length,
    scopeWarning: SCOPE_WARNING,
    roundResults,
    summary: {
      totalRounds,
      roundsWithPriorReviews,
      roundsWithDowngrade,
      totalDowngrades,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { prNumber, owner, repo } = parseArgs();

  console.error(`=== Diff-Scope-Bounded Replay (mt#1875 Fix 3) ===`);
  console.error(`Target: ${owner}/${repo}#${prNumber}`);
  console.error(`GitHub auth: ${getAuthSource()}`);
  console.error(`Feature: REVIEWER_DIFF_SCOPE_BOUNDED_ENABLED`);
  console.error("");

  try {
    const report = await replayPr(owner, repo, prNumber);

    // Emit structured JSON to stdout (operator pastes into PR body)
    console.log(JSON.stringify(report, null, 2));

    // Human-readable summary to stderr
    console.error("");
    console.error("=== Summary ===");
    console.error(`DB rows: ${report.dbRowCount}`);
    console.error(`GitHub bot reviews: ${report.githubBotReviewCount}`);
    console.error(`Total rounds: ${report.summary.totalRounds}`);
    console.error(`Rounds with prior reviews (R≥2): ${report.summary.roundsWithPriorReviews}`);
    console.error(`Rounds where downgrade would fire: ${report.summary.roundsWithDowngrade}`);
    console.error(`Total findings that would be downgraded: ${report.summary.totalDowngrades}`);
    console.error("");
    console.error("=== WARNING ===");
    console.error(SCOPE_WARNING);

    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Replay error:", message);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
