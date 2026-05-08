/**
 * minsky-reviewer webhook server.
 *
 * Stateless HTTP service. Receives GitHub webhooks, verifies signatures,
 * dispatches to the review worker, posts results back to GitHub.
 *
 * Deploys to Railway (or any Node-compatible target). See DEPLOY.md.
 */

import { Webhooks } from "@octokit/webhooks";
import type { ReviewerConfig } from "./config";
import { loadConfig } from "./config";
import type { ReviewResult } from "./review-worker";
import { runReview } from "./review-worker";
import { loadSweeperConfig, startSweeper } from "./sweeper";
import { loadPrWatchSchedulerConfig, startPrWatchScheduler } from "./pr-watch-scheduler";
import {
  loadAsksReconcileSchedulerConfig,
  startAsksReconcileScheduler,
} from "./asks-reconcile-scheduler";
import { loadMergeStateSweeperConfig, startMergeStateSweeper } from "./merge-state-sweeper";
import { getDb, type ReviewerDb } from "./db/client";
import { applyMigrations } from "./db/migrate";

interface PullRequestPayload {
  pull_request: {
    number: number;
    user: { login: string };
    draft: boolean;
    head: { sha: string };
  };
  repository: { owner: { login: string }; name: string };
}

/**
 * Payload shape for pull_request.closed events.
 * The @octokit/webhooks library validates the signature before dispatching;
 * the `merged` and `merge_commit_sha` fields come from GitHub's documented PR event shape.
 * Runtime type guard (isMergedClosedPayload) is applied before acting.
 */
interface PullRequestClosedPayload {
  action: "closed";
  pull_request: {
    number: number;
    merged: boolean;
    merge_commit_sha: string | null;
    merged_at: string | null;
    user: { login: string };
    head: { ref: string; sha: string };
    base: { ref: string };
  };
  repository: { owner: { login: string }; name: string };
}

/** Type guard: payload is a closed+merged PR event. */
function isMergedClosedPayload(
  payload: unknown
): payload is PullRequestClosedPayload & { pull_request: { merged: true } } {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (p["action"] !== "closed") return false;
  const pr = p["pull_request"] as Record<string, unknown> | undefined;
  if (!pr) return false;
  return pr["merged"] === true;
}

/** Extract a Minsky task ID from a GitHub head branch name (e.g. "task/mt-1614" → "mt#1614"). */
function extractTaskIdFromBranch(headRef: string): string | null {
  // Matches: task/mt-1614, task/mt-123, task/mt-1
  const match = /^task\/mt-(\d+)$/.exec(headRef);
  if (match) {
    return `mt#${match[1]}`;
  }
  return null;
}

/** Dependency-injectable runReview signature for testing. */
export type RunReviewFn = (
  config: ReviewerConfig,
  owner: string,
  repo: string,
  prNumber: number,
  prAuthorLogin: string,
  deliveryId?: string,
  headSha?: string,
  deps?: import("./review-worker").RunReviewDeps
) => Promise<ReviewResult>;

/**
 * Core application factory. Returns the Bun server handle and a
 * gracefulShutdown function bound to that server instance.
 *
 * Accepts an optional `runReviewFn` override for testing — production always
 * uses the real `runReview` from review-worker.ts.
 *
 * Accepts an optional `db` handle for convergence metric persistence.
 * When provided, each review write is attempted; errors are swallowed.
 * When absent (test environments), metric persistence is skipped.
 *
 * Exported for testability; the module-level startup below calls this with
 * the real config and the real runReview.
 */
