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
 *
 * ## Cadence rationale (mt#1898)
 *
 * The 10-minute default was set as the upper bound of mt#1260's spec range
 * ("every 5-10 minutes"), defensively rather than calibrated against measured
 * cost. mt#1898 investigated four candidate cadences (1 / 2 / 5 / 10 min) and
 * recommended keeping 10 min. The binding constraint is NOT GitHub API
 * rate-limit (even 1-min cadence stays under 20% of the 5000 req/hr App
 * installation budget) — it is a sweeper-vs-webhook double-trigger race:
 * `detectMissingReview` cannot distinguish "no review yet because runReview
 * is in-flight from a webhook" from "no review yet because a prior runReview
 * failed". At 1-2 min cadence the race fires on ~75-100% of pushes, paying
 * an OpenAI cycle AND a duplicate review comment per race. Tighter cadence
 * is safe only once mt#1907 lands an in-flight marker. See mt#1898's
 * `## Findings` for the full table and reasoning. Operators who want
 * temporary faster recovery during the mt#1897 (OpenAI timeout) investigation
 * window can set SWEEPER_INTERVAL_MS=300000 (5 min) at the Railway env-var
 * layer; revert after mt#1897 ships.
 */

import type { ReviewerConfig } from "./config";
import { parsePositiveIntEnv } from "./config";
import { createOctokit, getAppIdentity } from "./github-client";
import { runReview } from "./review-worker";
import { decideRouting, extractTierFromPRBody } from "./tier-routing";
import type { Octokit } from "@octokit/rest";
import type { ReviewerDb } from "./db/client";
import { pruneStaleMarkers, listActiveMarkersForPRs, markerKey } from "./inflight-marker";

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
  /**
   * True when `owner` was not explicitly set in the env and the default was used.
   * Surfaced in the `sweeper.started` log so operators can audit silent mis-targeting
   * risk in non-Minsky deployments. PR #1116 R1 cascade-defense (mirrors
   * merge-state-sweeper.ts).
   */
  ownerDefaulted: boolean;
  /**
   * True when `repo` was not explicitly set in the env and the default was used.
   * PR #1116 R1 cascade-defense.
   */
  repoDefaulted: boolean;
}

