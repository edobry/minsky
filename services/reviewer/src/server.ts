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
import { loadConfig, parsePositiveIntEnv } from "./config";
import { log } from "./logger";
import type { ReviewResult } from "./review-worker";
import { runReview } from "./review-worker";
import { loadSweeperConfig, startSweeper } from "./sweeper";
import { loadPrWatchSchedulerConfig, startPrWatchScheduler } from "./pr-watch-scheduler";
import {
  loadAsksReconcileSchedulerConfig,
  startAsksReconcileScheduler,
} from "./asks-reconcile-scheduler";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import { callMcp } from "./mcp-client";
import { loadMergeStateSweeperConfig, startMergeStateSweeper } from "./merge-state-sweeper";
import { loadAdoptionSweeperConfig, startAdoptionSweeper } from "./adoption-sweeper";
import { getDb, type ReviewerDb } from "./db/client";
import { applyMigrations } from "./db/migrate";
import {
  recordWebhookReceipt,
  updateOutcome,
  pruneOldRows,
  extractPersistedHeaders,
} from "./webhook-events";

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

/**
 * Type guard: payload is a closed+merged PR event.
 *
 * Narrowing target is just `PullRequestClosedPayload` (without an extra
 * `pull_request: { merged: true }` literal-narrowing intersection) because
 * intersecting our local subset shape with the @octokit-provided event type
 * caused TypeScript to collapse the result to `never` under the stricter
 * services/reviewer tsconfig (PR #1010 R3).
 */
function isMergedClosedPayload(payload: unknown): payload is PullRequestClosedPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (p["action"] !== "closed") return false;
  const pr = p["pull_request"] as Record<string, unknown> | undefined;
  if (!pr) return false;
  return pr["merged"] === true;
}

