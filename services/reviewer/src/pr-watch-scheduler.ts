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
 *   defaults — see services/reviewer/railway.config.ts).
 * - `MINSKY_MCP_URL` + `MINSKY_MCP_AUTH_TOKEN` — used to call `pr_watch_run` via
 *   the Minsky MCP server (existing wiring in server.ts); required when this
 *   scheduler is enabled.
 *
 * ## Invocation mechanism
 *
 * The scheduler calls the Minsky MCP `pr_watch_run` tool via the service's
 * existing `mcpClient` infrastructure. This is the same pattern used by the
 * reviewer service for task-spec fetches (task-spec-fetch.ts). It preserves
 * the clean boundary between the reviewer service (GitHub-facing) and the
 * Minsky core (PR-watch domain): the watcher logic lives in Minsky, the
 * scheduler trigger lives in the reviewer service.
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
 */

import type { ReviewerConfig } from "./config";
import { parsePositiveIntEnv } from "./config";
import { callMcp } from "./mcp-client";

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
  /** Minsky MCP endpoint URL. */
  mcpUrl: string;
  /** Minsky MCP authentication token. */
  mcpToken: string;
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
  fired?: number;
  error?: string;
}

/**
 * Call the Minsky MCP `pr_watch_run` tool via HTTP.
 *
 * Delegates to the shared {@link callMcp} helper (mt#1821) for the MCP
 * initialize handshake and session-id caching. Before mt#1821 this helper
 * POSTed `tools/call` without first sending `initialize`; the server
 * rejected every request with `-32600 "first request must be initialize"`
 * and the pr-watch scheduler silently no-op'd every cycle.
 *
 * Errors from the MCP call are caught and returned as `{ success: false }`
 * — the scheduler is a best-effort background task; a single failed call
 * must not crash the reviewer service.
 */
async function callPrWatchRun(mcpUrl: string, mcpToken: string): Promise<McpCallResult> {
  // Timeout: 15s, matching the sweeper convention; passed explicitly so any
  // future change to the helper's default does not silently regress scheduler
  // behavior.
  //
  // Observability: `callMcp` emits structured `console.warn` events with the
  // `pr_watch_scheduler.mcp` prefix; the legacy
  // `pr_watch_scheduler.mcp_{http_error,rpc_error}` events are preserved at
  // the same prefix. The legacy `pr_watch_scheduler.call_failed` event
  // (emitted only when fetch itself threw, e.g. ECONNREFUSED) is renamed to
  // `pr_watch_scheduler.mcp_init_fetch_error` or
  // `pr_watch_scheduler.mcp_fetch_error` depending on which phase failed —
  // same data, different name. Update any dashboards keying on
  // `call_failed` to also match the new event names.
  const result = await callMcp(
    "pr_watch_run",
    {},
    { mcpUrl, mcpToken },
    { logPrefix: "pr_watch_scheduler.mcp", timeoutMs: 15_000 }
  );

  if (!result.ok) {
    return { success: false, error: result.message };
  }

  // Parse the text content from the MCP tool response.
  if (result.contentText) {
    try {
      const parsed = JSON.parse(result.contentText) as {
        inspected?: number;
        fired?: number;
      };
      return {
        success: true,
        inspected: parsed.inspected,
        fired: parsed.fired,
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
          "PR-watch scheduler is enabled but MINSKY_MCP_URL or MINSKY_MCP_AUTH_TOKEN is not set. " +
          "PR-watch scheduler will not start. Set PR_WATCH_ENABLED=false to silence this warning.",
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
  }, effectiveIntervalMs);

  return handle;
}