export function createApp(
  cfg: ReviewerConfig,
  runReviewFn: RunReviewFn = runReview,
  db?: ReviewerDb
): {
  server: ReturnType<typeof Bun.serve>;
  gracefulShutdown: () => Promise<void>;
} {
  const webhooks = new Webhooks({ secret: cfg.webhookSecret });

  /** Module-scope set of in-flight review promises within this app instance. */
  const inflight: Set<Promise<unknown>> = new Set();

  /**
   * Minimal MCP tool caller for server.ts internal use.
   * Same pattern as pr-watch-scheduler.ts callPrWatchRun.
   * Returns the concatenated text content from the result, or null on error.
   */
  async function callMcpToolLocal(
    mcpUrl: string,
    mcpToken: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string | null> {
    try {
      const response = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mcpToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `at-merge-handler-${Date.now()}`,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
      });

      if (!response.ok) {
        await response.text().catch(() => undefined);
        return null;
      }

      const raw = await response.text().catch(() => null);
      if (!raw) return null;

      const trimmed = raw.trim();
      let jsonText: string | null = null;
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        jsonText = trimmed;
      } else {
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

      if (parsed.error) return null;

      const chunks = (parsed.result?.content ?? [])
        .filter(
          (c): c is { type: string; text: string } =>
            c?.type === "text" && typeof c.text === "string"
        )
        .map((c) => c.text);

      return chunks.length > 0 ? chunks.join("") : null;
    } catch {
      return null;
    }
  }

  /**
   * Schedule a review as a detached promise. Calling code returns 200
   * immediately — never await this.
   *
   * Failures are caught and logged as event=review_error. The sweeper
   * (mt#1260) is already live on main as the safety net.
   */
  function startDetachedReview(payload: PullRequestPayload, deliveryId: string): void {
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = payload.pull_request.number;
    const prAuthor = payload.pull_request.user.login;
    const headSha = payload.pull_request.head.sha;

    const promise: Promise<unknown> = runReviewFn(
      cfg,
      owner,
      repo,
      prNumber,
      prAuthor,
      deliveryId,
      headSha,
      db !== undefined ? { db } : undefined
    )
      .then((result) => {
        console.log(
          JSON.stringify({
            event: "review_result",
            delivery_id: deliveryId,
            sha: headSha,
            pr: prNumber,
            owner,
            repo,
            status: result.status,
            reason: result.reason,
            tier: result.tier,
            scope: result.scope,
            reviewUrl: result.review?.htmlUrl,
            provider: result.providerUsed,
            model: result.providerModel,
            usage: result.usage,
            taskSpecFetch: result.taskSpecFetch,
          })
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({
            event: "review_error",
            delivery_id: deliveryId,
            sha: headSha,
            pr: prNumber,
            owner,
            repo,
            error: message,
          })
        );
      })
      .finally(() => {
        inflight.delete(promise);
      });

    inflight.add(promise);
  }

  async function handlePullRequestEvent(
    payload: PullRequestPayload,
    deliveryId: string
  ): Promise<void> {
    const prNumber = payload.pull_request.number;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;

    if (payload.pull_request.draft) {
      console.log(
        JSON.stringify({
          event: "skip_draft",
          delivery_id: deliveryId,
          pr: prNumber,
          owner,
          repo,
        })
      );
      return;
    }

    startDetachedReview(payload, deliveryId);
  }

  /**
   * Call the Minsky MCP to apply post-merge state sync for a task.
   *
   * First looks up the session by taskId, then calls
   * session.apply_post_merge_state_sync with the session ID.
   * Errors are non-fatal — the merge-state sweeper will catch misses.
   */
  async function runMergeStateSyncViaTaskId(
    mcpUrl: string,
    mcpToken: string,
    taskId: string,
    mergeSha: string | undefined,
    mergedAt: string | undefined,
    deliveryId: string
  ): Promise<void> {
    // Look up session by taskId.
    const sessionLookupText = await callMcpToolLocal(mcpUrl, mcpToken, "session.get", {
      task: taskId,
    });

    if (!sessionLookupText) {
      console.warn(
        JSON.stringify({
          event: "at_merge_handler.session_lookup_failed",
          delivery_id: deliveryId,
          taskId,
          reason: "no_content",
        })
      );
      return;
    }

    let sessionId: string | null = null;
    try {
      const parsed = JSON.parse(sessionLookupText) as {
        success?: boolean;
        session?: { sessionId?: string };
        sessionId?: string;
      };
      sessionId = parsed.session?.sessionId ?? parsed.sessionId ?? null;
    } catch {
      console.warn(
        JSON.stringify({
          event: "at_merge_handler.session_lookup_parse_error",
          delivery_id: deliveryId,
          taskId,
        })
      );
      return;
    }

    if (!sessionId) {
      console.warn(
        JSON.stringify({
          event: "at_merge_handler.session_not_found",
          delivery_id: deliveryId,
          taskId,
        })
      );
      return;
    }

    // Call apply_post_merge_state_sync.
    const syncArgs: Record<string, unknown> = {
      session: sessionId,
      trigger: "webhook",
    };
    if (mergeSha) syncArgs["mergeSha"] = mergeSha;
    if (mergedAt) syncArgs["mergedAt"] = mergedAt;

    const syncText = await callMcpToolLocal(
      mcpUrl,
      mcpToken,
      "session.apply_post_merge_state_sync",
      syncArgs
    );

    if (syncText) {
      console.log(
        JSON.stringify({
          event: "at_merge_handler.sync_complete",
          delivery_id: deliveryId,
          taskId,
          sessionId,
          mergeSha,
          mergedAt,
        })
      );
    } else {
      console.warn(
        JSON.stringify({
          event: "at_merge_handler.sync_tool_unavailable",
          delivery_id: deliveryId,
          taskId,
          sessionId,
          message:
            "session.apply_post_merge_state_sync returned no content. " +
            "The merge-state sweeper will catch this.",
        })
      );
    }
  }

  webhooks.on("pull_request.opened", async ({ id, payload }) => {
    await handlePullRequestEvent(payload as PullRequestPayload, id);
  });

  webhooks.on("pull_request.synchronize", async ({ id, payload }) => {
    await handlePullRequestEvent(payload as PullRequestPayload, id);
  });

  webhooks.on("pull_request.reopened", async ({ id, payload }) => {
    await handlePullRequestEvent(payload as PullRequestPayload, id);
  });

  /**
   * Handle pull_request.closed events for at-merge state sync (mt#1614).
   *
   * @octokit/webhooks already validated the HMAC-SHA-256 signature before
   * dispatching here, so the payload is authenticated.
   *
   * Gate: only fire when pull_request.merged === true (closed-and-merged).
   * A PR closed without merge (e.g., rejected) does not trigger state sync.
   *
   * Implementation: call the Minsky MCP session.apply_post_merge_state_sync
   * tool via the same HTTP pattern as the PR-watch and Asks-reconcile schedulers.
   * The MCP server owns the domain logic; this handler is a thin trigger layer.
   *
   * Task-lookup path: head branch `task/mt-N` → taskId → sessionId via Minsky
   * MCP session.getByTaskId. If head branch doesn't match the task-branch
   * pattern, we log and return without error (may be a non-Minsky PR).
   *
   * TOCTOU analysis (§7b):
   * - Read atomicity: the payload carries merged=true already when we read it.
   *   The @octokit/webhooks library reads the body atomically before dispatch.
   *   Accept — single read, no interleaving.
   * - Decision-action gap: between receiving merged=true and calling
   *   apply_post_merge_state_sync, the session could theoretically already be
   *   synced (e.g., session_pr_merge ran). Accept — applyPostMergeStateSync is
   *   idempotent; calling it when already MERGED is a no-op.
   * - Stale-read: the payload is freshly delivered from GitHub.
   *   Accept — GitHub webhook delivery is the authoritative push event.
   */
  webhooks.on("pull_request.closed", async ({ id: deliveryId, payload }) => {
    // Runtime guard: only process merged PRs. The type system can't enforce
    // pull_request.merged at the webhook dispatch layer, so we guard here.
    if (!isMergedClosedPayload(payload)) {
      // Closed without merge — not a state-sync trigger.
      console.log(
        JSON.stringify({
          event: "at_merge_handler.skip_not_merged",
          delivery_id: deliveryId,
          pr: (payload as Record<string, unknown>)["pull_request"]
            ? ((payload as Record<string, unknown>)["pull_request"] as Record<string, unknown>)[
                "number"
              ]
            : null,
        })
      );
      return;
    }

    const pr = payload.pull_request;
    const headRef = pr.head.ref;
    const mergeSha = pr.merge_commit_sha ?? undefined;
    const mergedAt = pr.merged_at ?? undefined;
    const prNumber = pr.number;

    // Attempt to extract taskId from the head branch name.
    const taskId = extractTaskIdFromBranch(headRef);

    console.log(
      JSON.stringify({
        event: "at_merge_handler.received",
        delivery_id: deliveryId,
        pr: prNumber,
        headRef,
        taskId,
        mergeSha,
        mergedAt,
      })
    );

    if (!taskId) {
      // Not a Minsky task branch — skip silently. Non-Minsky PRs are expected.
      console.log(
        JSON.stringify({
          event: "at_merge_handler.skip_non_task_branch",
          delivery_id: deliveryId,
          pr: prNumber,
          headRef,
        })
      );
      return;
    }

    // Call applyPostMergeStateSync via Minsky MCP (fire-and-forget, detached).
    // The MCP path keeps the domain logic in Minsky core, not the reviewer service.
    if (!cfg.mcpUrl || !cfg.mcpToken) {
      console.warn(
        JSON.stringify({
          event: "at_merge_handler.mcp_not_configured",
          delivery_id: deliveryId,
          pr: prNumber,
          taskId,
          message:
            "MINSKY_MCP_URL or MINSKY_MCP_TOKEN not set — cannot call apply_post_merge_state_sync. " +
            "The merge-state sweeper will catch this when it next runs.",
        })
      );
      return;
    }

    const syncPromise: Promise<void> = runMergeStateSyncViaTaskId(
      cfg.mcpUrl,
      cfg.mcpToken,
      taskId,
      mergeSha,
      mergedAt,
      deliveryId
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          event: "at_merge_handler.sync_error",
          delivery_id: deliveryId,
          pr: prNumber,
          taskId,
          error: message,
        })
      );
    });

    inflight.add(syncPromise);
    syncPromise.finally(() => inflight.delete(syncPromise));
  });

  const server = Bun.serve({
    port: cfg.port,
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            status: "ok",
            provider: cfg.provider,
            model: cfg.providerModel,
            tier2Enabled: cfg.tier2Enabled,
            inflightCount: inflight.size,
          }),
          { headers: { "content-type": "application/json" } }
        );
      }

      if (request.method === "POST" && url.pathname === "/webhook") {
        const signature = request.headers.get("x-hub-signature-256");
        const deliveryId = request.headers.get("x-github-delivery") ?? "unknown";
        const eventName = request.headers.get("x-github-event");

        // Read body BEFORE the missing-headers check so we can include `action`
        // in the webhook_received log. Body reads are cheap for legitimate
        // payloads; malicious-volume attacks are handled downstream by signature
        // verification rejecting invalid payloads.
        const body = await request.text();

        // Best-effort extract `action` from the JSON body for observability.
        // If the body is not valid JSON or has no `action` field, we emit null.
        let action: string | null = null;
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          if (typeof parsed["action"] === "string") {
            action = parsed["action"];
          }
        } catch {
          // Non-JSON or malformed body — action stays null.
        }

        // Log webhook_received BEFORE the missing-headers check so that requests
        // with absent headers (signature_present: false) still produce a log line.
        // This is the primary diagnostic signal for bad-actor or misconfigured senders.
        console.log(
          JSON.stringify({
            event: "webhook_received",
            delivery_id: deliveryId,
            github_event: eventName ?? null,
            action,
            signature_present: Boolean(signature),
          })
        );

        if (!signature || !eventName) {
          return new Response("missing signature or event headers", { status: 400 });
        }

        try {
          // verifyAndReceive validates the signature and dispatches to the
          // registered webhook handlers. The handlers call startDetachedReview
          // which returns immediately (fire-and-forget). So this await only
          // blocks for signature verification + event dispatch, not the review.
          await webhooks.verifyAndReceive({
            id: deliveryId,
            name: eventName,
            payload: body,
            signature,
          });
          return new Response("ok", { status: 200 });
        } catch (error) {
          // verifyAndReceive throws on signature-verification failure.
          // Handler errors no longer propagate here since reviews are detached.
          const message = error instanceof Error ? error.message : String(error);
          const isSignatureError = /signature/i.test(message);
          console.error(
            JSON.stringify({
              event: isSignatureError ? "webhook_signature_invalid" : "webhook_dispatch_error",
              delivery_id: deliveryId,
              deliveryId, // deprecated: kept for log-consumer backward compatibility; remove after consumers migrate to delivery_id
              github_event: eventName,
              eventName, // deprecated: kept for log-consumer backward compatibility; remove after consumers migrate to github_event
              error: message,
            })
          );
          return new Response(isSignatureError ? "invalid signature" : "internal error", {
            status: isSignatureError ? 401 : 500,
          });
        }
      }

      return new Response("not found", { status: 404 });
    },
  });

  /**
   * Graceful shutdown for this server instance.
   *
   * 1. Logs drain start with current inflight count.
   * 2. Stops accepting new connections.
   * 3. Waits for all in-flight reviews to settle (max 25s).
   * 4. Logs drain complete and sets exitCode = 0.
   */
  async function gracefulShutdown(): Promise<void> {
    console.log(
      JSON.stringify({
        event: "shutdown_drain_start",
        inflightCount: inflight.size,
      })
    );

    server.stop(true);

    const drain = Promise.allSettled(Array.from(inflight));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 25_000));
    await Promise.race([drain, timeout]);

    console.log(
      JSON.stringify({
        event: "shutdown_drain_complete",
      })
    );

    process.exitCode = 0;
  }

  return { server, gracefulShutdown };
}

