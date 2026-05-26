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
 * backed by the Minsky implementer GitHub App token, and a `SystemOperatorNotify`.
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
  error?: string;
}

/**
 * Run one pr-watch pass via domain imports.
 *
 * Builds a `DrizzlePrWatchRepository` from the persistence provider,
 * creates a `makeProductionGithubPrClient` backed by the Minsky implementer
 * GitHub App token, and calls `runWatcher()` directly.
 *
 * Errors are caught and returned as `{ success: false }` — the scheduler is
 * a best-effort background task; a single failed call must not crash the
 * reviewer service.
 *
 * @see mt#2121 — migrated from MCP-over-HTTP to direct domain imports.
 */
async function runPrWatchDomain(container: AppContainerInterface): Promise<PrWatchRunResult> {
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
    const { getConfiguration } = await import("@minsky/domain/configuration/index");
    const { createTokenProvider } = await import("@minsky/domain/auth");

    const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
    const db = await persistenceProvider.getDatabaseConnection();
    if (!db) {
      return { success: false, error: "No database connection available" };
    }

    const prWatchRepository = new DrizzlePrWatchRepository(db);

    const cfg = getConfiguration();
    const userToken = cfg.github?.token ?? "";
    const tokenProvider = createTokenProvider(cfg.github ?? {}, userToken);
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
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("pr_watch_scheduler.domain_call_error", {
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

  // Suppress unused variable warning — config is held for future use
  void config;

  let isRunning = false;

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
    isRunning = true;

    runPrWatchDomain(container)
      .then((result) => {
        if (result.success) {
          log.info("pr_watch_scheduler.poll_complete", {
            event: "pr_watch_scheduler.poll_complete",
            inspected: result.inspected ?? 0,
            fired: result.fired ?? 0,
          });
        }
        // Errors are already logged inside runPrWatchDomain.
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