export function loadSweeperConfig(): SweeperConfig {
  const ownerEnv = process.env["SWEEPER_REPO_OWNER"];
  const repoEnv = process.env["SWEEPER_REPO_NAME"];
  return {
    owner: ownerEnv ?? "edobry",
    repo: repoEnv ?? "minsky",
    // Strict-positive parse (mt#1811 cascade-defense): malformed values
    // would feed NaN to setInterval. parsePositiveIntEnv throws at boot
    // time on any non-positive-integer value.
    //
    // 600_000 ms (10 min) default: see module-header "Cadence rationale" and
    // mt#1898's `## Findings`. Do not lower below 5 min without first
    // landing mt#1907 (in-flight marker) — the sweeper-vs-webhook race rate
    // climbs sharply below that cadence.
    intervalMs: parsePositiveIntEnv("SWEEPER_INTERVAL_MS", 600_000),
    enabled: (process.env["SWEEPER_ENABLED"] ?? "false") === "true",
    // PR #1116 R1 cascade-defense: surface when defaults are in effect so silent
    // mis-targeting in non-Minsky deployments produces an operator-visible signal.
    ownerDefaulted: ownerEnv === undefined,
    repoDefaulted: repoEnv === undefined,
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
  // Use optional chaining on both user and login: GitHub can return user=null
  // for deleted accounts or certain system reviews; ?? "" ensures the
  // comparison yields false rather than throwing TypeError.
  const botReviews = reviews.filter(
    (r) =>
      (r.user?.login?.toLowerCase() ?? "") === botLogin.toLowerCase() && r.state !== "DISMISSED"
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
  runReviewFn: RunReviewFn = runReview,
  db?: ReviewerDb
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
    const result = await runReviewFn(
      config,
      owner,
      repo,
      pr.number,
      pr.authorLogin,
      deliveryId,
      pr.headSha,
      db !== undefined ? { db } : undefined
    );
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
  /**
   * Optional DB instance for in-flight marker integration (mt#1907).
   * When absent, marker lookup is skipped (graceful degradation for tests
   * that don't need it).
   */
  db?: ReviewerDb;
}

/**
 * Build the real SweeperDeps from config (used in production).
 * Exported so server.ts can call it and tests can bypass it.
 *
 * Accepts an optional db parameter (mt#1907) for in-flight marker integration.
 */
export async function buildSweeperDeps(
  config: ReviewerConfig,
  db?: ReviewerDb
): Promise<SweeperDeps> {
  const octokit = await createOctokit(config);
  const botIdentity = await getAppIdentity(config);
  return { octokit, botLogin: botIdentity.login, db };
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
 * NOTE: This sweeper deliberately uses extractTierFromPRBody (body-only) instead
 * of resolveTier (MCP-aware). MCP lookups would add 1-3s per PR, ballooning
 * sweep duration on repos with many open PRs. The webhook handler is the
 * authoritative tier-resolution path; the sweeper is a body-marker safety net.
 * PRs without body markers default to Tier 2 routing here, which may be
 * skipped if tier2Enabled=false. If you need MCP-fail-closed parity, ensure
 * PR templates always include the tier marker.
 *
 * @param depsOverride Optional dependency override for tests. When provided,
 *   skips the createOctokit + getAppIdentity calls entirely.
 */
const SWEEP_CONCURRENCY = 3;

/**
 * Boot-time warning threshold for the sweeper cadence (mt#1898 PR #1154 R1).
 *
 * When `SWEEPER_INTERVAL_MS` resolves to less than this value, `startSweeper`
 * emits a structured warning naming the configured interval, the safe
 * threshold, and mt#1907 as the structural prerequisite. The threshold is the
 * floor of the "safe without an in-flight marker" band documented in mt#1898's
 * `## Findings §3`: below 5 min the sweeper-vs-webhook double-trigger race
 * rate climbs above ~30% per push.
 *
 * The warning does NOT block startup — operators can still opt into a tighter
 * cadence (e.g., during the mt#1897 OpenAI-timeout investigation window),
 * but the choice produces an operator-visible log line. This mirrors the
 * PR #1116 R1 cascade-defense convention for silent mis-targeting.
 */
const SWEEPER_LOW_INTERVAL_WARN_THRESHOLD_MS = 300_000;

export async function runSweep(
  config: ReviewerConfig,
  sweeperConfig: SweeperConfig,
  depsOverride?: SweeperDeps
): Promise<SweepResult> {
  const startedAt = new Date().toISOString();
  const { owner, repo } = sweeperConfig;

  const { octokit, botLogin, runReviewFn, db } = depsOverride ?? (await buildSweeperDeps(config));

  console.log(
    JSON.stringify({
      event: "sweeper.cycle_start",
      timestamp: startedAt,
      owner,
      repo,
      botLogin,
    })
  );

  // 0. Prune stale inflight markers (mt#1907 defense in depth).
  // Clears markers left by crashed runReview calls that never released.
  // When db is absent (tests or DB-less environments), skip gracefully.
  if (db !== undefined) {
    try {
      const pruned = await pruneStaleMarkers(db);
      if (pruned > 0) {
        console.log(
          JSON.stringify({
            event: "sweeper.pruned_stale_markers",
            count: pruned,
          })
        );
      }
    } catch (pruneErr: unknown) {
      const message = pruneErr instanceof Error ? pruneErr.message : String(pruneErr);
      console.warn(
        JSON.stringify({
          event: "sweeper.prune_stale_markers_failed",
          error: message,
        })
      );
    }
  }

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

  // 2b. Filter out PRs whose inflight marker is fresh (mt#1907).
  // A fresh marker means runReview is currently in flight from a webhook —
  // retriggering would produce a duplicate review. Skip them; they'll be
  // cleaned up by the next sweep cycle after the webhook completes.
  let filteredMissing = missing;
  if (db !== undefined && missing.length > 0) {
    try {
      const markerLookup = await listActiveMarkersForPRs(
        db,
        missing.map((m) => ({ owner, repo, prNumber: m.number, headSha: m.headSha }))
      );

      filteredMissing = missing.filter((m) => {
        const key = markerKey(owner, repo, m.number, m.headSha);
        const marker = markerLookup.get(key);
        if (marker !== undefined) {
          console.log(
            JSON.stringify({
              event: "sweeper.skipped_inflight",
              pr: m.number,
              headSha: m.headSha,
              acquired_by: marker.acquiredBy,
              delivery_id: marker.deliveryId,
              expires_at: marker.expiresAt.toISOString(),
            })
          );
          return false;
        }
        return true;
      });
    } catch (lookupErr: unknown) {
      const message = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
      console.warn(
        JSON.stringify({
          event: "sweeper.marker_lookup_failed_proceeding",
          error: message,
          missing_count: missing.length,
        })
      );
      // Fail-open: proceed with all missing PRs if lookup fails.
    }
  }

  if (filteredMissing.length > 0) {
    console.warn(
      JSON.stringify({
        event: "sweeper.primary_webhook_failing",
        message: `${filteredMissing.length} PR(s) are missing a minsky-reviewer review — the primary webhook path may be failing.`,
        missingPrNumbers: filteredMissing.map((m) => m.number),
      })
    );
  }

  // 3. Retrigger missing reviews via in-process runReview, capped at SWEEP_CONCURRENCY.
  let retriggeredCount = 0;
  for (let i = 0; i < filteredMissing.length; i += SWEEP_CONCURRENCY) {
    const batch = filteredMissing.slice(i, i + SWEEP_CONCURRENCY);
    // Schedule each in the batch. retriggerViaRunReview never throws (it
    // catch-logs internally), so we can safely await all in parallel.
    await Promise.all(
      batch.map((pr) => retriggerViaRunReview(config, owner, repo, pr, runReviewFn, db))
    );
    retriggeredCount += batch.length;
  }

  const result: SweepResult = {
    startedAt,
    prsScanned,
    missing: filteredMissing,
    retriggeredCount,
  };

  console.log(
    JSON.stringify({
      event: "sweeper.cycle_end",
      ...result,
      missingCount: filteredMissing.length,
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
  sweeperConfig: SweeperConfig,
  db?: ReviewerDb
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
      ownerDefaulted: sweeperConfig.ownerDefaulted,
      repoDefaulted: sweeperConfig.repoDefaulted,
    })
  );

  // PR #1116 R1 cascade-defense: when owner/repo were silently defaulted,
  // emit a structured warning at boot. In non-Minsky deployments this would
  // otherwise silently target edobry/minsky and never produce a high-signal
  // log line. Mirrors merge-state-sweeper.ts.
  if (sweeperConfig.ownerDefaulted || sweeperConfig.repoDefaulted) {
    console.warn(
      JSON.stringify({
        event: "sweeper.using_default_repo_coordinates",
        owner: sweeperConfig.owner,
        repo: sweeperConfig.repo,
        ownerDefaulted: sweeperConfig.ownerDefaulted,
        repoDefaulted: sweeperConfig.repoDefaulted,
        message:
          "missed-review sweeper is using default repo coordinates. " +
          "Set SWEEPER_REPO_OWNER and SWEEPER_REPO_NAME explicitly in non-Minsky deployments " +
          "to avoid silently sweeping the wrong repository.",
      })
    );
  }

  // mt#1898 PR #1154 R1 cascade-defense: warn when the configured cadence is
  // below the "safe without an in-flight marker" threshold. Below ~5 min the
  // sweeper-vs-webhook double-trigger race rate climbs above ~30% per push
  // (mt#1898 `## Findings §3`); the cost is silent (wasted OpenAI cycles +
  // duplicate review comments on PRs). The warning makes the choice
  // operator-visible at boot. Non-blocking by design — operators may want a
  // tighter cadence during the mt#1897 (OpenAI timeout) investigation window.
  if (sweeperConfig.intervalMs < SWEEPER_LOW_INTERVAL_WARN_THRESHOLD_MS) {
    console.warn(
      JSON.stringify({
        event: "sweeper.low_interval_warning",
        intervalMs: sweeperConfig.intervalMs,
        safeThresholdMs: SWEEPER_LOW_INTERVAL_WARN_THRESHOLD_MS,
        message:
          `SWEEPER_INTERVAL_MS=${sweeperConfig.intervalMs} is below the ` +
          `${SWEEPER_LOW_INTERVAL_WARN_THRESHOLD_MS} ms (5 min) safe threshold. ` +
          "Below this threshold the sweeper-vs-webhook double-trigger race " +
          "(no in-flight marker; see mt#1898 `## Findings §4`) fires on a " +
          "significant fraction of pushes, paying an OpenAI cycle AND a " +
          "duplicate review comment per race. Land mt#1907 (in-flight " +
          "marker) before tuning the cadence below this threshold.",
      })
    );
  }

  let isSweeping = false;

  // Cache a deps promise so we build octokit + botLogin once and reuse across
  // sweep cycles. The db is forwarded so runSweep can use the inflight marker.
  let cachedDeps: Promise<SweeperDeps> | null = null;

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
    // Lazily build deps on first cycle; reuse on subsequent cycles.
    if (cachedDeps === null) {
      cachedDeps = buildSweeperDeps(config, db);
    }
    cachedDeps
      .then((deps) => runSweep(config, sweeperConfig, deps))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({
            event: "sweeper.cycle_error",
            error: message,
          })
        );
        // Clear cached deps on error so next cycle retries building them.
        cachedDeps = null;
      })
      .finally(() => {
        isSweeping = false;
      });
  }, sweeperConfig.intervalMs);

  return handle;
}