// ---------------------------------------------------------------------------
// Module-level startup (production entry point)
//
// Guarded by import.meta.main so this file can be imported in tests without
// triggering loadConfig() (which requires real env vars) or starting a server
// on the production port.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const config = loadConfig();

  // Apply reviewer migrations before starting the server.
  // Fail-fast: if migrations error, log and exit non-zero.
  let db;
  try {
    db = getDb();
    await applyMigrations(db);
    console.log(JSON.stringify({ event: "migrations_applied" }));
  } catch (err: unknown) {
    console.error(
      JSON.stringify({
        event: "migration_error",
        error: err instanceof Error ? err.message : String(err),
      })
    );
    process.exit(1);
  }

  const { server, gracefulShutdown } = createApp(config, runReview, db);

  console.log(
    JSON.stringify({
      event: "server_started",
      port: server.port,
      provider: config.provider,
      model: config.providerModel,
      tier2Enabled: config.tier2Enabled,
      specFetchEnabled: Boolean(config.mcpUrl && config.mcpToken),
    })
  );

  // Register graceful shutdown handlers for SIGTERM and SIGINT.
  // On signal: stop accepting new connections, drain in-flight reviews (max 25s), then exit.
  process.on("SIGTERM", () => {
    gracefulShutdown().catch((err: unknown) => {
      console.error(
        JSON.stringify({
          event: "shutdown_error",
          error: err instanceof Error ? err.message : String(err),
        })
      );
      process.exitCode = 1;
    });
  });

  process.on("SIGINT", () => {
    gracefulShutdown().catch((err: unknown) => {
      console.error(
        JSON.stringify({
          event: "shutdown_error",
          error: err instanceof Error ? err.message : String(err),
        })
      );
      process.exitCode = 1;
    });
  });

  // Start the periodic sweeper safety net (mt#1260).
  // In-process setInterval chosen over Railway cron for simplicity: no separate
  // entry-point, shares the same config/auth already loaded above.
  // Configurable via SWEEPER_ENABLED, SWEEPER_INTERVAL_MS, SWEEPER_REPO_OWNER,
  // SWEEPER_REPO_NAME. Opt-in: sweeper is DISABLED by default; set
  // SWEEPER_ENABLED=true to activate. When disabled, logs event: "sweeper.disabled".
  startSweeper(config, loadSweeperConfig());

  // Start the PR-watch scheduler (mt#1618).
  // Calls pr_watch_run via the Minsky MCP server on a configurable interval so
  // that registered PR watches fire automatically without manual operator action.
  // Configurable via PR_WATCH_ENABLED, PR_WATCH_POLL_INTERVAL_MS.
  // Requires MINSKY_MCP_URL + MINSKY_MCP_TOKEN to be set.
  // Opt-in: disabled by default; set PR_WATCH_ENABLED=true to activate.
  startPrWatchScheduler(config, loadPrWatchSchedulerConfig());

  // Start the Asks-reconcile scheduler (mt#1636).
  // Calls asks_reconcile via the Minsky MCP server on a configurable interval so
  // that quality.review Asks transition to `responded` automatically when a review
  // is posted on the watched PR — without requiring manual operator action.
  // Configurable via ASKS_RECONCILE_ENABLED, ASKS_RECONCILE_POLL_INTERVAL_MS.
  // Requires MINSKY_MCP_URL + MINSKY_MCP_TOKEN to be set.
  // Opt-in: disabled by default; set ASKS_RECONCILE_ENABLED=true to activate.
  startAsksReconcileScheduler(config, loadAsksReconcileSchedulerConfig());

  // Start the merge-state sweeper backstop (mt#1614).
  // Catches sessions stuck in PR_OPEN with closed-merged PRs — the safety net
  // for when the pull_request.closed webhook handler misses an event.
  // Configurable via MERGE_STATE_SWEEPER_ENABLED, MERGE_STATE_SWEEPER_INTERVAL_MS.
  // Requires MINSKY_MCP_URL + MINSKY_MCP_TOKEN to be set.
  // Opt-in: disabled by default; set MERGE_STATE_SWEEPER_ENABLED=true to activate.
  startMergeStateSweeper(config, loadMergeStateSweeperConfig());

  if (config.provider === "anthropic") {
    console.warn(
      JSON.stringify({
        event: "degraded_config_warning",
        message:
          "REVIEWER_PROVIDER=anthropic: implementer and reviewer likely share the Claude model family. Chinese wall captures context-isolation benefit only, not architectural diversity. Consider openai or google for full Sprint A coverage. See services/reviewer/README.md.",
      })
    );
  }
}
