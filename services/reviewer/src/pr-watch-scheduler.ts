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
 * - `PR_WATCH_ENABLED` — set to `"true"` to activate (disabled by default).
 * - `MINSKY_MCP_URL` + `MINSKY_MCP_TOKEN` — used to call `pr_watch_run` via
 *   the Minsky MCP server (existing wiring in server.ts); required when this
 *   scheduler is enabled.
 *
 * ## Invocation mechanism
 *
 * The scheduler calls the Minsky MCP `pr.watch.run` tool via the service's
 * existing `mcpClient` infrastructure. This is the same pattern used by the
 * reviewer service for task-spec fetches (task-spec-fetch.ts). It preserves
 * the clean boundary between the reviewer service (GitHub-facing) and the
 * Minsky core (PR-watch domain): the watcher logic lives in Minsky, the
 * scheduler trigger lives in the reviewer service.
 *
 * @see mt#1618 — Invocation path wiring for mt#1295 PR-watch subsystem.
 */

import type { ReviewerConfig } from "./config";

// ---------------------------------------------------------------------------
// Public configuration interface
// ---------------------------------------------------------------------------

export interface PrWatchSchedulerConfig {
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Whether the scheduler is enabled. */
  enabled: boolean;
  /** Minsky MCP endpoint URL. */
  mcpUrl: string;
  /** Minsky MCP authentication token. */
  mcpToken: string;
}

export function loadPrWatchSchedulerConfig(): PrWatchSchedulerConfig {
  return {
    intervalMs: parseInt(process.env["PR_WATCH_POLL_INTERVAL_MS"] ?? "60000", 10),
    enabled: (process.env["PR_WATCH_ENABLED"] ?? "false") === "true",
    mcpUrl: process.env["MINSKY_MCP_URL"] ?? "",
    mcpToken: process.env["MINSKY_MCP_TOKEN"] ?? "",
  };
}

// ---------------------------------------------------------------------------
// MCP call helper
// ---------------------------------------------------------------------------

interface McpCallResult {
  success: boolean;
  inspected?: number;
  fired?: number;
  error?: string;
}

/**
 * Call the Minsky MCP `pr.watch.run` tool via HTTP.
 *
 * The Minsky MCP server exposes tools over a JSON-RPC-over-HTTP interface.
 * This helper sends a minimal `tools/call` request and parses the outcome.
 *
 * Errors from the MCP call are caught and returned as `{ success: false }` —
 * the scheduler is a best-effort background task; a single failed call must
 * not crash the reviewer service.
 */
async function callPrWatchRun(mcpUrl: string, mcpToken: string): Promise<McpCallResult> {
  try {
    const response = await fetch(`${mcpUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mcpToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `pr-watch-scheduler-${Date.now()}`,
        method: "tools/call",
        params: {
          name: "pr_watch_run",
          arguments: {},
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable)");
      console.warn(
        JSON.stringify({
          event: "pr_watch_scheduler.mcp_http_error",
          status: response.status,
          body: text.slice(0, 200),
        })
      );
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as {
      result?: { content?: Array<{ text?: string }> };
      error?: { message?: string };
    };

    if (data.error) {
      console.warn(
        JSON.stringify({
          event: "pr_watch_scheduler.mcp_rpc_error",
          error: data.error.message,
        })
      );
      return { success: false, error: data.error.message ?? "rpc error" };
    }

    // Parse the text content from the MCP tool response.
    const textContent = data.result?.content?.[0]?.text;
    if (textContent) {
      try {
        const parsed = JSON.parse(textContent) as {
          inspected?: number;
          fired?: number;
        };
        return {
          success: true,
          inspected: parsed.inspected,
          fired: parsed.fired,
        };
      } catch {
        // Non-JSON text content — still a success
        return { success: true };
      }
    }

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      JSON.stringify({
        event: "pr_watch_scheduler.call_failed",
        error: message,
      })
    );
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
 * Configurable via `PR_WATCH_POLL_INTERVAL_MS` (default: 60 s). Opt-in via
 * `PR_WATCH_ENABLED=true` (disabled by default).
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
export function startPrWatchScheduler(
  config: ReviewerConfig,
  schedulerConfig: PrWatchSchedulerConfig
): ReturnType<typeof setInterval> | null {
  if (!schedulerConfig.enabled) {
    console.log(
      JSON.stringify({
        event: "pr_watch_scheduler.disabled",
        message: "PR-watch scheduler is disabled (PR_WATCH_ENABLED=false).",
      })
    );
    return null;
  }

  if (!schedulerConfig.mcpUrl || !schedulerConfig.mcpToken) {
    console.warn(
      JSON.stringify({
        event: "pr_watch_scheduler.missing_credentials",
        message:
          "PR_WATCH_ENABLED=true but MINSKY_MCP_URL or MINSKY_MCP_TOKEN is not set. " +
          "PR-watch scheduler will not start.",
      })
    );
    return null;
  }

  console.log(
    JSON.stringify({
      event: "pr_watch_scheduler.started",
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
          event: "pr_watch_scheduler.skip_reentrant",
          message: "Previous PR-watch poll still in progress; skipping this interval tick.",
        })
      );
      return;
    }
    isRunning = true;

    callPrWatchRun(schedulerConfig.mcpUrl, schedulerConfig.mcpToken)
      .then((result) => {
        if (result.success) {
          console.log(
            JSON.stringify({
              event: "pr_watch_scheduler.poll_complete",
              inspected: result.inspected ?? 0,
              fired: result.fired ?? 0,
            })
          );
        }
        // Errors are already logged inside callPrWatchRun.
      })
      .catch((err: unknown) => {
        // Unreachable: callPrWatchRun catches internally. Belt-and-suspenders.
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({
            event: "pr_watch_scheduler.unexpected_error",
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
