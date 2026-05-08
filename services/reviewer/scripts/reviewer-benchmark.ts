#!/usr/bin/env bun
/**
 * Reviewer wall-time benchmark for mt#1515.
 *
 * Measures the end-to-end latency of minsky-reviewer[bot] on recent Tier-3
 * PRs (agent-authored, marked `<!-- minsky:tier=3 -->`). Produces structured
 * JSON with per-sample deltas and aggregate statistics (min/median/mean/max).
 *
 * Wall-time approximation:
 *   - Webhook-arrival proxy: the PR's last commit `committer.date` before the
 *     reviewer's review. True webhook timestamps are not available via the
 *     GitHub REST API; commit time approximates webhook arrival within seconds.
 *   - Review posted: `submitted_at` of the FIRST review by minsky-reviewer[bot]
 *     after the relevant commit.
 *   - Delta: submitted_at − committer.date in milliseconds.
 *
 * Usage:
 *   bun services/reviewer/scripts/reviewer-benchmark.ts
 *   GITHUB_TOKEN=<token> LIMIT=5 bun services/reviewer/scripts/reviewer-benchmark.ts
 *
 * Skips gracefully when GITHUB_TOKEN is absent.
 *
 * mt#1515 context: codifies the "wall-time benchmark" acceptance criterion for
 * the reviewer service. Companion to seeded-bug-harness.ts.
 */

import { Octokit } from "@octokit/rest";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Environment gating
// ---------------------------------------------------------------------------

// Cap on how many candidate PRs to examine to avoid unbounded API consumption.
const MAX_CANDIDATES = 50;

// ---------------------------------------------------------------------------
// Environment configuration (read at call time, not module load time, so
// importing this module for testing does not trigger process.exit).
// ---------------------------------------------------------------------------

