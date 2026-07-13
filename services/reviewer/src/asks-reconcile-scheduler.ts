/**
 * Periodic Asks-reconcile scheduler for the reviewer service.
 *
 * Runs `reconcile()` on a configurable `setInterval` so that registered
 * quality.review Asks transition to `responded` automatically — without
 * requiring a human or agent to manually invoke `asks_reconcile`. Follows the
 * same in-process setInterval pattern established by the sweeper (mt#1260) in
 * sweeper.ts and the PR-watch scheduler (mt#1618) in pr-watch-scheduler.ts.
 *
 * ## Why service-internal setInterval (Tier 1)
 *
 * Three tiers were considered:
 *   Tier 0 — Claude Code `CronCreate` (operator-scoped, ephemeral, disappears
 *             on session end — not suitable for production fire path).
 *   Tier 1 — service-internal `setInterval` in the reviewer service (chosen).
 *             The reviewer is already running 24/7 with the sweeper and pr-watch
 *             scheduler precedents; folding asks-reconcile's scheduler here avoids
 *             a second service and shares the same auth config.
 *   Tier 2 — webhook-driven push (over-architecting for current scope; no
 *             ordering / fan-out / backpressure requirement to justify it).
 *
 * ## Configuration
 *
 * - `ASKS_RECONCILE_POLL_INTERVAL_MS` — poll interval (default: 30 000 ms / 30 s).
 *   30 s chosen because review-iteration windows are typically 30s–2min; 30 s
 *   covers the "within ≤ 1 polling interval" acceptance test criterion for
 *   active iteration. Operators can set higher values for quieter deployments.
 * - `ASKS_RECONCILE_ENABLED` — set to `"true"` to activate (disabled by default).
 *
 * ## Invocation mechanism
 *
 * The scheduler calls `reconcile()` from `@minsky/domain/ask/reconciler`
 * directly via domain imports, bypassing the MCP-over-HTTP path entirely.
 * A `DrizzleAskRepository` is built from the domain container's persistence
 * provider; a `makeProductionGithubReviewClient` is constructed from the
 * Minsky implementer GitHub App token; `SystemOperatorNotify` is used for
 * notifications.
 *
 * @see mt#1636 — Invocation path wiring for asks.reconcile (sibling to mt#1618).
 * @see mt#2121 — migrated from MCP-over-HTTP to direct domain imports.
 */

import type { ReviewerConfig } from "./config";
import { parsePositiveIntEnv } from "./config";
import { log } from "./logger";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

// ---------------------------------------------------------------------------
// Public configuration interface
// ---------------------------------------------------------------------------

export interface AsksReconcileSchedulerConfig {
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Whether the scheduler is enabled. */
  enabled: boolean;
}

export function loadAsksReconcileSchedulerConfig(): AsksReconcileSchedulerConfig {
  return {
    // Strict-positive parse (mt#1811 cascade-defense): malformed values would
    // feed NaN to setInterval. parsePositiveIntEnv throws at boot time.
    intervalMs: parsePositiveIntEnv("ASKS_RECONCILE_POLL_INTERVAL_MS", 30_000),
    enabled: (process.env["ASKS_RECONCILE_ENABLED"] ?? "false") === "true",
  };
}

// ---------------------------------------------------------------------------
// Domain call helper
// ---------------------------------------------------------------------------

interface AsksReconcileResult {
  success: boolean;
  inspected?: number;
  responded?: number;
  errors?: number;
  error?: string;
}

/**
 * Run one asks-reconcile pass via domain imports.
 *
 * Builds a `DrizzleAskRepository` from the persistence provider, creates a
 * `makeProductionGithubReviewClient` backed by the Minsky implementer GitHub
 * App token, and calls `reconcile()` directly.
 *
 * Errors are caught and returned as `{ success: false }` — the scheduler is
 * a best-effort background task; a single failed call must not crash the
 * reviewer service.
 *
 * @see mt#2121 — migrated from MCP-over-HTTP to direct domain imports.
 */
