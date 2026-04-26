/**
 * Periodic sweeper for minsky-reviewer[bot].
 *
 * Safety-net layer behind the primary webhook path (mt#1258 ack-immediate
 * refactor). Lists open PRs, identifies any whose HEAD SHA has no
 * corresponding minsky-reviewer review, and retriggers via in-process
 * runReview calls.
 *
 * ## Retrigger strategy: in-process runReview (option b)
 *
 * Calls runReview directly from the sweeper rather than using the GitHub App
 * webhook delivery redeliver API. This avoids requiring App-JWT auth scope
 * and eliminates cross-repo PR# ambiguity. The sweeper has all the data
 * needed (owner, repo, prNumber, headSha, prAuthorLogin) from the PR listing
 * step, so it can construct the same arguments runReview would receive from
 * the webhook handler.
 *
 * Concurrency is capped at 3 simultaneous runReview calls to avoid OOM under
 * large PR backlogs.
 *
 * retriggeredCount = number of PRs for which runReview was successfully
 * scheduled (detached, catch-logged). Since we don't await, all missing PRs
 * are counted.
 *
 * ## Schedule wiring: in-process setInterval
 *
 * Chosen over a Railway scheduled cron entry-point for simplicity: no second
 * Railway service to provision, no separate entry-point binary, and the
 * sweeper shares the same octokit / config the server already has. The
 * interval (10 min) is configurable via SWEEPER_INTERVAL_MS. To disable the
 * sweeper entirely, set SWEEPER_ENABLED=false.
 */