function getEnv(): {
  GITHUB_TOKEN: string | undefined;
  OWNER: string;
  REPO: string;
  LIMIT: number;
} {
  const raw = process.env.LIMIT;
  const parsedLimit = raw ? parseInt(raw, 10) : NaN;
  return {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    OWNER: process.env.OWNER ?? "edobry",
    REPO: process.env.REPO ?? "minsky",
    LIMIT: !isNaN(parsedLimit) && parsedLimit > 0 ? parsedLimit : 3,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BenchmarkSample {
  prNumber: number;
  headSha: string;
  commitAt: string;
  reviewedAt: string;
  deltaMs: number;
  tier: 3;
}

interface BenchmarkStats {
  n: number;
  minMs: number;
  maxMs: number;
  medianMs: number;
  meanMs: number;
}

interface BenchmarkResult {
  ranAt: string;
  owner: string;
  repo: string;
  samples: BenchmarkSample[];
  stats: BenchmarkStats;
}

// ---------------------------------------------------------------------------
// Stats helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Compute the median of a sorted-or-unsorted array of numbers. */
export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

/** Compute the arithmetic mean. Returns 0 for empty arrays. */
export function computeMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Compute aggregate stats from an array of delta milliseconds. */
export function computeStats(deltas: number[]): BenchmarkStats {
  if (deltas.length === 0) {
    return { n: 0, minMs: 0, maxMs: 0, medianMs: 0, meanMs: 0 };
  }
  return {
    n: deltas.length,
    minMs: Math.min(...deltas),
    maxMs: Math.max(...deltas),
    medianMs: computeMedian(deltas),
    meanMs: computeMean(deltas),
  };
}

// ---------------------------------------------------------------------------
// Tier detection
// ---------------------------------------------------------------------------

/**
 * A PR is Tier 3 if:
 *   (a) its body contains an `<!-- minsky:tier=3 -->` marker (whitespace-tolerant), OR
 *   (b) it has at least one review posted by `minsky-reviewer[bot]`.
 *
 * Condition (b) catches PRs where the tier marker was present at review time
 * but has since been edited out of the body.
 *
 * The marker regex is whitespace-tolerant (`\s*` around the colon-equal pair)
 * so variants like `<!--  minsky:tier=3  -->` still match. This matches the
 * tolerance the reviewer service applies when routing.
 */
const TIER3_MARKER_RE = /<!--\s*minsky:tier=3\s*-->/;

export function isTier3ByBody(prBody: string | null): boolean {
  return TIER3_MARKER_RE.test(prBody ?? "");
}

// ---------------------------------------------------------------------------
// GitHub fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all bot reviews for a PR (non-pending, by minsky-reviewer[bot]).
 * Returns oldest-first so we can find the FIRST review after the head commit.
 */
async function fetchBotReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<Array<{ submittedAt: string; state: string; body: string }>> {
  let reviews: Array<{
    user: { login: string } | null;
    state: string;
    submitted_at?: string | null;
    body: string;
  }>;

  try {
    const response = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    reviews = response.data;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list reviews for PR #${prNumber}: ${message}`, { cause: err });
  }

  return reviews
    .filter(
      (r) => r.user?.login === "minsky-reviewer[bot]" && r.state !== "PENDING" && r.submitted_at
    )
    .map((r) => ({
      submittedAt: r.submitted_at as string,
      state: r.state,
      body: r.body,
    }))
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
}

/**
 * Fetch the commits for a PR and find the one whose SHA matches the review's
 * context (the last commit before the reviewer's first review).
 *
 * Returns: the committer date of the relevant commit, and the head SHA.
 */
async function fetchCommitContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  reviewSubmittedAt: string
): Promise<{ commitAt: string; headSha: string } | null> {
  let commits: Array<{
    sha: string;
    commit: {
      committer: { date?: string | null } | null;
    };
  }>;

  try {
    const response = await octokit.rest.pulls.listCommits({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    commits = response.data;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list commits for PR #${prNumber}: ${message}`, { cause: err });
  }

  if (commits.length === 0) return null;

  // The head SHA is the last commit in the list.
  const headCommit = commits[commits.length - 1];
  if (!headCommit) return null;
  const headSha = headCommit.sha;

  // Find the last commit BEFORE the review was submitted. This approximates
  // the commit the reviewer was reacting to (the webhook trigger commit).
  // Parse to numeric timestamps to avoid relying on lexicographic ordering of
  // ISO-8601 strings (works today because GitHub returns normalized UTC, but
  // would silently break if a future API revision returned offset notation).
  const reviewAtMs = Date.parse(reviewSubmittedAt);
  const commitsBeforeReview = commits.filter((c) => {
    const date = c.commit.committer?.date;
    if (date == null) return false;
    const dateMs = Date.parse(date);
    return Number.isFinite(dateMs) && dateMs <= reviewAtMs;
  });

  // Use the last commit before the review (or the first commit if all are
  // after — unlikely but defensively handled).
  const relevant =
    commitsBeforeReview.length > 0
      ? commitsBeforeReview[commitsBeforeReview.length - 1]
      : commits[0];

  if (!relevant) return null;

  const commitDate = relevant.commit.committer?.date;
  if (!commitDate) return null;

  return { commitAt: commitDate, headSha };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { GITHUB_TOKEN, OWNER, REPO, LIMIT } = getEnv();

  if (!GITHUB_TOKEN) {
    console.log("SKIP: GITHUB_TOKEN not set; skipping reviewer benchmark.");
    process.exit(0);
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));

  console.log("=== Reviewer Wall-Time Benchmark (mt#1515) ===");
  console.log(`Owner/Repo: ${OWNER}/${REPO}`);
  console.log(`Target samples: ${LIMIT} Tier-3 PRs (max candidates: ${MAX_CANDIDATES})`);
  console.log("");

  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  const samples: BenchmarkSample[] = [];
  let candidatesExamined = 0;
  let page = 1;

  // Fetch closed/merged PRs in batches of 20 until we have LIMIT samples
  // or exhaust MAX_CANDIDATES.
  outer: while (samples.length < LIMIT && candidatesExamined < MAX_CANDIDATES) {
    let prs: Array<{
      number: number;
      body: string | null;
      merged_at: string | null;
      state: string;
    }>;

    try {
      const response = await octokit.rest.pulls.list({
        owner: OWNER,
        repo: REPO,
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: 20,
        page,
      });
      prs = response.data;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to list PRs (page ${page}): ${message}`);
      break;
    }

    if (prs.length === 0) break; // No more PRs to examine.
    page++;

    for (const pr of prs) {
      if (candidatesExamined >= MAX_CANDIDATES) break outer;
      // Only consider merged PRs (not just closed).
      if (!pr.merged_at) continue;

      candidatesExamined++;
      console.log(`Examining PR #${pr.number} (candidate ${candidatesExamined}/${MAX_CANDIDATES})`);

      // -----------------------------------------------------------------------
      // Tier detection: check body first (fast path), then reviews.
      // -----------------------------------------------------------------------
      const tier3ByBody = isTier3ByBody(pr.body);

      let botReviews: Array<{ submittedAt: string; state: string; body: string }> = [];
      try {
        botReviews = await fetchBotReviews(octokit, OWNER, REPO, pr.number);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  Skipping PR #${pr.number}: failed to fetch reviews: ${message}`);
        continue;
      }

      const tier3 = tier3ByBody || botReviews.length > 0;
      if (!tier3) {
        console.log(`  Not Tier 3 — skipping.`);
        continue;
      }

      if (botReviews.length === 0) {
        console.log(`  Tier 3 (body marker) but no bot review found — skipping.`);
        continue;
      }

      // The first bot review is the one we measure latency for.
      const firstReview = botReviews[0];
      const reviewedAt = firstReview.submittedAt;

      // -----------------------------------------------------------------------
      // Commit context: find the commit that triggered this review.
      // -----------------------------------------------------------------------
      let commitContext: { commitAt: string; headSha: string } | null = null;
      try {
        commitContext = await fetchCommitContext(octokit, OWNER, REPO, pr.number, reviewedAt);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  Skipping PR #${pr.number}: failed to fetch commits: ${message}`);
        continue;
      }

      if (!commitContext) {
        console.log(`  PR #${pr.number}: could not determine commit time — skipping.`);
        continue;
      }

      const { commitAt, headSha } = commitContext;
      const deltaMs = new Date(reviewedAt).getTime() - new Date(commitAt).getTime();

      if (deltaMs < 0) {
        // The review timestamp is before the commit — data anomaly, skip.
        console.log(
          `  PR #${pr.number}: review appears before commit (delta=${deltaMs}ms) — skipping.`
        );
        continue;
      }

      const sample: BenchmarkSample = {
        prNumber: pr.number,
        headSha,
        commitAt,
        reviewedAt,
        deltaMs,
        tier: 3,
      };

      samples.push(sample);
      const deltaSec = (deltaMs / 1000).toFixed(1);
      console.log(`  Tier 3 PR #${pr.number}: delta=${deltaSec}s (${deltaMs}ms)`);

      if (samples.length >= LIMIT) break outer;
    }
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------
  const deltas = samples.map((s) => s.deltaMs);
  const stats = computeStats(deltas);

  const result: BenchmarkResult = {
    ranAt: new Date().toISOString(),
    owner: OWNER,
    repo: REPO,
    samples,
    stats,
  };

  // -----------------------------------------------------------------------
  // Output
  // -----------------------------------------------------------------------
  const outputPath = join(scriptDir, "reviewer-benchmark-results.json");
  try {
    writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
    console.log(`\nResults written to: ${outputPath}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: failed to write results JSON: ${message}`);
  }

  if (samples.length > 0) {
    const minSec = (stats.minMs / 1000).toFixed(1);
    const medianSec = (stats.medianMs / 1000).toFixed(1);
    const maxSec = (stats.maxMs / 1000).toFixed(1);
    console.log(
      `\nTier-3 reviewer wall-time (n=${stats.n}): min=${minSec}s, median=${medianSec}s, max=${maxSec}s`
    );
  } else {
    console.log("\nNo Tier-3 samples collected.");
  }

  if (samples.length < LIMIT) {
    console.error(
      `\nFAIL: collected only ${samples.length}/${LIMIT} samples after examining ${candidatesExamined} candidate PRs.`
    );
    process.exit(1);
  }

  process.exit(0);
}

// Only run main() when this file is executed directly (not imported as a module
// for testing). Bun sets import.meta.main to true when the file is the entry
// point. This prevents process.exit() from firing when test files import
// exported helpers from this module.
if (import.meta.main) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Fatal benchmark error:", message);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });
}
