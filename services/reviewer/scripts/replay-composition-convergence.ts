#!/usr/bin/env bun
/**
 * Composition-convergence replay harness for mt#1867.
 *
 * Replays the convergence-detection logic (Fix 2, mt#1640) against historical
 * PR review data, showing whether the stagnation-downgrade would have fired
 * on each round, without re-running the AI model.
 *
 * Data sources:
 *   - reviewer_convergence_metrics table (DB): per-round BLOCKING counts
 *   - GitHub API (read-only): prior review bodies (for file:line evidence)
 *
 * The script does NOT post anything to GitHub or modify any state.
 *
 * Usage:
 *   bun services/reviewer/scripts/replay-composition-convergence.ts --pr=743
 *   bun services/reviewer/scripts/replay-composition-convergence.ts --pr=732 --owner=edobry --repo=minsky
 *   REVIEWER_COMPOSITION_CONVERGENCE_ENABLED=1 bun services/reviewer/scripts/replay-composition-convergence.ts --pr=743
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
  applyCompositionConvergenceDowngrade,
  extractPriorFindingsForDetection,
  CONVERGENCE_ACTIVATION_THRESHOLD,
  type BlockingCountByRound,
  type FindingForDetection,
} from "../src/convergence-detector";
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

const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  console.error("SKIP: GITHUB_TOKEN not set; skipping live replay.");
  process.exit(0);
}

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
    console.error(
      "Usage: bun services/reviewer/scripts/replay-composition-convergence.ts --pr=743"
    );
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
 * Same as replay-severity.ts's fetchAllBotReviewsForReplay.
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

// ---------------------------------------------------------------------------
// Adapter: parsePriorBodyFindings → FindingForDetection
// ---------------------------------------------------------------------------

/**
 * Parse findings from a review body, returning in FindingForDetection shape.
 * parsePriorBodyFindings returns FlatPriorFinding[] which is structurally
 * compatible (file, severity, line?, lineEnd?) — explicit mapping avoids cast.
 */
