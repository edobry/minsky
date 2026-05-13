/**
 * Periodic Asks-reconcile scheduler for the reviewer service.
 *
 * Runs `asks_reconcile` on a configurable `setInterval` so that registered
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
 * - `MINSKY_MCP_URL` + `MINSKY_MCP_AUTH_TOKEN` — used to call `asks_reconcile` via
 *   the Minsky MCP server; required when this scheduler is enabled.
 *
 * ## Invocation mechanism
 *
 * The scheduler calls the Minsky MCP `asks_reconcile` tool via HTTP, which
 * internally constructs a production `GithubReviewClient` (via
 * `makeProductionGithubReviewClient`) and `OperatorNotify` (via
 * `SystemOperatorNotify`), then calls `reconcile()` at
 * `src/domain/ask/reconciler.ts:183`. This preserves the clean boundary between
 * the reviewer service (GitHub-facing) and the Minsky core (Ask domain): the
 * reconciler logic lives in Minsky, the scheduler trigger lives in the reviewer
 * service.
 *
 * @see mt#1636 — Invocation path wiring for asks.reconcile (sibling to mt#1618).
 */

import type { ReviewerConfig } from "./config";
import { parsePositiveIntEnv } from "./config";
import { callMcp } from "./mcp-client";

// ---------------------------------------------------------------------------
// Public configuration interface
// ---------------------------------------------------------------------------

export interface AsksReconcileSchedulerConfig {
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Whether the scheduler is enabled. */
  enabled: boolean;
  /** Minsky MCP endpoint URL. */
  mcpUrl: string;
  /** Minsky MCP authentication token. */
  mcpToken: string;
}

export function loadAsksReconcileSchedulerConfig(): AsksReconcileSchedulerConfig {
  return {
    // Strict-positive parse (mt#1811 cascade-defense): malformed values would
    // feed NaN to setInterval. parsePositiveIntEnv throws at boot time.
    intervalMs: parsePositiveIntEnv("ASKS_RECONCILE_POLL_INTERVAL_MS", 30_000),
    enabled: (process.env["ASKS_RECONCILE_ENABLED"] ?? "false") === "true",
    mcpUrl: process.env["MINSKY_MCP_URL"] ?? "",
    mcpToken: process.env["MINSKY_MCP_AUTH_TOKEN"] ?? "",
  };
}

// ---------------------------------------------------------------------------
// MCP call helper
// ---------------------------------------------------------------------------

interface McpCallResult {
  success: boolean;
  inspected?: number;
  responded?: number;
  errors?: number;
  error?: string;
}

/**
 * Call the Minsky MCP `asks_reconcile` tool via HTTP.
 *
 * Delegates to the shared {@link callMcp} helper (mt#1821) for the MCP
 * initialize handshake and session-id caching. Before mt#1821 this helper
 * POSTed `tools/call` without first sending `initialize`; the server
 * rejected every request with `-32600 "first request must be initialize"`
 * and the asks-reconcile scheduler silently no-op'd every cycle.
 *
 * Errors from the MCP call are caught and returned as `{ success: false }`
 * — the scheduler is a best-effort background task; a single failed call
 * must not crash the reviewer service.
 */
async function callAsksReconcile(mcpUrl: string, mcpToken: string): Promise<McpCallResult> {
  // Timeout: 15s, matching the sweeper convention; passed explicitly so any
  // future change to the helper's default does not silently regress scheduler
  // behavior.
  //
  // Observability: `callMcp` emits structured `console.warn` events with the
  // `asks_reconcile_scheduler.mcp` prefix; the legacy
  // `asks_reconcile_scheduler.mcp_{http_error,rpc_error}` events are
  // preserved at the same prefix. The legacy
  // `asks_reconcile_scheduler.call_failed` event (emitted only when fetch
  // itself threw) is renamed to
  // `asks_reconcile_scheduler.mcp_init_fetch_error` or
  // `asks_reconcile_scheduler.mcp_fetch_error` depending on which phase
  // failed — same data, different name. Update any dashboards keying on
  // `call_failed` to also match the new event names.
  const result = await callMcp(
    "asks_reconcile",
    {},
    { mcpUrl, mcpToken },
    { logPrefix: "asks_reconcile_scheduler.mcp", timeoutMs: 15_000 }
  );

  if (!result.ok) {
    return { success: false, error: result.message };
  }

  if (result.contentText) {
    try {
      const parsed = JSON.parse(result.contentText) as {
        inspected?: number;
        responded?: number;
        errors?: number;
      };
      return {
        success: true,
        inspected: parsed.inspected,
        responded: parsed.responded,
        errors: parsed.errors,
      };
    } catch {
      // Non-JSON text content — still a success.
      return { success: true };
    }
  }

  return { success: true };
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
 *   `null` when disabled or when MCP credentials are missing.
 */
export function startAsksReconcileScheduler(
  config: ReviewerConfig,
  schedulerConfig: AsksReconcileSchedulerConfig
): ReturnType<typeof setInterval> | null {
  if (!schedulerConfig.enabled) {
    console.log(
      JSON.stringify({
        event: "asks_reconcile_scheduler.disabled",
        message: "Asks-reconcile scheduler is disabled (ASKS_RECONCILE_ENABLED=false).",
      })
    );
    return null;
  }

  if (!schedulerConfig.mcpUrl || !schedulerConfig.mcpToken) {
    console.warn(
      JSON.stringify({
        event: "asks_reconcile_scheduler.missing_credentials",
        message:
          "ASKS_RECONCILE_ENABLED=true but MINSKY_MCP_URL or MINSKY_MCP_AUTH_TOKEN is not set. " +
          "Asks-reconcile scheduler will not start.",
      })
    );
    return null;
  }

  console.log(
    JSON.stringify({
      event: "asks_reconcile_scheduler.enabled",
      intervalMs: schedulerConfig.intervalMs,
      mcpUrl: schedulerConfig.mcpUrl,
    })
  );

  // Suppress unused variable warning — config is held for future use
  void config;

  let isRunning = false;

  const handle = setInterval(() => {
    if (isRunning) {
      console.warn(
        JSON.stringify({
          event: "asks_reconcile_scheduler.tick.skipped_overlap",
          message: "Previous asks-reconcile poll still in progress; skipping this interval tick.",
        })
      );
      return;
    }
    isRunning = true;

    console.log(
      JSON.stringify({
        event: "asks_reconcile_scheduler.tick.start",
      })
    );

    callAsksReconcile(schedulerConfig.mcpUrl, schedulerConfig.mcpToken)
      .then((result) => {
        if (result.success) {
          console.log(
            JSON.stringify({
              event: "asks_reconcile_scheduler.tick.complete",
              inspected: result.inspected ?? 0,
              responded: result.responded ?? 0,
              errors: result.errors ?? 0,
            })
          );
        }
        // Errors are already logged inside callAsksReconcile.
      })
      .catch((err: unknown) => {
        // Unreachable: callAsksReconcile catches internally. Belt-and-suspenders.
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({
            event: "asks_reconcile_scheduler.tick.error",
            error: message,
          })
        );
      })
      .finally(() => {
        isRunning = false;
      });
  }, schedulerConfig.intervalMs);

  return handle;
}