async function runAsksReconcileDomain(
  container: AppContainerInterface
): Promise<AsksReconcileResult> {
  try {
    const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");
    const { reconcile } = await import("@minsky/domain/ask/reconciler");
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

    const repo = new DrizzleAskRepository(db);

    const cfg = getConfiguration();
    const userToken = cfg.github?.token ?? "";
    const tokenProvider = createTokenProvider(cfg.github ?? {}, userToken);

    // Build a GithubReviewClient inline using domain list-reviews infrastructure.
    // This replicates makeProductionGithubReviewClient from
    // src/adapters/shared/commands/asks-github-client.ts — that file lives in
    // the main Minsky package which the reviewer service does not depend on.
    const { listReviews } = await import("@minsky/domain/repository/github-pr-review");
    const githubClient: import("@minsky/domain/ask/reconciler").GithubReviewClient = {
      async listReviews(owner: string, repo: string, prNumber: number) {
        const gh = {
          owner,
          repo,
          getToken: () => tokenProvider.getServiceToken(`${owner}/${repo}`),
        };
        const entries = await listReviews(gh, prNumber);
        return entries.map((e) => ({
          reviewId: e.reviewId,
          state: e.state,
          reviewerLogin: e.reviewerLogin,
          body: e.body,
        }));
      },
    };

    const operatorNotify = new SystemOperatorNotify();

    // Build composite wake sink (logging + persistent)
    const sinks: import("@minsky/domain/ask/wake-on-respond").WakeSignalSink[] = [
      new LoggingWakeSignalSink(),
    ];
    try {
      sinks.push(new PersistentWakeSignalSink(new DrizzleWakePendingRepository(db)));
    } catch (err: unknown) {
      log.warn("asks_reconcile_scheduler.wake_sink_init_error", {
        event: "asks_reconcile_scheduler.wake_sink_init_error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const wakeSink = new CompositeWakeSignalSink(sinks);

    const reconcileResult = await reconcile(repo, githubClient, operatorNotify, wakeSink);
    return {
      success: true,
      inspected: reconcileResult.inspected,
      responded: reconcileResult.responded,
      errors: reconcileResult.errors,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Error text goes in the log MESSAGE, not only attributes: Railway's log
    // surface displays and searches message text only, so attribute-only
    // errors are invisible there (mt#2463).
    log.error(`asks_reconcile_scheduler.domain_call_error: ${message}`, {
      event: "asks_reconcile_scheduler.domain_call_error",
      error: message,
    });
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Scheduler (in-process setInterval)
// ---------------------------------------------------------------------------

/**
 * Start the Asks-reconcile scheduler on an in-process interval.
 *
 * Chosen over a Railway cron entry-point for simplicity: the reviewer service
 * is already running 24/7 and this scheduler shares the same process.
 * Configurable via `ASKS_RECONCILE_POLL_INTERVAL_MS` (default: 30 s). Opt-in
 * via `ASKS_RECONCILE_ENABLED=true` (disabled by default).
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
export function startAsksReconcileScheduler(
  config: ReviewerConfig,
  schedulerConfig: AsksReconcileSchedulerConfig,
  container?: AppContainerInterface
): ReturnType<typeof setInterval> | null {
  if (!schedulerConfig.enabled) {
    log.info("asks_reconcile_scheduler.disabled", {
      event: "asks_reconcile_scheduler.disabled",
      message: "Asks-reconcile scheduler is disabled (ASKS_RECONCILE_ENABLED=false).",
    });
    return null;
  }

  if (!container) {
    log.warn("asks_reconcile_scheduler.missing_domain_container", {
      event: "asks_reconcile_scheduler.missing_domain_container",
      message:
        "ASKS_RECONCILE_ENABLED=true but domain container not injected. " +
        "Asks-reconcile scheduler will not start.",
    });
    return null;
  }

  log.info("asks_reconcile_scheduler.enabled", {
    event: "asks_reconcile_scheduler.enabled",
    intervalMs: schedulerConfig.intervalMs,
  });

  // Suppress unused variable warning — config is held for future use
  void config;

  let isRunning = false;

  const handle = setInterval(() => {
    if (isRunning) {
      log.warn("asks_reconcile_scheduler.tick.skipped_overlap", {
        event: "asks_reconcile_scheduler.tick.skipped_overlap",
        message: "Previous asks-reconcile poll still in progress; skipping this interval tick.",
      });
      return;
    }
    isRunning = true;

    log.info("asks_reconcile_scheduler.tick.start", {
      event: "asks_reconcile_scheduler.tick.start",
    });

    runAsksReconcileDomain(container)
      .then((result) => {
        if (result.success) {
          log.info("asks_reconcile_scheduler.tick.complete", {
            event: "asks_reconcile_scheduler.tick.complete",
            inspected: result.inspected ?? 0,
            responded: result.responded ?? 0,
            errors: result.errors ?? 0,
          });
        }
        // Errors are already logged inside runAsksReconcileDomain.
      })
      .catch((err: unknown) => {
        // Unreachable: runAsksReconcileDomain catches internally. Belt-and-suspenders.
        const message = err instanceof Error ? err.message : String(err);
        log.error("asks_reconcile_scheduler.tick.error", {
          event: "asks_reconcile_scheduler.tick.error",
          error: message,
        });
      })
      .finally(() => {
        isRunning = false;
      });
  }, schedulerConfig.intervalMs);

  return handle;
}
