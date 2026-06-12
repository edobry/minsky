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
 * Concurrency is capped at SWEEP_CONCURRENCY simultaneous runReview calls
 * (1 post-mt#1969; was 3 pre-mt#1969 — see the SWEEP_CONCURRENCY constant
 * for rationale). Originally chosen to avoid OOM under large PR backlogs;
 * mt#1969 reduced to 1 to eliminate the per-key throughput contention class
 * that contributed to the mt#1963 triple-toolloop-timeout.
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
import {
  listOpenCircuitsForPRs,
  markCircuitAlerted,
  submissionFailureKey,
  type OpenCircuit,
} from "./submission-failure-tracker";
import { log } from "./logger";
import { extractPgErrorContext } from "./webhook-events";
import { DomainAskEmitter, makeContainerAskRepoProvider, type AskEmitter } from "./ask-emitter";
import { buildAlertSink, loadAlertSinkConfig, type AlertSink } from "./alert-sink";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

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
  log.info("sweeper.retrigger_start", {
    event: "sweeper.retrigger_start",
    deliveryId,
    pr: pr.number,
    headSha: pr.headSha,
    owner,
    repo,
  });

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
    log.info("sweeper.retrigger_success", {
      event: "sweeper.retrigger_success",
      deliveryId,
      pr: pr.number,
      headSha: pr.headSha,
      status: result.status,
      reason: result.reason,
    });
  } catch (err) {
    log.warn("sweeper.retrigger_failed", {
      event: "sweeper.retrigger_failed",
      deliveryId,
      pr: pr.number,
      headSha: pr.headSha,
      ...extractPgErrorContext(err),
    });
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
  /**
   * Optional override for the open-circuit lookup (mt#2350). Defaults to the
   * real `listOpenCircuitsForPRs`. Injected in tests to exercise the
   * circuit-breaker skip path without a real DB.
   */
  listOpenCircuitsFn?: typeof listOpenCircuitsForPRs;
  /**
   * Optional override for marking an open circuit alerted (mt#2350). Defaults
   * to the real `markCircuitAlerted`.
   */
  markCircuitAlertedFn?: typeof markCircuitAlerted;
  /**
   * Optional Ask emitter (mt#2363 / mt#1596 Phase 1). When present, a tripped
   * circuit breaker also creates an operator-routed `coordination.notify` Ask
   * so the failure surfaces on the cockpit `AsksPage`, not only as a log line.
   * When absent (tests, or a DB-less environment with no domain container),
   * the sweeper falls back to log-only behavior.
   */
  askEmitter?: AskEmitter;
  /**
   * Optional external alert sink (mt#2364 / mt#1596 Phase 2). When present, a
   * tripped circuit breaker also pushes to an external channel (Telegram /
   * webhook) so the failure reaches the principal off-cockpit / after-hours.
   * Best-effort redundancy alongside the Phase-1 Ask: sink success/failure does
   * NOT affect the `alerted` dedup mark (which stays gated on the Ask outcome).
   * `null`/absent when no sink is configured (opt-in).
   */
  alertSink?: AlertSink | null;
}

/**
 * Build the real SweeperDeps from config (used in production).
 * Exported so server.ts can call it and tests can bypass it.
 *
 * Accepts an optional db parameter (mt#1907) for in-flight marker integration.
 */
export async function buildSweeperDeps(
  config: ReviewerConfig,
  db?: ReviewerDb,
  askEmitter?: AskEmitter,
  alertSink?: AlertSink | null
): Promise<SweeperDeps> {
  const octokit = await createOctokit(config);
  const botIdentity = await getAppIdentity(config);
  return { octokit, botLogin: botIdentity.login, db, askEmitter, alertSink };
}