import type { ReviewerConfig } from "./config";
import { createOctokit, getAppIdentity } from "./github-client";
import { runReview } from "./review-worker";
import { decideRouting, extractTierFromPRBody } from "./tier-routing";
import type { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Public configuration interface
// ---------------------------------------------------------------------------

export interface SweeperConfig {
  /** Owner of the target GitHub repo (default: "edobry"). */
  owner: string;
  /** Name of the target GitHub repo (default: "minsky"). */
  repo: string;
  /** Sweep interval in milliseconds. */
  intervalMs: number;
  /** Whether the sweeper is enabled. */
  enabled: boolean;
}

export function loadSweeperConfig(): SweeperConfig {
  return {
    owner: process.env["SWEEPER_REPO_OWNER"] ?? "edobry",
    repo: process.env["SWEEPER_REPO_NAME"] ?? "minsky",
    intervalMs: parseInt(process.env["SWEEPER_INTERVAL_MS"] ?? "600000", 10),
    enabled: (process.env["SWEEPER_ENABLED"] ?? "false") === "true",
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A PR that is missing a minsky-reviewer review at its current HEAD SHA. */
export interface MissingReviewPR {
  /** PR number. */
  number: number;
  /** Current HEAD commit SHA. */
  headSha: string;
  /** PR author login. */
  authorLogin: string;
  /** Human-readable reason (e.g. "no review by bot" or "commit_id mismatch"). */
  reason: "no_review_by_bot" | "commit_id_mismatch";
}

/** Summary of a single sweep cycle. */
export interface SweepResult {
  /** Timestamp when the sweep started (ISO 8601). */
  startedAt: string;
  /** Number of open PRs scanned. */
  prsScanned: number;
  /** PRs detected as missing a review. */
  missing: MissingReviewPR[];
  /**
   * Number of PRs for which runReview was successfully scheduled.
   * Since runReview calls are detached (not awaited in the main sweep loop),
   * this equals missing.length whenever retrigger scheduling itself does not
   * throw (which it never does — the only throws are inside runReview and are
   * catch-logged inside retriggerViaRunReview).
   */
  retriggeredCount: number;
}

// ---------------------------------------------------------------------------
// Core detection logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * List all open pull requests in the given repo.
 *
 * Uses auto-pagination to handle repos with many open PRs.
 */
export async function listOpenPRs(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<
  Array<{ number: number; headSha: string; body: string; authorLogin: string; draft: boolean }>
> {
  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });

  return prs.map((pr) => ({
    number: pr.number,
    headSha: pr.head.sha,
    body: pr.body ?? "",
    authorLogin: pr.user?.login ?? "",
    draft: pr.draft === true,
  }));
}

/**
 * Fetch all reviews for a PR and find whether minsky-reviewer[bot] has
 * reviewed at the current HEAD SHA.
 *
 * Returns:
 *   - null when a non-dismissed review by the bot at the current headSha exists.
 *   - A MissingReviewPR when no review or only stale/dismissed reviews exist.
 */
export async function detectMissingReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  botLogin: string,
  authorLogin: string
): Promise<MissingReviewPR | null> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  // Filter for non-dismissed bot reviews only — dismissed reviews signal
  // that a human overrode the bot review, not that the bot reviewed the PR.
  const botReviews = reviews.filter(
    (r) => r.user?.login.toLowerCase() === botLogin.toLowerCase() && r.state !== "DISMISSED"
  );

  if (botReviews.length === 0) {
    return {
      number: prNumber,
      headSha,
      authorLogin,
      reason: "no_review_by_bot",
    };
  }

  // Bot has reviewed this PR — check whether any review targets the current HEAD SHA.
  const hasReviewAtHead = botReviews.some((r) => r.commit_id === headSha);

  if (!hasReviewAtHead) {
    return {
      number: prNumber,
      headSha,
      authorLogin,
      reason: "commit_id_mismatch",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Retrigger logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Injectable runReview function type, for test seams.
 */
export type RunReviewFn = typeof runReview;

/**
 * Retrigger a review for a missed PR by calling runReview directly.
 *
 * Uses a synthesized delivery ID ("sweeper-{timestamp}") in the log since
 * there is no real GitHub delivery ID for sweeper-initiated reviews.
 *
 * Errors from runReview are logged as warnings but do not propagate — the
 * sweeper is a best-effort safety net, not a hard guarantee.
 */
export async function retriggerViaRunReview(
  config: ReviewerConfig,
  owner: string,
  repo: string,
  pr: MissingReviewPR,
  runReviewFn: RunReviewFn = runReview
): Promise<void> {
  const deliveryId = `sweeper-${Date.now()}`;
  console.log(
    JSON.stringify({
      event: "sweeper.retrigger_start",
      deliveryId,
      pr: pr.number,
      headSha: pr.headSha,
      owner,
      repo,
    })
  );

  try {
    const result = await runReviewFn(config, owner, repo, pr.number, pr.authorLogin);
    console.log(
      JSON.stringify({
        event: "sweeper.retrigger_success",
        deliveryId,
        pr: pr.number,
        headSha: pr.headSha,
        status: result.status,
        reason: result.reason,
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      JSON.stringify({
        event: "sweeper.retrigger_failed",
        deliveryId,
        pr: pr.number,
        headSha: pr.headSha,
        error: message,
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Sweeper cycle
// ---------------------------------------------------------------------------

/** Dependencies injectable for tests. */
export interface SweeperDeps {
  octokit: Octokit;
  botLogin: string;
  /** Optional runReview override for tests. Defaults to the real runReview. */
  runReviewFn?: RunReviewFn;
}

/**
 * Build the real SweeperDeps from config (used in production).
 * Exported so server.ts can call it and tests can bypass it.
 */
export async function buildSweeperDeps(config: ReviewerConfig): Promise<SweeperDeps> {
  const octokit = await createOctokit(config);
  const botIdentity = await getAppIdentity(config);
  return { octokit, botLogin: botIdentity.login };
}

/**
 * Run a single sweep cycle.
 *
 * 1. Lists all open PRs.
 * 2. For each PR, checks whether minsky-reviewer[bot] has a non-dismissed
 *    review at HEAD SHA. Skips PRs whose tier routes to skip (Tier 1 or
 *    Tier 2 when tier2Enabled=false).
 * 3. For each missing PR, calls runReview directly (in-process, detached).
 *    Concurrency is capped at SWEEP_CONCURRENCY (3) to avoid OOM.
 * 4. Returns a SweepResult with cycle metrics.
 *
 * @param depsOverride Optional dependency override for tests. When provided,
 *   skips the createOctokit + getAppIdentity calls entirely.
 */
const SWEEP_CONCURRENCY = 3;

export async function runSweep(
  config: ReviewerConfig,
  sweeperConfig: SweeperConfig,
  depsOverride?: SweeperDeps
): Promise<SweepResult> {
  const startedAt = new Date().toISOString();
  const { owner, repo } = sweeperConfig;

  const { octokit, botLogin, runReviewFn } = depsOverride ?? (await buildSweeperDeps(config));

  console.log(
    JSON.stringify({
      event: "sweeper.cycle_start",
      timestamp: startedAt,
      owner,
      repo,
      botLogin,
    })
  );

  // 1. List all open PRs.
  const openPRs = await listOpenPRs(octokit, owner, repo);
  const prsScanned = openPRs.length;

  // 2. Detect missing reviews, respecting tier routing.
  const missing: MissingReviewPR[] = [];

  for (const pr of openPRs) {
    // Skip draft PRs — mirrors the webhook handler's skip_draft policy.
    if (pr.draft) {
      console.log(
        JSON.stringify({
          event: "skip_draft_sweeper",
          pr: pr.number,
          owner,
          repo,
        })
      );
      continue;
    }

    // Respect tier routing: skip PRs that decideRouting says to skip.
    // We use extractTierFromPRBody here (not the full resolveTier fallback
    // chain with MCP) because the sweeper is a lightweight background task —
    // it should not add per-PR MCP round-trips. PRs with no body marker get
    // the null tier → defaults to Tier 2 behavior. This matches the Sprint A
    // fail-open policy for sweeper context.
    const tier = extractTierFromPRBody(pr.body);
    const routing = decideRouting(tier, config);
    if (!routing.shouldReview) {
      continue;
    }

    const detected = await detectMissingReview(
      octokit,
      owner,
      repo,
      pr.number,
      pr.headSha,
      botLogin,
      pr.authorLogin
    );

    if (detected !== null) {
      missing.push(detected);
      console.warn(
        JSON.stringify({
          event: "sweeper.missing_review",
          pr: detected.number,
          headSha: detected.headSha,
          reason: detected.reason,
        })
      );
    }
  }

  if (missing.length > 0) {
    console.warn(
      JSON.stringify({
        event: "sweeper.primary_webhook_failing",
        message: `${missing.length} PR(s) are missing a minsky-reviewer review — the primary webhook path may be failing.`,
        missingPrNumbers: missing.map((m) => m.number),
      })
    );
  }

  // 3. Retrigger missing reviews via in-process runReview, capped at SWEEP_CONCURRENCY.
  let retriggeredCount = 0;
  for (let i = 0; i < missing.length; i += SWEEP_CONCURRENCY) {
    const batch = missing.slice(i, i + SWEEP_CONCURRENCY);
    // Schedule each in the batch. retriggerViaRunReview never throws (it
    // catch-logs internally), so we can safely await all in parallel.
    await Promise.all(
      batch.map((pr) => retriggerViaRunReview(config, owner, repo, pr, runReviewFn))
    );
    retriggeredCount += batch.length;
  }

  const result: SweepResult = {
    startedAt,
    prsScanned,
    missing,
    retriggeredCount,
  };

  console.log(
    JSON.stringify({
      event: "sweeper.cycle_end",
      ...result,
      missingCount: missing.length,
    })
  );

  return result;
}

// ---------------------------------------------------------------------------
// Scheduler (in-process setInterval)
// ---------------------------------------------------------------------------

/**
 * Start the sweeper on an in-process interval.
 *
 * Chosen over a Railway cron entry-point for simplicity: no second Railway
 * service to provision and the sweeper shares the same config the server
 * already has. The interval is configurable via SWEEPER_INTERVAL_MS (default
 * 10 min). Opt-in via SWEEPER_ENABLED=true (disabled by default).
 *
 * The first sweep runs after one full interval — not immediately at boot —
 * to avoid competing with the service startup sequence.
 *
 * A reentrancy guard (isSweeping) prevents overlapping sweeps if a cycle
 * takes longer than the interval (e.g., during a slow LLM round).
 *
 * Returns the timer handle so callers can clear it in tests.
 */
export function startSweeper(
  config: ReviewerConfig,
  sweeperConfig: SweeperConfig
): ReturnType<typeof setInterval> | null {
  if (!sweeperConfig.enabled) {
    console.log(
      JSON.stringify({
        event: "sweeper.disabled",
        message: "Sweeper is disabled (SWEEPER_ENABLED=false).",
      })
    );
    return null;
  }

  console.log(
    JSON.stringify({
      event: "sweeper.started",
      intervalMs: sweeperConfig.intervalMs,
      owner: sweeperConfig.owner,
      repo: sweeperConfig.repo,
    })
  );

  let isSweeping = false;

  const handle = setInterval(() => {
    if (isSweeping) {
      console.warn(
        JSON.stringify({
          event: "sweeper.skip_reentrant",
          message: "Previous sweep still in progress; skipping this interval tick.",
        })
      );
      return;
    }
    isSweeping = true;
    runSweep(config, sweeperConfig)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({
            event: "sweeper.cycle_error",
            error: message,
          })
        );
      })
      .finally(() => {
        isSweeping = false;
      });
  }, sweeperConfig.intervalMs);

  return handle;
}
