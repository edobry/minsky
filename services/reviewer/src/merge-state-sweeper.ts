/**
 * Periodic sweeper for post-merge state sync.
 *
 * Safety-net backstop for the primary webhook path (pull_request.closed
 * && merged=true handler in server.ts). Lists Minsky-tracked sessions in
 * PR_OPEN state, identifies any whose linked GitHub PR is actually
 * closed-merged, and calls applyPostMergeStateSync via the Minsky MCP
 * server for each.
 *
 * ## Why a separate sweeper (not folded into sweeper.ts)
 *
 * sweeper.ts targets open PRs missing a review — it only lists open PRs.
 * This sweeper targets closed-merged PRs with un-synced Minsky state — it
 * needs to list PR_OPEN sessions and check GitHub PR state, not list open
 * GitHub PRs. The data flows are orthogonal, so a separate module avoids
 * coupling.
 *
 * ## Cadence choice
 *
 * Default: 10 minutes (600_000 ms), same as the missed-review sweeper
 * (mt#1260). Calibration basis: bypass-merge events occur on the order
 * of 1/day in the Minsky project; a 10-min window means any stranded
 * session is caught within 10 min of the webhook firing. The sweeper
 * is the backstop — the webhook path is the primary mechanism. A 10-min
 * cadence keeps Railway CPU load negligible even on repos with many
 * sessions. Configurable via MERGE_STATE_SWEEPER_INTERVAL_MS.
 *
 * Per feedback_threshold_grounding: Minsky's loop cadence is ~1/day for
 * bypass-merge invocations. A 10-min sweeper window is overkill for the
 * steady-state case, but appropriate as a backstop since it means any
 * webhook-missed merge is caught within one polling window. A 24h window
 * would exceed Minsky's 5-day budget window and miss real-time guarantees.
 *
 * ## Covers / Does NOT cover
 *
 * ### Covers
 * - PR merged via `gh api PUT /merge` (bypass-merge) where the webhook fired
 *   but the handler had a transient error.
 * - PR merged via GitHub UI where the webhook fired but delivery failed.
 * - PR merged while the reviewer service was restarting (webhook missed entirely).
 *
 * ### Does NOT cover
 * - Sessions stuck in PR_OPEN where the PR number was never recorded in Minsky
 *   (session.pullRequest is null). Owner: mt#1614 repair-pass script handles
 *   the historical case; future sessions will have the PR number via pr-create.
 * - Minsky DB itself being unreachable (sweeper can't list sessions).
 *   Owner: infrastructure monitoring (mt#1310).
 * - GitHub API being unreachable (sweeper can't check PR state).
 *   Owner: infrastructure monitoring.
 * - **Deploys where MINSKY_MCP_URL or MINSKY_MCP_TOKEN is unset** (mt#1811). The
 *   sweeper defaults to enabled but cannot start without MCP credentials —
 *   startup emits "merge_state_sweeper.missing_credentials" and returns null.
 *   Operators must set both env vars on the deployed service. See
 *   services/reviewer/DEPLOY.md § Recovery layer activation.
 */

import type { ReviewerConfig } from "./config";
import { parsePositiveIntEnv } from "./config";
import { callMcp } from "./mcp-client";

// ---------------------------------------------------------------------------
// Public configuration interface
// ---------------------------------------------------------------------------

export interface MergeStateSweeperConfig {
  /** Sweep interval in milliseconds. Default: 600_000 (10 min). */
  intervalMs: number;
  /**
   * Whether the sweeper is enabled. Default: true (flipped from false on mt#1811).
   *
   * The sweeper is mt#1614's load-bearing recovery mechanism for bypass-merge state-sync
   * drift. Defaulting to disabled silently strands sessions whose webhook delivery missed.
   * Operators can still explicitly opt out via MERGE_STATE_SWEEPER_ENABLED=false.
   */
  enabled: boolean;
  /** Minsky MCP endpoint URL. */
  mcpUrl: string;
  /** Minsky MCP authentication token. */
  mcpToken: string;
}

