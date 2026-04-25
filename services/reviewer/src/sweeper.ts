/**
 * Periodic sweeper for minsky-reviewer[bot].
 *
 * Safety-net layer behind the primary webhook path (mt#1258 ack-immediate
 * refactor). Lists open PRs, identifies any whose HEAD SHA has no
 * corresponding minsky-reviewer review, and retriggers via the GitHub App
 * webhook delivery redeliver API.
 *
 * ## Retrigger strategy: GitHub App webhook redeliver API (option a)
 *
 * Chosen because it exercises the full normal handler path — the same
 * signature verification, payload parsing, and runReview logic that the
 * primary webhook invokes. This is cleaner than importing runReview directly
 * (option b) because it avoids duplicating the App-auth setup inside the
 * sweeper and ensures any future changes to the webhook handler (e.g.,
 * idempotency guard in mt#1258) automatically apply to retriggers.
 *
 * Fallback: if the delivery redeliver API is unavailable (e.g., insufficient
 * App permissions or no matching delivery found), a WARN is logged and the PR
 * is counted as "retriggered" in the sense that the sweeper tried but failed
 * non-fatally. This is intentional — the sweeper is a best-effort safety net,
 * not a hard guarantee.
 *
 * ## Schedule wiring: in-process setInterval
 *
 * Chosen over a Railway scheduled cron entry-point for simplicity: no second
 * Railway service to provision, no separate entry-point binary, and the
 * sweeper shares the same octokit / config the server already has. The
 * interval (5 min) is configurable via SWEEPER_INTERVAL_MS. To disable the
 * sweeper entirely, set SWEEPER_ENABLED=false.
 */

import { Octokit } from "@octokit/rest";
import type { ReviewerConfig } from "./config";
import { createOctokit, getAppIdentity } from "./github-client";
import { decideRouting, extractTierFromPRBody } from "./tier-routing";

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
    intervalMs: parseInt(process.env["SWEEPER_INTERVAL_MS"] ?? "300000", 10),
    enabled: (process.env["SWEEPER_ENABLED"] ?? "true") !== "false",
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
  /** Number of PRs where retrigger was attempted. */
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
): Promise<Array<{ number: number; headSha: string; body: string }>> {
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
  }));
}

/**
 * Fetch all reviews for a PR and find whether minsky-reviewer[bot] has
 * reviewed at the current HEAD SHA.
 *
 * Returns:
 *   - null when a review by the bot at the current headSha exists.
 *   - A MissingReviewPR when no review or only stale reviews exist.
 */
export async function detectMissingReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  botLogin: string
): Promise<MissingReviewPR | null> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const botReviews = reviews.filter((r) => r.user?.login.toLowerCase() === botLogin.toLowerCase());

  if (botReviews.length === 0) {
    return {
      number: prNumber,
      headSha,
      reason: "no_review_by_bot",
    };
  }

  // Bot has reviewed this PR — check whether any review targets the current HEAD SHA.
  const hasReviewAtHead = botReviews.some((r) => r.commit_id === headSha);

  if (!hasReviewAtHead) {
    return {
      number: prNumber,
      headSha,
      reason: "commit_id_mismatch",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Retrigger logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Find the most recent webhook delivery for a given PR number, then redeliver it.
 *
 * Uses the GitHub App webhook delivery list endpoint, filters for
 * `pull_request` event deliveries whose payload matches the given PR number,
 * and redelivers the most recent one.
 *
 * This drives the delivery through the normal handler path, including
 * signature verification and idempotency guards (mt#1258).
 *
 * Returns true when a delivery was found and redelivered; false when no
 * matching delivery was found (no retrigger attempted).
 */
export async function retriggerViaPRDelivery(octokit: Octokit, prNumber: number): Promise<boolean> {
  // List recent webhook deliveries for the App.
  // The API returns at most 250 deliveries. We page through to find the most
  // recent one matching our PR.
  const deliveries = await octokit.paginate(octokit.rest.apps.listWebhookDeliveries, {
    per_page: 100,
  });

  // Filter for pull_request event deliveries.
  const prDeliveries = deliveries
    .filter((d) => d.event === "pull_request")
    .sort((a, b) => {
      // Sort by delivered_at descending (most recent first).
      const aTime = new Date(a.delivered_at ?? 0).getTime();
      const bTime = new Date(b.delivered_at ?? 0).getTime();
      return bTime - aTime;
    });

  // We need to inspect each delivery to find one for our PR number.
  // The list endpoint only returns summary data (no payload). We fetch
  // details for each candidate until we find a match.
  for (const delivery of prDeliveries) {
    const detail = await octokit.rest.apps.getWebhookDelivery({ delivery_id: delivery.id });
    const payload = detail.data.request?.payload;
    if (!payload) continue;

    let parsed: unknown;
    try {
      parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    } catch {
      continue;
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pull_request" in parsed &&
      typeof (parsed as Record<string, unknown>)["pull_request"] === "object" &&
      (parsed as Record<string, Record<string, unknown>>)["pull_request"]["number"] === prNumber
    ) {
      // Found a matching delivery — redeliver it.
      await octokit.rest.apps.redeliverWebhookDelivery({ delivery_id: delivery.id });
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Sweeper cycle
// ---------------------------------------------------------------------------

/** Dependencies injectable for tests. */
export interface SweeperDeps {
  octokit: Octokit;
  botLogin: string;
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
 * 2. For each PR, checks whether minsky-reviewer[bot] has a review at HEAD SHA.
 *    Skips PRs whose tier routes to skip (Tier 1 or Tier 2 when tier2Enabled=false).
 * 3. For each missing PR, retriggers via the webhook delivery redeliver API.
 * 4. Returns a SweepResult with cycle metrics.
 *
 * @param depsOverride Optional dependency override for tests. When provided,
 *   skips the createOctokit + getAppIdentity calls entirely.
 */
export async function runSweep(
  config: ReviewerConfig,
  sweeperConfig: SweeperConfig,
  depsOverride?: SweeperDeps
): Promise<SweepResult> {
  const startedAt = new Date().toISOString();
  const { owner, repo } = sweeperConfig;

  const { octokit, botLogin } = depsOverride ?? (await buildSweeperDeps(config));

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
      botLogin
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

  // 3. Retrigger missing reviews.
  let retriggeredCount = 0;
  for (const pr of missing) {
    try {
      const delivered = await retriggerViaPRDelivery(octokit, pr.number);
      if (delivered) {
        retriggeredCount++;
        console.log(
          JSON.stringify({
            event: "sweeper.retrigger_success",
            pr: pr.number,
            headSha: pr.headSha,
          })
        );
      } else {
        console.warn(
          JSON.stringify({
            event: "sweeper.retrigger_no_delivery_found",
            pr: pr.number,
            headSha: pr.headSha,
            message:
              "No matching webhook delivery found for this PR. Manual review may be required.",
          })
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        JSON.stringify({
          event: "sweeper.retrigger_failed",
          pr: pr.number,
          headSha: pr.headSha,
          error: message,
        })
      );
    }
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
 * 5 min). Disable entirely with SWEEPER_ENABLED=false.
 *
 * The first sweep runs after one full interval — not immediately at boot —
 * to avoid competing with the service startup sequence.
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

  const handle = setInterval(() => {
    runSweep(config, sweeperConfig).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          event: "sweeper.cycle_error",
          error: message,
        })
      );
    });
  }, sweeperConfig.intervalMs);

  return handle;
}