function parseBodyAsDetectionFindings(body: string): ReadonlyArray<FindingForDetection> {
  return parsePriorBodyFindings(body).map((f) => ({
    file: f.file,
    severity: f.severity,
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.lineEnd !== undefined ? { lineEnd: f.lineEnd } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Per-round result types
// ---------------------------------------------------------------------------

interface RoundReplayResult {
  /** 0-based iteration index (matches convergence_metrics.iteration_index). */
  iterationIndex: number;
  /** BLOCKING count from convergence_metrics.new_blocker_count (current round). */
  currentBlockingCountFromDb: number;
  /** Prior BLOCKING counts from all rounds before this one (from DB). */
  priorBlockingCountsFromDb: BlockingCountByRound;
  /** Number of prior review bodies fetched from GitHub. */
  priorReviewBodyCount: number;
  /** Total prior findings parsed across all prior review bodies. */
  priorFindingCount: number;
  /** Whether the convergence activation threshold was met (R >= 4). */
  activationThresholdMet: boolean;
  /** Convergence detection result for this round (null if threshold not met). */
  downgradeApplied: boolean | null;
  /** Reason downgrade was or was not applied (null if threshold not met). */
  downgradeReason: string | null;
}

interface ReplayReport {
  runStartedAt: string;
  prOwner: string;
  prRepo: string;
  prNumber: number;
  dbRowCount: number;
  githubBotReviewCount: number;
  activationThreshold: number;
  roundResults: RoundReplayResult[];
  summary: {
    roundsChecked: number;
    roundsWithDowngrade: number;
    roundsWithoutDowngrade: number;
    roundsBelowThreshold: number;
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

  // 2. Fetch GitHub bot reviews
  const octokit = new Octokit({ auth: githubToken });
  const botReviews = await fetchBotReviews(octokit, owner, repo, prNumber);

  console.error(
    `Fetched ${dbRows.length} DB row(s) and ${botReviews.length} bot review(s) from GitHub.`
  );

  // 3. Build per-round results
  const roundResults: RoundReplayResult[] = [];

  for (const row of dbRows) {
    const { iterationIndex, newBlockerCount } = row;

    // Prior BLOCKING counts = new_blocker_count of all rows with lower iteration_index
    const priorDbRows = dbRows.filter((r) => r.iterationIndex < iterationIndex);
    const priorBlockingCounts: BlockingCountByRound = priorDbRows.map((r) => r.newBlockerCount);

    // Prior review bodies from GitHub: reviews BEFORE this iteration (0-based index)
    // GitHub reviews are 0-indexed oldest-first; iterationIndex=0 → no prior reviews
    const priorReviewBodies = botReviews.slice(0, iterationIndex).map((r) => r.body);

    const priorFindings = extractPriorFindingsForDetection(
      priorReviewBodies,
      parseBodyAsDetectionFindings
    );

    const activationThresholdMet = iterationIndex + 1 >= CONVERGENCE_ACTIVATION_THRESHOLD;

    let downgradeApplied: boolean | null = null;
    let downgradeReason: string | null = null;

    if (activationThresholdMet && newBlockerCount > 0) {
      // Build minimal synthetic tool calls for the detector.
      // We only have the count from DB, not the actual file:line data from this
      // round. Without the current round's file:line data, we can only check
      // the count-based signal (isStrictlyDecreasing). The evidence check
      // (hasNewEvidence) requires the actual file:line pairs from this round's
      // findings, which are only available if the review body is present.
      //
      // Use the corresponding GitHub review body if available.
      const currentReviewBody = botReviews[iterationIndex]?.body;
      const currentFindings: FindingForDetection[] = currentReviewBody
        ? (parseBodyAsDetectionFindings(currentReviewBody) as FindingForDetection[]).filter(
            (f) => f.severity === "BLOCKING"
          )
        : [];

      if (currentFindings.length === 0 && newBlockerCount > 0) {
        downgradeReason =
          `DB shows ${newBlockerCount} BLOCKING(s) but no file:line data available from ` +
          `GitHub review body (iteration ${iterationIndex}). Count-only check performed.`;
      }

      // Build synthetic submit_finding tool calls for the detector
      const syntheticToolCalls = currentFindings.map((f) => ({
        name: "submit_finding" as const,
        args: {
          severity: "BLOCKING" as const,
          file: f.file,
          line: f.line ?? 1,
          summary: "(synthetic for replay)",
          details: "(synthetic for replay)",
        },
      }));

      const result = applyCompositionConvergenceDowngrade(
        syntheticToolCalls,
        priorFindings,
        priorBlockingCounts,
        iterationIndex + 1 // spec uses 1-based round numbers
      );

      downgradeApplied = result.downgradeApplied;
      downgradeReason ??= result.downgradeApplied
        ? `Stagnation detected: count history ${JSON.stringify([...priorBlockingCounts, newBlockerCount])}, no new file:line evidence.`
        : `No stagnation: count history ${JSON.stringify([...priorBlockingCounts, newBlockerCount])} or new evidence found.`;
    } else if (activationThresholdMet && newBlockerCount === 0) {
      downgradeApplied = false;
      downgradeReason =
        "No BLOCKING findings — convergence detection skipped (nothing to downgrade).";
    } else {
      downgradeApplied = null;
      downgradeReason = `Below activation threshold (R${iterationIndex + 1} < R${CONVERGENCE_ACTIVATION_THRESHOLD}).`;
    }

    roundResults.push({
      iterationIndex,
      currentBlockingCountFromDb: newBlockerCount,
      priorBlockingCountsFromDb: priorBlockingCounts,
      priorReviewBodyCount: priorReviewBodies.length,
      priorFindingCount: priorFindings.length,
      activationThresholdMet,
      downgradeApplied,
      downgradeReason,
    });
  }

  const roundsChecked = roundResults.filter((r) => r.activationThresholdMet).length;
  const roundsWithDowngrade = roundResults.filter((r) => r.downgradeApplied === true).length;
  const roundsWithoutDowngrade = roundResults.filter(
    (r) => r.activationThresholdMet && r.downgradeApplied === false
  ).length;
  const roundsBelowThreshold = roundResults.filter((r) => !r.activationThresholdMet).length;

  return {
    runStartedAt,
    prOwner: owner,
    prRepo: repo,
    prNumber,
    dbRowCount: dbRows.length,
    githubBotReviewCount: botReviews.length,
    activationThreshold: CONVERGENCE_ACTIVATION_THRESHOLD,
    roundResults,
    summary: {
      roundsChecked,
      roundsWithDowngrade,
      roundsWithoutDowngrade,
      roundsBelowThreshold,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { prNumber, owner, repo } = parseArgs();

  console.error(`=== Composition-Convergence Replay (mt#1867) ===`);
  console.error(`Target: ${owner}/${repo}#${prNumber}`);
  console.error(`Activation threshold: R>=${CONVERGENCE_ACTIVATION_THRESHOLD}`);
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
    console.error(`Rounds below threshold: ${report.summary.roundsBelowThreshold}`);
    console.error(
      `Rounds checked (R>=${CONVERGENCE_ACTIVATION_THRESHOLD}): ${report.summary.roundsChecked}`
    );
    console.error(`  → Would have downgraded: ${report.summary.roundsWithDowngrade}`);
    console.error(`  → Would NOT have downgraded: ${report.summary.roundsWithoutDowngrade}`);

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