export function loadMergeStateSweeperConfig(): MergeStateSweeperConfig {
  return {
    // 10-minute default: see cadence rationale in module docstring.
    // Strict-positive parse (mt#1811 R1 BLOCKING fix): now that the sweeper
    // defaults to enabled, a misconfigured interval would feed NaN to
    // setInterval and produce a tight CPU loop. parsePositiveIntEnv throws
    // at boot time on any non-positive-integer value, making misconfiguration
    // a clear startup error instead.
    intervalMs: parsePositiveIntEnv("MERGE_STATE_SWEEPER_INTERVAL_MS", 600_000),
    // Default to enabled (mt#1811). If MCP creds are absent, startMergeStateSweeper
    // emits "missing_credentials" and refuses to start — no behavior regression for
    // deploys without the credentials, but a clear log signal instead of silent disable.
    enabled: (process.env["MERGE_STATE_SWEEPER_ENABLED"] ?? "true") === "true",
    mcpUrl: process.env["MINSKY_MCP_URL"] ?? "",
    mcpToken: process.env["MINSKY_MCP_TOKEN"] ?? "",
  };
}

// ---------------------------------------------------------------------------
// MCP call helper
// ---------------------------------------------------------------------------

/** Result of a single sweep pass. */
export interface MergeStateSweepResult {
  /** Timestamp when the sweep started (ISO 8601). */
  startedAt: string;
  /** Number of sessions with PR_OPEN status scanned. */
  sessionsScanned: number;
  /** Number of sessions found with closed-merged PRs (unsynced). */
  missedSyncs: number;
  /** Number of sessions for which applyPostMergeStateSync was invoked. */
  syncsTriggered: number;
  /** Errors encountered (non-fatal — sweep continues after each). */
  errors: string[];
}

/** Narrow shape of the session_list MCP response we need. */
interface SessionListItem {
  sessionId: string;
  taskId?: string;
  status?: string;
  pullRequest?: {
    number?: number;
    state?: string;
    mergedAt?: string;
    github?: {
      htmlUrl?: string;
    };
  };
}

/**
 * Call a Minsky MCP tool via HTTP.
 *
 * Thin adapter over the shared {@link callMcp} helper (mt#1821) — preserves
 * the legacy `string | null` return shape so the sweeper callsites don't
 * change. The shared helper handles the initialize handshake and session-id
 * caching, which prior to mt#1821 was missing here and caused every sweep
 * cycle to fail with `-32600 "first request must be initialize"`.
 *
 * Timeout: 15s, matching the prior in-file `AbortController` + `setTimeout`
 * implementation. Passed explicitly (not relying on the helper's default)
 * so any future change to the helper's default does not silently regress
 * the sweeper's prior behavior.
 *
 * Observability: `callMcp` emits structured `console.warn` events with the
 * `merge_state_sweeper.mcp` prefix. The event name suffixes are
 * `_init_fetch_error`, `_init_http_error`, `_init_no_session_id`,
 * `_init_notif_failed`, `_session_expired_retrying`, `_fetch_error`,
 * `_http_error`, `_body_read_error`, `_parse_error`, `_rpc_error`, and
 * `_tool_error`. The original
 * `merge_state_sweeper.mcp_{http_error,rpc_error,fetch_error}` events are
 * preserved at the same prefix; additional more-granular handshake events
 * are added.
 *
 * Returns the concatenated text content from the tool result, or null on
 * any error (transport / RPC / tool-level).
 */