/** Extract a Minsky task ID from a GitHub head branch name (e.g. "task/mt-1614" → "mt#1614"). */
export function extractTaskIdFromBranch(headRef: string): string | null {
  // Matches: task/mt-1614, task/mt-123-fixups, task/mt-1234/cleanup, task/mt-99_v2.
  // The numeric ID is captured from the start; any [-/_.] separator + suffix is
  // accepted (PR #1010 R1 NB: relax from `^task/mt-(\d+)$`).
  const match = /^task\/mt-(\d+)(?:[-/_.].*)?$/.exec(headRef);
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
   * MCP tool caller for the at-merge webhook handler.
   *
   * Thin adapter over the shared {@link callMcp} helper (mt#1821) — preserves
   * the legacy `string | null` return shape so the at-merge handler callsites
   * don't change. The shared helper performs the MCP initialize handshake
   * and caches the session id; without it the server rejected every
   * `tools/call` with `-32600 "first request must be initialize"` and the
   * at-merge state-sync silently no-op'd.
   *
   * Timeout: 15s, matching the prior in-file `AbortController` + `setTimeout`
   * implementation (per PR #1010 R1 — without a timeout, a hung MCP call
   * kept the detached promise in `inflight` indefinitely). Passed explicitly
   * so any future change to the helper's default does not silently regress
   * the inflight-drain behavior on shutdown.
   *
   * Observability: `callMcp` emits structured `console.warn` events with the
   * `at_merge_handler.mcp` prefix; the legacy
   * `at_merge_handler.mcp_fetch_error` event is preserved.
   */
  async function callMcpToolLocal(
    mcpUrl: string,
    mcpToken: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string | null> {
    const result = await callMcp(
      toolName,
      args,
      { mcpUrl, mcpToken },
      { logPrefix: "at_merge_handler.mcp", timeoutMs: 15_000 }
    );
    return result.ok ? result.contentText : null;
  }

  /**
   * Schedule a review as a detached promise. Calling code returns 200
   * immediately — never await this.
   *
   * Failures are caught and logged as event=review_error. The sweeper
   * (mt#1260) is already live on main as the safety net.
   *
   * Persistence: updates the webhook_events row outcome as the review
   * progresses: reviewer_called → review_submitted OR failed_at_reviewer.
   * Errors from persistence calls are swallowed (see webhook-events.ts).
   */
  function startDetachedReview(payload: PullRequestPayload, deliveryId: string): void {
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = payload.pull_request.number;
    const prAuthor = payload.pull_request.user.login;
    const headSha = payload.pull_request.head.sha;

    // Mark that the reviewer was called (detached review started).
    if (db !== undefined) {
      void updateOutcome(db, deliveryId, "reviewer_called");
    }

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
        log.info("review_result", {
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
        });

        // Persist final outcome: review_submitted on success, failed_at_reviewer otherwise.
        if (db !== undefined) {
          const outcome = result.status === "reviewed" ? "review_submitted" : "failed_at_reviewer";
          void updateOutcome(
            db,
            deliveryId,
            outcome,
            outcome === "failed_at_reviewer"
              ? {
                  message: result.reason ?? "review did not complete with status=reviewed",
                  stage: "reviewer",
                }
              : undefined
          );
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack?.slice(0, 500) : undefined;
        log.error("review_error", {
          event: "review_error",
          delivery_id: deliveryId,
          sha: headSha,
          pr: prNumber,
          owner,
          repo,
          error: message,
        });

        // Persist failure and surface as operator-visible alert.
        // This is the service-side OperatorNotify equivalent (mt#1372):
        // the reviewer service runs on Railway where structured log.error
        // is the operator-visible channel. Distinct from mt#1310 (missing
        // review alert) — this fires on service-side processing failure.
        if (db !== undefined) {
          void updateOutcome(db, deliveryId, "failed_at_reviewer", {
            message,
            stage: "reviewer",
            stack,
          });
        }
        log.error("webhook_processing_failed", {
          event: "webhook_processing_failed",
          delivery_id: deliveryId,
          sha: headSha,
          pr: prNumber,
          owner,
          repo,
          stage: "reviewer",
          error: message,
        });
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
      log.info("skip_draft", {
        event: "skip_draft",
        delivery_id: deliveryId,
        pr: prNumber,
        owner,
        repo,
      });
      // Persist skip outcome for draft PRs.
      if (db !== undefined) {
        void updateOutcome(db, deliveryId, "skipped");
      }
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

    // Call apply_post_merge_state_sync. The MCP command reads `params.sessionId`
    // (not `params.session`) — passing the wrong key throws ResourceNotFoundError
    // at runtime. PR #1010 R2 fix.
    const syncArgs: Record<string, unknown> = {
      sessionId,
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
        // R2 BLOCKING fix: previously fell back to the literal "unknown".
        // Combined with DO NOTHING upsert semantics, that collapsed every
        // missing-header POST into a single row — silently dropping events
        // after the first. Synthesize a UUID per request instead. The
        // "synthetic-" prefix is queryable so operators can distinguish
        // GitHub-supplied IDs from server-synthesized ones.
        const deliveryId =
          request.headers.get("x-github-delivery") ?? `synthetic-${crypto.randomUUID()}`;
        const eventName = request.headers.get("x-github-event");

        // Read body BEFORE the missing-headers check so we can include `action`
        // in the webhook_received log. Body reads are cheap for legitimate
        // payloads; malicious-volume attacks are handled downstream by signature
        // verification rejecting invalid payloads.
        const body = await request.text();

        // Best-effort extract `action` from the JSON body for observability.
        // If the body is not valid JSON or has no `action` field, we emit null.
        let parsedBody: Record<string, unknown> | null = null;
        let action: string | null = null;
        try {
          parsedBody = JSON.parse(body) as Record<string, unknown>;
          if (typeof parsedBody["action"] === "string") {
            action = parsedBody["action"];
          }
        } catch {
          // Non-JSON or malformed body — action stays null, parsedBody stays null.
        }

        // Log webhook_received BEFORE the missing-headers check so that requests
        // with absent headers (signature_present: false) still produce a log line.
        // This is the primary diagnostic signal for bad-actor or misconfigured senders.
        log.info("webhook_received", {
          event: "webhook_received",
          delivery_id: deliveryId,
          github_event: eventName ?? null,
          action,
          signature_present: Boolean(signature),
        });

        // Persist webhook receipt for forensic investigation (mt#1372).
        // Fire-and-forget: recordWebhookReceipt swallows errors internally.
        //
        // R1 BLOCKING #3 fix: persist EVERY webhook the reviewer receives,
        // not just those with x-github-event header. Webhooks with missing
        // or malformed headers are exactly the cases most worth investigating
        // (misconfigured senders, GitHub API changes, malicious probes).
        // Use "unknown" sentinel when eventName is null.
        if (db !== undefined) {
          void recordWebhookReceipt(
            db,
            deliveryId,
            eventName ?? "unknown",
            extractPersistedHeaders((name) => request.headers.get(name)),
            parsedBody ?? { raw: safeTruncate(body, 1000, "head") }
          );
        }

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
          log.error(isSignatureError ? "webhook_signature_invalid" : "webhook_dispatch_error", {
            event: isSignatureError ? "webhook_signature_invalid" : "webhook_dispatch_error",
            delivery_id: deliveryId,
            deliveryId, // deprecated: kept for log-consumer backward compatibility; remove after consumers migrate to delivery_id
            github_event: eventName,
            eventName, // deprecated: kept for log-consumer backward compatibility; remove after consumers migrate to github_event
            error: message,
          });

          // Persist failure outcome and surface as operator-visible alert (mt#1372).
          // Signature failures are expected from misconfigured senders — only non-signature
          // errors (dispatch failures) surface as webhook_processing_failed alerts.
          if (db !== undefined) {
            void updateOutcome(
              db,
              deliveryId,
              isSignatureError ? "failed_at_signature" : "failed_at_tier_resolve",
              { message, stage: isSignatureError ? "signature" : "dispatch" }
            );
          }
          if (!isSignatureError) {
            // Dispatch errors are unexpected — alert the operator (Railway logs).
            log.error("webhook_processing_failed", {
              event: "webhook_processing_failed",
              delivery_id: deliveryId,
              github_event: eventName,
              stage: "dispatch",
              error: message,
            });
          }

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
    log.info("shutdown_drain_start", {
      event: "shutdown_drain_start",
      inflightCount: inflight.size,
    });

    server.stop(true);

    const drain = Promise.allSettled(Array.from(inflight));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 25_000));
    await Promise.race([drain, timeout]);

    log.info("shutdown_drain_complete", {
      event: "shutdown_drain_complete",
    });

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
    log.info("migrations_applied", { event: "migrations_applied" });
  } catch (err: unknown) {
    log.error("migration_error", {
      event: "migration_error",
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  const { server, gracefulShutdown } = createApp(config, runReview, db);

  log.info("server_started", {
    event: "server_started",
    port: server.port,
    provider: config.provider,
    model: config.providerModel,
    tier2Enabled: config.tier2Enabled,
    specFetchEnabled: Boolean(config.mcpUrl && config.mcpToken),
  });

  // Register graceful shutdown handlers for SIGTERM and SIGINT.
  // On signal: stop accepting new connections, drain in-flight reviews (max 25s), then exit.
  process.on("SIGTERM", () => {
    gracefulShutdown().catch((err: unknown) => {
      log.error("shutdown_error", {
        event: "shutdown_error",
        error: err instanceof Error ? err.message : String(err),
      });
      process.exitCode = 1;
    });
  });

  process.on("SIGINT", () => {
    gracefulShutdown().catch((err: unknown) => {
      log.error("shutdown_error", {
        event: "shutdown_error",
        error: err instanceof Error ? err.message : String(err),
      });
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
  // Requires MINSKY_MCP_URL + MINSKY_MCP_TOKEN to be set on the deployed service.
  // **Enabled by default (mt#1811)**: set MERGE_STATE_SWEEPER_ENABLED=false to opt out.
  // If MCP credentials are absent the sweeper logs "missing_credentials" and refuses
  // to start — operators see a clear log line instead of a silent disable.
  startMergeStateSweeper(config, loadMergeStateSweeperConfig());

  // Start the adoption sweeper (mt#1630).
  // Post-merge adoption verification: picks up recently-DONE tasks, extracts
  // adoption signals from specs, greps production callsites, and files
  // mt#X-adoption follow-up tasks for gaps.
  // Configurable via ADOPTION_SWEEPER_ENABLED, ADOPTION_SWEEPER_INTERVAL_MS,
  // ADOPTION_SWEEPER_LOOKBACK_DAYS.
  // Requires MINSKY_MCP_URL + MINSKY_MCP_TOKEN to be set.
  // DEFAULT DISABLED until mt#1711 (env-var wiring) ships.
  // Set ADOPTION_SWEEPER_ENABLED=true to activate.
  startAdoptionSweeper(config, loadAdoptionSweeperConfig());

  // Start the webhook-event retention pruner (mt#1372).
  // Deletes reviewer_webhook_events rows older than MINSKY_REVIEWER_WEBHOOK_EVENT_RETENTION_DAYS
  // (default: 90 days). Runs once every 24 hours. The first prune fires after
  // the first interval to avoid competing with service startup.
  // Configurable via MINSKY_REVIEWER_WEBHOOK_EVENT_RETENTION_DAYS (default: 90).
  // Strict-positive parse (mt#1811 cascade-defense): NaN flowing into
  // pruneOldRows would yield unpredictable retention behavior.
  const webhookRetentionDays = parsePositiveIntEnv(
    "MINSKY_REVIEWER_WEBHOOK_EVENT_RETENTION_DAYS",
    90
  );
  const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  log.info("webhook_retention_pruner_started", {
    event: "webhook_retention_pruner_started",
    retention_days: webhookRetentionDays,
    interval_ms: PRUNE_INTERVAL_MS,
  });
  setInterval(() => {
    pruneOldRows(db, webhookRetentionDays).catch((err: unknown) => {
      log.error("webhook_retention_prune_error", {
        event: "webhook_retention_prune_error",
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, PRUNE_INTERVAL_MS);

  if (config.provider === "anthropic") {
    log.warn("degraded_config_warning", {
      event: "degraded_config_warning",
      message:
        "REVIEWER_PROVIDER=anthropic: implementer and reviewer likely share the Claude model family. Chinese wall captures context-isolation benefit only, not architectural diversity. Consider openai or google for full Sprint A coverage. See services/reviewer/README.md.",
    });
  }
}
