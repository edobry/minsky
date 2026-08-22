/**
 * Periodic PR-watch scheduler for the reviewer service.
 *
 * Runs `runWatcher` on a configurable `setInterval` so that registered PR
 * watches fire automatically without manual operator action. Follows the same
 * in-process setInterval pattern established by the sweeper (mt#1260) in
 * sweeper.ts.
 *
 * ## Why service-internal setInterval (Tier 1)
 *
 * Three tiers were considered:
 *   Tier 0 — Claude Code `CronCreate` (operator-scoped, ephemeral, disappears
 *             on session end — not suitable for production fire path).
 *   Tier 1 — service-internal `setInterval` in the reviewer service (chosen).
 *             The reviewer is already running 24/7 with the sweeper precedent;
 *             folding pr-watch's scheduler here avoids a second service and
 *             shares the same auth config.
 *   Tier 2 — webhook-driven push (over-architecting for current scope; no
 *             ordering / fan-out / backpressure requirement to justify it).
 *
 * ## Configuration
 *
 * - `PR_WATCH_POLL_INTERVAL_MS` — poll interval (default: 60 000 ms / 1 min).
 *   Set lower for active iteration windows; 60 s covers the "within one
 *   polling interval" acceptance test criterion.
 * - `PR_WATCH_ENABLED` — set to `"false"` to disable. **Enabled by default
 *   post-mt#1899.** mt#1618 originally shipped this OFF because the
 *   agent-context delivery path (`WakeSignalSink` → `wake_pending` →
 *   `enrichWakeResponse`) was not yet wired; once mt#1725 + mt#1755 closed
 *   that gap, no commit revisited the default. mt#1899's investigation found
 *   no remaining blocker, so the default was flipped to match the
 *   sweeper convention (`SWEEPER_ENABLED` / `MERGE_STATE_SWEEPER_ENABLED`
 *   defaults — see services/reviewer/deploy.config.ts).
 *
 * ## Invocation mechanism
 *
 * The scheduler calls `runWatcher()` from `@minsky/domain/pr-watch/watcher`
 * directly via domain imports, bypassing the MCP-over-HTTP path entirely.
 * This removes the network hop and the need for MINSKY_MCP_URL / MINSKY_MCP_AUTH_TOKEN.
 * The watcher is instantiated with a `DrizzlePrWatchRepository` (from the
 * domain container's persistence provider), a `makeProductionGithubPrClient`
 * backed by THIS SERVICE'S OWN GitHub App token (mt#4435 — see
 * `github-token-provider.ts`), and a `SystemOperatorNotify`.
 *
 * Until mt#4435 this paragraph claimed the client was "backed by the Minsky
 * implementer GitHub App token." That was the INTENT and never the behavior:
 * the code read the domain config's `github.serviceAccount`, which is populated
 * from a `MINSKY_APP_*` namespace this service does not set, so the provider
 * fell through to an empty token and every call went out unauthenticated. The
 * claim is recorded here rather than deleted because a docblock asserting
 * App-authentication is exactly what made the defect invisible for as long as
 * it lasted.
 *
 * ## Rate-limit posture (PR #1153 R1)
 *
 * Per-tick cost when zero active watches: ONE Postgres SELECT (the
 * `runWatcher` for-loop iterates over `prWatchRepository.listActive()` and
 * simply doesn't execute when the list is empty — no GitHub API calls).
 *
 * Per-tick cost when N active watches: 1 DB SELECT + N × 3 GitHub API calls
 * (`getPr` + `listReviews` + `listCheckRuns`). At the default 60s cadence
 * with the 5000-req/hour GitHub App rate limit, this floor is ~111 watches
 * before the per-instance load saturates the App's rate budget (assuming
 * one App-token-per-installation). The watches are scoped to operator-
 * registered PRs, so steady-state N is typically <10. The reviewer GitHub
 * App's token is distinct from the implementer App's token, so this load
 * does not compete with the implementer's PR-create / review-post traffic.
 *
 * **This budget analysis only became true with mt#4435.** It reasons about the
 * 5000/hour App allowance, and until that fix the scheduler authenticated with
 * nothing at all — so the real ceiling was GitHub's UNAUTHENTICATED 60/hour
 * per-IP budget, which 2 active watches at a 60s cadence exhaust in about ten
 * minutes. The arithmetic above was sound and the premise underneath it was
 * wrong, which is the more dangerous half.
 *
 * To avoid thundering-herd alignment when multiple reviewer instances run
 * in parallel (staging + production, or a future horizontal-scale-out), each
 * instance jitters its tick interval by `Math.random() × JITTER_FRACTION ×
 * intervalMs` (default 10%) at startup. Computed once per instance, so the
 * cadence is stable but instances drift apart over time and dilute any
 * wall-clock alignment they started with.
 *
 * @see mt#1618 — Invocation path wiring for mt#1295 PR-watch subsystem.
 * @see mt#1899 — Default flipped from OFF to ON post-mt#1725 delivery wiring.
 * @see mt#2121 — migrated from MCP-over-HTTP to direct domain imports.
 */