async function callMcpTool(
  mcpUrl: string,
  mcpToken: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<string | null> {
  const result = await callMcp(
    toolName,
    args,
    { mcpUrl, mcpToken },
    { logPrefix: "merge_state_sweeper.mcp", timeoutMs: 15_000 }
  );
  return result.ok ? result.contentText : null;
}

// ---------------------------------------------------------------------------
// Core sweep logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Run a single merge-state sweep cycle via the Minsky MCP server.
 *
 * 1. List all sessions (status=PR_OPEN filter via MCP session.list).
 * 2. For each PR_OPEN session with a recorded pullRequest.number, call
 *    session.pr.get to check current GitHub state.
 * 3. If PR is closed+merged on GitHub, call session.apply_post_merge_state_sync.
 *
 * NOTE: session.apply_post_merge_state_sync is an MCP tool added by this
 * task (mt#1614). If the MCP server doesn't yet expose it, the sweeper
 * falls back to logging the unsynced sessions for manual repair.
 */
export async function runMergeStateSweep(
  mcpUrl: string,
  mcpToken: string
): Promise<MergeStateSweepResult> {
  const startedAt = new Date().toISOString();
  const result: MergeStateSweepResult = {
    startedAt,
    sessionsScanned: 0,
    missedSyncs: 0,
    syncsTriggered: 0,
    errors: [],
  };

  console.log(
    JSON.stringify({
      event: "merge_state_sweeper.cycle_start",
      timestamp: startedAt,
    })
  );

  // Step 1: List PR_OPEN sessions.
  let sessions: SessionListItem[] = [];
  try {
    const listText = await callMcpTool(mcpUrl, mcpToken, "session.list", { status: "PR_OPEN" });
    if (!listText) {
      result.errors.push("session.list returned no content");
      console.warn(
        JSON.stringify({
          event: "merge_state_sweeper.list_failed",
          reason: "no_content",
        })
      );
      return result;
    }

    const parsed = JSON.parse(listText) as {
      success?: boolean;
      sessions?: SessionListItem[];
      data?: SessionListItem[];
    };

    sessions = parsed.sessions ?? parsed.data ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Failed to list PR_OPEN sessions: ${msg}`);
    console.error(
      JSON.stringify({
        event: "merge_state_sweeper.list_error",
        error: msg,
      })
    );
    return result;
  }

  result.sessionsScanned = sessions.length;
  console.log(
    JSON.stringify({
      event: "merge_state_sweeper.sessions_scanned",
      count: sessions.length,
    })
  );

  // Step 2: For each PR_OPEN session with a pullRequest, check GitHub state.
  // Cap concurrency at 3 to avoid rate-limiting the MCP server.
  const CONCURRENCY = 3;
  const chunks: SessionListItem[][] = [];
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    chunks.push(sessions.slice(i, i + CONCURRENCY));
  }

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (session) => {
        const sessionId = session.sessionId;

        // Skip sessions without a recorded PR number.
        if (!session.pullRequest?.number) {
          return;
        }

        try {
          // Step 2a: Fetch current PR state from GitHub via session.pr.get.
          // The MCP command reads `params.sessionId` (not `params.session`).
          // PR #1010 R2 fix.
          const prGetText = await callMcpTool(mcpUrl, mcpToken, "session.pr.get", {
            sessionId,
          });

          if (!prGetText) {
            // Non-fatal: skip this session.
            return;
          }

          const prData = JSON.parse(prGetText) as {
            success?: boolean;
            pullRequest?: {
              state?: string;
              merged?: boolean;
              mergedAt?: string;
              mergeSha?: string;
            };
          };

          const pr = prData.pullRequest;
          if (!pr) return;

          const isMerged =
            pr.merged === true ||
            pr.state === "merged" ||
            (pr.state === "closed" && pr.mergedAt != null);

          if (!isMerged) {
            // PR is not merged (still open or closed without merge). Skip.
            return;
          }

          // Step 3: PR is closed-merged but session is still PR_OPEN — trigger sync.
          result.missedSyncs++;
          console.warn(
            JSON.stringify({
              event: "merge_state_sweeper.missed_sync_detected",
              sessionId,
              taskId: session.taskId,
              prState: pr.state,
              mergedAt: pr.mergedAt,
            })
          );

          // Call the apply_post_merge_state_sync MCP tool. The command reads
          // `params.sessionId` (not `params.session`). PR #1010 R2 fix.
          // TOCTOU accept: idempotent — calling twice produces the same final state.
          const syncText = await callMcpTool(
            mcpUrl,
            mcpToken,
            "session.apply_post_merge_state_sync",
            {
              sessionId,
              mergeSha: pr.mergeSha,
              mergedAt: pr.mergedAt,
              trigger: "sweeper",
            }
          );

          if (syncText) {
            result.syncsTriggered++;
            console.log(
              JSON.stringify({
                event: "merge_state_sweeper.sync_triggered",
                sessionId,
                taskId: session.taskId,
                mergedAt: pr.mergedAt,
              })
            );
          } else {
            // The MCP tool may not be wired yet — log for manual repair.
            const msg = `session.apply_post_merge_state_sync returned no content for ${sessionId}`;
            result.errors.push(msg);
            console.warn(
              JSON.stringify({
                event: "merge_state_sweeper.sync_tool_unavailable",
                sessionId,
                message: msg,
              })
            );
          }
        } catch (sessionErr) {
          const msg = sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
          result.errors.push(`Error processing session ${sessionId}: ${msg}`);
          console.warn(
            JSON.stringify({
              event: "merge_state_sweeper.session_error",
              sessionId,
              error: msg,
            })
          );
        }
      })
    );
  }

  if (result.missedSyncs > 0) {
    console.warn(
      JSON.stringify({
        event: "merge_state_sweeper.primary_webhook_failing",
        message: `${result.missedSyncs} session(s) found with closed-merged PRs but unsync'd Minsky state. Webhook delivery may be failing.`,
        missedSyncs: result.missedSyncs,
        syncsTriggered: result.syncsTriggered,
      })
    );
  }

  console.log(
    JSON.stringify({
      event: "merge_state_sweeper.cycle_end",
      ...result,
    })
  );

  return result;
}