/**
 * Run a single sweep cycle.
 *
 * 1. Lists all open PRs.
 * 2. For each PR, checks whether minsky-reviewer[bot] has a non-dismissed
 *    review at HEAD SHA. Skips PRs whose tier routes to skip (Tier 1 or
 *    Tier 2 when tier2Enabled=false).
 * 3. For each missing PR, calls runReview directly (in-process, detached).
 *    Concurrency is capped at SWEEP_CONCURRENCY (1 post-mt#1969;
 *    was 3 pre-mt#1969 — see SWEEP_CONCURRENCY constant for rationale).
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
// mt#1969: sweeper-initiated retriggers run SEQUENTIALLY (concurrency=1).
// mt#1963 Layer 3 found that 3 concurrent retriggers all timed out on the
// 120s openai.chat.completions.create.toolloop cap — including a TINY PR
// (2 files, 8+10 lines). Diff size was not the cause; provider-side
// slowness OR per-key throughput contention was. Sequential retrigger
// removes the contention class and lets retries (mt#1969, providers.ts)
// recover individual hung calls without amplifying upstream load. The
// webhook-initiated path is unaffected — it processes 1 review per webhook
// arrival.
const SWEEP_CONCURRENCY = 1;

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

  const deps = depsOverride ?? (await buildSweeperDeps(config));
  const { octokit, botLogin, runReviewFn, db, askEmitter, alertSink } = deps;
  const listOpenCircuitsFn = deps.listOpenCircuitsFn ?? listOpenCircuitsForPRs;
  const markCircuitAlertedFn = deps.markCircuitAlertedFn ?? markCircuitAlerted;

  log.info("sweeper.cycle_start", {
    event: "sweeper.cycle_start",
    timestamp: startedAt,
    owner,
    repo,
    botLogin,
  });

  // 0. Prune stale inflight markers (mt#1907 defense in depth).
  // Clears markers left by crashed runReview calls that never released.
  // When db is absent (tests or DB-less environments), skip gracefully.
  if (db !== undefined) {
    try {
      const pruned = await pruneStaleMarkers(db);
      if (pruned > 0) {
        log.info("sweeper.pruned_stale_markers", {
          event: "sweeper.pruned_stale_markers",
          count: pruned,
        });
      }
    } catch (pruneErr: unknown) {
      log.warn("sweeper.prune_stale_markers_failed", {
        event: "sweeper.prune_stale_markers_failed",
        ...extractPgErrorContext(pruneErr),
      });
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
      log.info("skip_draft_sweeper", {
        event: "skip_draft_sweeper",
        pr: pr.number,
        owner,
        repo,
      });
      continue;
    }

    // Respect tier routing: skip PRs that decideRouting says to skip.
    // We use extractTierFromPRBody here (not the full resolveTier fallback
    // chain with MCP) because the sweeper is a lightweight background task —
    // it should not add per-PR MCP round-trips. PRs with no body marker get
    // the null tier → defaults to Tier 2 behavior. This matches the Sprint A
    // fail-open policy for sweeper context.
    const tier = extractTierFromPRBody(pr.body);
    const routing = decideRouting(tier, config.tier2Enabled);
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
      log.warn("sweeper.missing_review", {
        event: "sweeper.missing_review",
        pr: detected.number,
        headSha: detected.headSha,
        reason: detected.reason,
      });
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
          log.info("sweeper.skipped_inflight", {
            event: "sweeper.skipped_inflight",
            pr: m.number,
            headSha: m.headSha,
            acquired_by: marker.acquiredBy,
            delivery_id: marker.deliveryId,
            expires_at: marker.expiresAt.toISOString(),
          });
          return false;
        }
        return true;
      });
    } catch (lookupErr: unknown) {
      log.warn("sweeper.marker_lookup_failed_proceeding", {
        event: "sweeper.marker_lookup_failed_proceeding",
        missing_count: missing.length,
        ...extractPgErrorContext(lookupErr),
      });
      // Fail-open: proceed with all missing PRs if lookup fails.
    }
  }

  // 2c. Circuit breaker (mt#2350): drop PRs whose (PR, head_sha) has an OPEN
  // circuit from a non-retryable submission failure. Retriggering them just
  // pays another OpenAI review cycle to 422 again on submit. Emit a one-shot
  // operator alert per open circuit. Fail-open: a lookup error leaves all PRs
  // eligible (prefer an extra retrigger over blocking the whole sweep).
  if (db !== undefined && filteredMissing.length > 0) {
    let openCircuits: Map<string, OpenCircuit>;
    try {
      openCircuits = await listOpenCircuitsFn(
        db,
        filteredMissing.map((m) => ({ owner, repo, prNumber: m.number, headSha: m.headSha }))
      );
    } catch (circuitErr: unknown) {
      openCircuits = new Map();
      log.warn("sweeper.circuit_lookup_failed_proceeding", {
        event: "sweeper.circuit_lookup_failed_proceeding",
        missing_count: filteredMissing.length,
        ...extractPgErrorContext(circuitErr),
      });
    }

    if (openCircuits.size > 0) {
      // NOTE: this is an explicit await-capable loop (not `.filter()`) because
      // the alert path must await the Ask-emit OUTCOME before deciding whether
      // to mark the circuit `alerted`. See the dedup discussion below.
      const keptMissing: MissingReviewPR[] = [];
      for (const m of filteredMissing) {
        const open = openCircuits.get(submissionFailureKey(owner, repo, m.number, m.headSha));
        if (open === undefined) {
          keptMissing.push(m);
          continue;
        }

        log.warn("sweeper.circuit_open_skip", {
          event: "sweeper.circuit_open_skip",
          pr: m.number,
          headSha: m.headSha,
          errorClass: open.errorClass,
          lastStatus: open.lastStatus,
          consecutiveCount: open.consecutiveCount,
        });

        // One-shot operator alert (mt#2350 SC-5). Two surfaces, both deduped
        // via the `alerted` column so we alert at most once per open circuit:
        //   1. The structured error-level log line (the original mt#1372
        //      operator-notify surface; rotated away by deploy-churn, mt#2345).
        //   2. (mt#2363 / mt#1596 Phase 1) An operator-routed
        //      `coordination.notify` Ask, so the failure surfaces on the live
        //      cockpit `AsksPage` instead of only as a log line nothing reads.
        //
        // Dedup discipline (reviewer R1): the Ask emit is fail-open, but we must
        // NOT mark the circuit `alerted` when the emit FAILED transiently —
        // doing so would permanently suppress surfacing once the substrate
        // recovers. So we gate `markCircuitAlertedFn` on the emit OUTCOME:
        //   - "created"/"skipped" → mark alerted (success, or permanently no
        //     substrate — retrying would only spam the log).
        //   - "failed" → do NOT mark; the next sweep cycle re-emits both the
        //     log line and the Ask attempt until one lands.
        // When no emitter is wired at all (tests / log-only), preserve mt#2350's
        // alert-once semantics by marking alerted unconditionally.
        if (!open.alerted) {
          log.error("sweeper.circuit_breaker_tripped", {
            event: "sweeper.circuit_breaker_tripped",
            message: `Reviewer review submission for PR #${m.number} @ ${m.headSha} keeps failing with a non-retryable error (${open.errorClass}, status ${open.lastStatus ?? "unknown"}) after ${open.consecutiveCount} attempts; the sweeper has stopped retriggering it. Operator action required — see mt#2350 / mt#1596.`,
            pr: m.number,
            headSha: m.headSha,
            errorClass: open.errorClass,
            lastStatus: open.lastStatus,
            consecutiveCount: open.consecutiveCount,
            crossReference: "mt#1596",
          });
          // mt#2364 / mt#1596 Phase 2: also push to the external off-cockpit
          // alert sink (Telegram / webhook) so the failure reaches the principal
          // after-hours. Fire-and-forget + fail-open (notify catches internally),
          // and deliberately NOT awaited / NOT gating dedup — the sink is
          // best-effort redundancy alongside the Phase-1 cockpit Ask, which
          // remains the source-of-truth surface that drives the `alerted` mark.
          // The `Promise.resolve(...).catch` is belt-and-suspenders: the
          // AlertSink contract says notify never throws, but a future/external
          // sink that violates it must not surface as an unhandled rejection.
          void Promise.resolve(
            alertSink?.notify(
              "error",
              `Reviewer circuit-breaker tripped — PR #${m.number}`,
              `Reviewer review submission for ${owner}/${repo} PR #${m.number} @ ${m.headSha} keeps failing with a non-retryable error (${open.errorClass}, status ${open.lastStatus ?? "unknown"}) after ${open.consecutiveCount} attempts; the sweeper has stopped retriggering it. Operator action required (mt#2350 / mt#1596).`
            )
          ).catch((sinkErr: unknown) => {
            log.warn("sweeper.alert_sink_unhandled", {
              event: "sweeper.alert_sink_unhandled",
              pr: m.number,
              headSha: m.headSha,
              error: sinkErr instanceof Error ? sinkErr.message : String(sinkErr),
            });
          });
          const emitOutcome = askEmitter
            ? await askEmitter.emitCircuitBreakerAlert({
                owner,
                repo,
                prNumber: m.number,
                headSha: m.headSha,
                errorClass: open.errorClass,
                lastStatus: open.lastStatus,
                consecutiveCount: open.consecutiveCount,
                circuitId: open.id,
              })
            : "skipped";
          if (emitOutcome !== "failed") {
            await markCircuitAlertedFn(db, open.id);
          }
        }

        // PR dropped from the retrigger set (its circuit is open).
      }
      filteredMissing = keptMissing;
    }
  }

  if (filteredMissing.length > 0) {
    log.warn("sweeper.primary_webhook_failing", {
      event: "sweeper.primary_webhook_failing",
      message: `${filteredMissing.length} PR(s) are missing a minsky-reviewer review — the primary webhook path may be failing.`,
      missingPrNumbers: filteredMissing.map((m) => m.number),
    });
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

  log.info("sweeper.cycle_end", {
    event: "sweeper.cycle_end",
    ...result,
    missingCount: filteredMissing.length,
  });

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
  db?: ReviewerDb,
  container?: AppContainerInterface,
  // mt#2451: when the caller (server start) passes a pre-built sink, reuse that
  // single instance (shared with the /alert-test route). When omitted (existing
  // test callers), build one from env — preserving prior behavior.
  providedAlertSink?: AlertSink | null
): ReturnType<typeof setInterval> | null {
  if (!sweeperConfig.enabled) {
    log.info("sweeper.disabled", {
      event: "sweeper.disabled",
      message: "Sweeper is disabled (SWEEPER_ENABLED=false).",
    });
    return null;
  }

  log.info("sweeper.started", {
    event: "sweeper.started",
    intervalMs: sweeperConfig.intervalMs,
    owner: sweeperConfig.owner,
    repo: sweeperConfig.repo,
    ownerDefaulted: sweeperConfig.ownerDefaulted,
    repoDefaulted: sweeperConfig.repoDefaulted,
  });

  // PR #1116 R1 cascade-defense: when owner/repo were silently defaulted,
  // emit a structured warning at boot. In non-Minsky deployments this would
  // otherwise silently target edobry/minsky and never produce a high-signal
  // log line. Mirrors merge-state-sweeper.ts.
  if (sweeperConfig.ownerDefaulted || sweeperConfig.repoDefaulted) {
    log.warn("sweeper.using_default_repo_coordinates", {
      event: "sweeper.using_default_repo_coordinates",
      owner: sweeperConfig.owner,
      repo: sweeperConfig.repo,
      ownerDefaulted: sweeperConfig.ownerDefaulted,
      repoDefaulted: sweeperConfig.repoDefaulted,
      message:
        "missed-review sweeper is using default repo coordinates. " +
        "Set SWEEPER_REPO_OWNER and SWEEPER_REPO_NAME explicitly in non-Minsky deployments " +
        "to avoid silently sweeping the wrong repository.",
    });
  }

  // mt#1898 PR #1154 R1 cascade-defense: warn when the configured cadence is
  // below the "safe without an in-flight marker" threshold. Below ~5 min the
  // sweeper-vs-webhook double-trigger race rate climbs above ~30% per push
  // (mt#1898 `## Findings §3`); the cost is silent (wasted OpenAI cycles +
  // duplicate review comments on PRs). The warning makes the choice
  // operator-visible at boot. Non-blocking by design — operators may want a
  // tighter cadence during the mt#1897 (OpenAI timeout) investigation window.
  if (sweeperConfig.intervalMs < SWEEPER_LOW_INTERVAL_WARN_THRESHOLD_MS) {
    log.warn("sweeper.low_interval_warning", {
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
    });
  }

  let isSweeping = false;

  // mt#2363 / mt#1596 Phase 1: build the Ask emitter from the booted domain
  // container (the mt#2121 direct-domain-import path). When no container is
  // wired (DB-less / degraded boot), the emitter's repo provider returns null
  // and the sweeper falls back to log-only behavior.
  const askEmitter = new DomainAskEmitter(makeContainerAskRepoProvider(container));

  // mt#2364 / mt#1596 Phase 2: the external off-cockpit alert sink. Opt-in
  // (ALERT_SINK_TYPE); null when unset/off, in which case the sweeper falls back
  // to log + the Phase-1 cockpit Ask only. mt#2451: reuse the shared instance
  // passed from server start; build from env only when not provided (test path).
  const alertSink =
    providedAlertSink !== undefined ? providedAlertSink : buildAlertSink(loadAlertSinkConfig());

  // Cache a deps promise so we build octokit + botLogin once and reuse across
  // sweep cycles. The db is forwarded so runSweep can use the inflight marker.
  let cachedDeps: Promise<SweeperDeps> | null = null;

  const handle = setInterval(() => {
    if (isSweeping) {
      log.warn("sweeper.skip_reentrant", {
        event: "sweeper.skip_reentrant",
        message: "Previous sweep still in progress; skipping this interval tick.",
      });
      return;
    }
    isSweeping = true;
    // Lazily build deps on first cycle; reuse on subsequent cycles.
    if (cachedDeps === null) {
      cachedDeps = buildSweeperDeps(config, db, askEmitter, alertSink);
    }
    cachedDeps
      .then((deps) => runSweep(config, sweeperConfig, deps))
      .catch((err) => {
        log.error("sweeper.cycle_error", {
          event: "sweeper.cycle_error",
          ...extractPgErrorContext(err),
        });
        // Clear cached deps on error so next cycle retries building them.
        cachedDeps = null;
      })
      .finally(() => {
        isSweeping = false;
      });
  }, sweeperConfig.intervalMs);

  return handle;
}