import type { ReviewerConfig } from "./config";
import { parsePositiveIntEnv } from "./config";
import {
  createReviewerTokenProvider,
  findMissingReviewerCredentials,
} from "./github-token-provider";
import { log } from "./logger";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Per-instance interval jitter as a fraction of `intervalMs` (PR #1153 R1).
 *
 * Each instance computes `Math.random() * JITTER_FRACTION * intervalMs` at
 * startup and adds it to the configured interval. Default 10% — at 60s
 * cadence this spreads parallel instances across a 6-second window, so they
 * don't all hit GitHub on the same wall-clock second.
 */
const JITTER_FRACTION = 0.1;

/**
 * Consecutive total-failure cycles before the scheduler escalates once (mt#4435).
 *
 * Grounded in the originating incident's observed cadence rather than a round
 * number: the 2026-08-22 window showed 9 consecutive fully-failing cycles over
 * ~12 minutes with nothing surfacing. Three cycles (~3 minutes at the default
 * 60s cadence) is long enough that a single transient GitHub blip does not page,
 * and short enough that a systemic fault is visible in minutes instead of never.
 */
const TOTAL_FAILURE_ESCALATION_THRESHOLD = 3;

/**
 * Upper bound on skipped ticks during total-failure backoff.
 *
 * At the default 60s cadence this caps the backoff at ~30 minutes, so a
 * scheduler that backed off still re-probes twice within GitHub's hourly
 * rate-limit reset window rather than idling until the process restarts.
 */
const MAX_BACKOFF_SKIP_TICKS = 30;

/**
 * Decide how the scheduler should react to one cycle's outcome.
 *
 * Pure function over (previous streak, cycle result) so the backoff and
 * escalation policy is testable directly, without driving a timer or patching
 * a collaborator — the decision is the observable, per
 * `testing-standards.mdc §Testable Design`.
 *
 * A **total failure** is a cycle where every inspected watch errored, or where
 * the domain call itself failed. That is the discriminator between "one watch
 * points at a deleted PR" (routine, per-watch, already logged) and a systemic
 * fault — an exhausted rate-limit budget, a revoked credential, GitHub down.
 * Only the latter should change polling behavior.
 *
 * A cycle that inspected ZERO watches is not a failure: with no active watches
 * `runWatcher` makes no GitHub calls at all, so it carries no evidence either
 * way and must not accumulate a streak.
 */
export function evaluateCycleOutcome(
  consecutiveTotalFailures: number,
  result: Pick<PrWatchRunResult, "success" | "inspected" | "errors">
): { consecutiveTotalFailures: number; escalate: boolean; skipTicks: number } {
  const inspected = result.inspected ?? 0;
  const errors = result.errors ?? 0;
  const isTotalFailure = !result.success || (inspected > 0 && errors === inspected);

  if (!isTotalFailure) {
    return { consecutiveTotalFailures: 0, escalate: false, skipTicks: 0 };
  }

  const streak = consecutiveTotalFailures + 1;

  return {
    consecutiveTotalFailures: streak,
    // Strict equality, not >=: escalate exactly once when the streak crosses
    // the threshold. A fault that persists for hours should not re-page every
    // cycle — the backoff below is what carries the ongoing response.
    escalate: streak === TOTAL_FAILURE_ESCALATION_THRESHOLD,
    skipTicks: Math.min(2 ** (streak - 1), MAX_BACKOFF_SKIP_TICKS),
  };
}

// ---------------------------------------------------------------------------
// Public configuration interface
// ---------------------------------------------------------------------------

export interface PrWatchSchedulerConfig {
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Whether the scheduler is enabled. */
  enabled: boolean;
}

export function loadPrWatchSchedulerConfig(): PrWatchSchedulerConfig {
  return {
    // Strict-positive parse (mt#1811 cascade-defense): malformed values would
    // feed NaN to setInterval. parsePositiveIntEnv throws at boot time.
    intervalMs: parsePositiveIntEnv("PR_WATCH_POLL_INTERVAL_MS", 60_000),
    // mt#1899: default flipped to "true". The agent-context delivery path
    // (mt#1725 WakeSignalSink + mt#1755 pr.watch.list session filter) is
    // wired end-to-end, so the original OFF default no longer reflects any
    // operational constraint. Set PR_WATCH_ENABLED=false to disable locally
    // (e.g., during dev to avoid polling GitHub from a workstation).
    enabled: (process.env["PR_WATCH_ENABLED"] ?? "true") === "true",
  };
}

// ---------------------------------------------------------------------------
// Domain call helper
// ---------------------------------------------------------------------------

interface PrWatchRunResult {
  success: boolean;
  inspected?: number;
  fired?: number;
  /**
   * Count of watches that errored this cycle.
   *
   * Consumed — not merely logged — by the total-failure backoff in
   * `startPrWatchScheduler`: `errors === inspected && inspected > 0` is the
   * signature of a systemic fault (an exhausted rate-limit budget, a revoked
   * credential, GitHub down) rather than one bad watch, and it changes the
   * scheduler's polling behavior. Before mt#4435 `runWatcher` already counted
   * these and every caller dropped the number, which is why a fully-failing
   * scheduler still logged `poll_complete` every cycle.
   */
  errors?: number;
  error?: string;
}

/**
 * Run one pr-watch pass via domain imports.
 *
 * Builds a `DrizzlePrWatchRepository` from the persistence provider,
 * creates a `makeProductionGithubPrClient` backed by the reviewer service's own
 * GitHub App token (mt#4435), and calls `runWatcher()` directly.
 *
 * Errors are caught and returned as `{ success: false }` — the scheduler is
 * a best-effort background task; a single failed call must not crash the
 * reviewer service.
 *
 * @see mt#2121 — migrated from MCP-over-HTTP to direct domain imports.
 */
async function runPrWatchDomain(
  container: AppContainerInterface,
  config: ReviewerConfig
): Promise<PrWatchRunResult> {
  try {
    const { DrizzlePrWatchRepository } = await import("@minsky/domain/pr-watch/repository");
    const { runWatcher } = await import("@minsky/domain/pr-watch/watcher");
    const { makeProductionGithubPrClient } = await import("@minsky/domain/pr-watch/github-client");
    const { SystemOperatorNotify } = await import("@minsky/domain/notify/operator-notify");
    const { CompositeWakeSignalSink, LoggingWakeSignalSink, PersistentWakeSignalSink } =
      await import("@minsky/domain/ask/wake-on-respond");
    const { DrizzleWakePendingRepository } = await import(
      "@minsky/domain/ask/wake-pending-repository"
    );

    const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
    const db = await persistenceProvider.getDatabaseConnection();
    if (!db) {
      return { success: false, error: "No database connection available" };
    }

    const prWatchRepository = new DrizzlePrWatchRepository(db);

    // mt#4435: authenticate as THIS service's own GitHub App. The previous
    // `createTokenProvider(cfg.github ?? {}, cfg.github?.token ?? "")` read the
    // DOMAIN config's `github.serviceAccount`, which is populated from the
    // `MINSKY_APP_*` namespace this service does not provision — so it fell
    // through to an empty token and every request went out unauthenticated
    // against GitHub's 60/hour per-IP budget. See github-token-provider.ts.
    const tokenProvider = createReviewerTokenProvider(config);
    const githubClient = makeProductionGithubPrClient(tokenProvider);

    const operatorNotify = new SystemOperatorNotify();

    // Build composite wake sink (logging + persistent)
    const sinks: import("@minsky/domain/ask/wake-on-respond").WakeSignalSink[] = [
      new LoggingWakeSignalSink(),
    ];
    try {
      sinks.push(new PersistentWakeSignalSink(new DrizzleWakePendingRepository(db)));
    } catch (err: unknown) {
      log.warn("pr_watch_scheduler.wake_sink_init_error", {
        event: "pr_watch_scheduler.wake_sink_init_error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const wakeSink = new CompositeWakeSignalSink(sinks);

    const watcherResult = await runWatcher(
      prWatchRepository,
      githubClient,
      operatorNotify,
      wakeSink
    );
    return {
      success: true,
      inspected: watcherResult.inspected,
      fired: watcherResult.fired,
      errors: watcherResult.errors,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Error text goes in the log MESSAGE, not only attributes: Railway's log
    // surface displays and searches message text only, so attribute-only
    // errors are invisible there (mt#2463).
    log.error(`pr_watch_scheduler.domain_call_error: ${message}`, {
      event: "pr_watch_scheduler.domain_call_error",
      error: message,
    });
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Scheduler (in-process setInterval)
// ---------------------------------------------------------------------------

/**
 * Start the PR-watch scheduler on an in-process interval.
 *
 * Chosen over a Railway cron entry-point for simplicity: the reviewer service
 * is already running 24/7 and this scheduler shares the same process.
 * Configurable via `PR_WATCH_POLL_INTERVAL_MS` (default: 60 s). **Enabled by
 * default post-mt#1899**; set `PR_WATCH_ENABLED=false` to disable (e.g.,
 * local dev workstation).
 *
 * A reentrancy guard (`isRunning`) prevents overlapping calls if a poll cycle
 * takes longer than the interval.
 *
 * The first poll runs after one full interval — not immediately — to avoid
 * competing with service startup initialization.
 *
 * @returns the timer handle (so callers can `clearInterval` in tests), or
 *   `null` when disabled or when the domain container is unavailable.
 *
 * @see mt#2121 — migrated from MCP-over-HTTP to direct domain imports.
 */
export function startPrWatchScheduler(
  config: ReviewerConfig,
  schedulerConfig: PrWatchSchedulerConfig,
  container?: AppContainerInterface
): ReturnType<typeof setInterval> | null {
  if (!schedulerConfig.enabled) {
    log.info("pr_watch_scheduler.disabled", {
      event: "pr_watch_scheduler.disabled",
      message: "PR-watch scheduler is disabled (PR_WATCH_ENABLED=false).",
    });
    return null;
  }

  if (!container) {
    log.warn("pr_watch_scheduler.missing_domain_container", {
      event: "pr_watch_scheduler.missing_domain_container",
      message:
        "PR-watch scheduler is enabled but domain container not injected. " +
        "PR-watch scheduler will not start. Set PR_WATCH_ENABLED=false to silence this warning.",
    });
    return null;
  }

  log.info("pr_watch_scheduler.started", {
    event: "pr_watch_scheduler.started",
    intervalMs: schedulerConfig.intervalMs,
  });

  // mt#4435: fail LOUD at startup rather than degrading silently per-cycle.
  // These credentials are `requireEnv`-mandatory in config.ts, so this normally
  // cannot fire — but `parseInt` yields NaN for a non-numeric value and a key
  // can be present-but-empty, and either would otherwise surface only as opaque
  // 401s inside a background loop nobody reads.
  const missingCredentials = findMissingReviewerCredentials(config);
  if (missingCredentials.length > 0) {
    log.error(`pr_watch_scheduler.missing_github_credentials: ${missingCredentials.join(", ")}`, {
      event: "pr_watch_scheduler.missing_github_credentials",
      missing: missingCredentials,
      message:
        "PR-watch scheduler cannot authenticate to GitHub and will NOT start. " +
        "Unauthenticated polling exhausts GitHub's 60/hour per-IP budget within the hour.",
    });
    return null;
  }

  let isRunning = false;

  /** Consecutive cycles in which every inspected watch failed (mt#4435). */
  let consecutiveTotalFailures = 0;
  /** Remaining ticks to skip while backing off from a total-failure streak. */
  let ticksToSkip = 0;

  // Per-instance interval jitter (PR #1153 R1): when multiple reviewer
  // instances run in parallel (staging + production, or horizontal scale-out)
  // they shouldn't all hit GitHub on the same wall-clock second. Each
  // instance computes its own random jitter in [0, JITTER_FRACTION) ×
  // intervalMs at startup, added to the base interval. Over time the
  // instances drift apart and natural spreading dilutes thundering-herd
  // alignment. Computed once — subsequent ticks use the same jittered value.
  const jitterMs = Math.random() * JITTER_FRACTION * schedulerConfig.intervalMs;
  const effectiveIntervalMs = schedulerConfig.intervalMs + jitterMs;

  const handle = setInterval(() => {
    if (isRunning) {
      log.warn("pr_watch_scheduler.skip_reentrant", {
        event: "pr_watch_scheduler.skip_reentrant",
        message: "Previous PR-watch poll still in progress; skipping this interval tick.",
      });
      return;
    }

    // mt#4435: back off while every watch is failing. Re-polling a systemic
    // fault at full cadence is what turned an exhausted rate-limit budget into
    // 18 identical errors in 41 minutes.
    if (ticksToSkip > 0) {
      ticksToSkip -= 1;
      return;
    }

    isRunning = true;

    runPrWatchDomain(container, config)
      .then((result) => {
        if (result.success) {
          log.info("pr_watch_scheduler.poll_complete", {
            event: "pr_watch_scheduler.poll_complete",
            inspected: result.inspected ?? 0,
            fired: result.fired ?? 0,
            errors: result.errors ?? 0,
          });
        }
        // Per-watch errors are already logged inside runWatcher; this decides
        // what the SCHEDULER does about a cycle in which they were total.
        const outcome = evaluateCycleOutcome(consecutiveTotalFailures, result);
        consecutiveTotalFailures = outcome.consecutiveTotalFailures;
        ticksToSkip = outcome.skipTicks;

        if (outcome.escalate) {
          log.error(
            "pr_watch_scheduler.all_watches_failing: every active PR watch has failed for " +
              `${outcome.consecutiveTotalFailures} consecutive cycles`,
            {
              event: "pr_watch_scheduler.all_watches_failing",
              consecutiveCycles: outcome.consecutiveTotalFailures,
              inspected: result.inspected ?? 0,
              errors: result.errors ?? 0,
              lastError: result.error,
              message:
                "PR-watch is delivering nothing. Common causes: GitHub rate-limit " +
                "exhaustion, a revoked or expired App installation, or GitHub being down.",
            }
          );
        }
      })
      .catch((err: unknown) => {
        // Unreachable: runPrWatchDomain catches internally. Belt-and-suspenders.
        const message = err instanceof Error ? err.message : String(err);
        log.error("pr_watch_scheduler.unexpected_error", {
          event: "pr_watch_scheduler.unexpected_error",
          error: message,
        });
      })
      .finally(() => {
        isRunning = false;
      });
  }, effectiveIntervalMs);

  return handle;
}