// ---------------------------------------------------------------------------
// Scheduler (in-process setInterval)
// ---------------------------------------------------------------------------

/**
 * Start the merge-state sweeper on an in-process interval.
 *
 * Same pattern as sweeper.ts (mt#1260) and pr-watch-scheduler.ts (mt#1618).
 * **Enabled by default (mt#1811)**: explicit opt-out via
 * `MERGE_STATE_SWEEPER_ENABLED=false`. Requires MINSKY_MCP_URL + MINSKY_MCP_TOKEN
 * to start — without them, logs `missing_credentials` and returns null.
 *
 * Cadence: 10 min by default (MERGE_STATE_SWEEPER_INTERVAL_MS). See module
 * docstring for calibration rationale.
 */
export function startMergeStateSweeper(
  _config: ReviewerConfig,
  sweeperConfig: MergeStateSweeperConfig
): ReturnType<typeof setInterval> | null {
  if (!sweeperConfig.enabled) {
    console.log(
      JSON.stringify({
        event: "merge_state_sweeper.disabled",
        message: "Merge-state sweeper is disabled (MERGE_STATE_SWEEPER_ENABLED=false).",
      })
    );
    return null;
  }

  if (!sweeperConfig.mcpUrl || !sweeperConfig.mcpToken) {
    console.warn(
      JSON.stringify({
        event: "merge_state_sweeper.missing_credentials",
        message:
          "MERGE_STATE_SWEEPER_ENABLED=true but MINSKY_MCP_URL or MINSKY_MCP_TOKEN is not set. " +
          "Merge-state sweeper will not start.",
      })
    );
    return null;
  }

  console.log(
    JSON.stringify({
      event: "merge_state_sweeper.started",
      intervalMs: sweeperConfig.intervalMs,
      mcpUrl: sweeperConfig.mcpUrl,
    })
  );

  let isRunning = false;

  const handle = setInterval(() => {
    if (isRunning) {
      console.warn(
        JSON.stringify({
          event: "merge_state_sweeper.skip_reentrant",
          message: "Previous merge-state sweep still in progress; skipping this interval tick.",
        })
      );
      return;
    }
    isRunning = true;

    runMergeStateSweep(sweeperConfig.mcpUrl, sweeperConfig.mcpToken)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({
            event: "merge_state_sweeper.cycle_error",
            error: message,
          })
        );
      })
      .finally(() => {
        isRunning = false;
      });
  }, sweeperConfig.intervalMs);

  return handle;
}
