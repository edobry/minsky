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
 */

import type { ReviewerConfig } from "./config";
import { safeTruncate } from "./utils/safe-truncate";

// ---------------------------------------------------------------------------
// Public configuration interface
// ---------------------------------------------------------------------------

export interface MergeStateSweeperConfig {
  /** Sweep interval in milliseconds. Default: 600_000 (10 min). */
  intervalMs: number;
  /** Whether the sweeper is enabled. Default: false. */
  enabled: boolean;
  /** Minsky MCP endpoint URL. */
  mcpUrl: string;
  /** Minsky MCP authentication token. */
  mcpToken: string;
}

export function loadMergeStateSweeperConfig(): MergeStateSweeperConfig {
  return {
    // 10-minute default: see cadence rationale in module docstring.
    intervalMs: parseInt(process.env["MERGE_STATE_SWEEPER_INTERVAL_MS"] ?? "600000", 10),
    enabled: (process.env["MERGE_STATE_SWEEPER_ENABLED"] ?? "false") === "true",
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
 * Call a Minsky MCP tool via HTTP (same pattern as pr-watch-scheduler.ts).
 *
 * Returns the parsed result.content[0].text value, or null on error.
 */
async function callMcpTool(
  mcpUrl: string,
  mcpToken: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    let response: Response;
    try {
      response = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mcpToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `merge-state-sweeper-${Date.now()}`,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      console.warn(
        JSON.stringify({
          event: "merge_state_sweeper.mcp_fetch_error",
          tool: toolName,
          error: msg,
        })
      );
      return null;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable)");
      console.warn(
        JSON.stringify({
          event: "merge_state_sweeper.mcp_http_error",
          tool: toolName,
          status: response.status,
          body: safeTruncate(text, 200, "head"),
        })
      );
      return null;
    }

    const raw = await response.text().catch(() => null);
    if (!raw) return null;

    // Handle SSE (text/event-stream) or plain JSON responses.
    const trimmed = raw.trim();
    let jsonText: string | null = null;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      jsonText = trimmed;
    } else {
      // SSE: extract last data: line
      let last: string | null = null;
      for (const line of trimmed.split("\n")) {
        const stripped = line.trim();
        if (stripped.startsWith("data:")) {
          const payload = stripped.slice("data:".length).trim();
          if (payload.startsWith("{") || payload.startsWith("[")) {
            last = payload;
          }
        }
      }
      jsonText = last;
    }

    if (!jsonText) return null;

    const parsed = JSON.parse(jsonText) as {
      result?: { content?: Array<{ type?: string; text?: string }> };
      error?: { message?: string };
    };

    if (parsed.error) {
      console.warn(
        JSON.stringify({
          event: "merge_state_sweeper.mcp_rpc_error",
          tool: toolName,
          error: parsed.error.message,
        })
      );
      return null;
    }

    // Concatenate all text chunks (handles multi-chunk responses).
    const chunks = (parsed.result?.content ?? [])
      .filter(
        (c): c is { type: string; text: string } => c?.type === "text" && typeof c.text === "string"
      )
      .map((c) => c.text);

    return chunks.length > 0 ? chunks.join("") : null;
  } finally {
    clearTimeout(timeoutId);
  }
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
          const prGetText = await callMcpTool(mcpUrl, mcpToken, "session.pr.get", {
            session: sessionId,
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

          // Call the apply_post_merge_state_sync MCP tool.
          // TOCTOU accept: idempotent — calling twice produces the same final state.
          const syncText = await callMcpTool(
            mcpUrl,
            mcpToken,
            "session.apply_post_merge_state_sync",
            {
              session: sessionId,
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
 * Opt-in via MERGE_STATE_SWEEPER_ENABLED=true (disabled by default).
 * Requires MINSKY_MCP_URL + MINSKY_MCP_TOKEN.
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
