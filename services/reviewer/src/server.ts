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

  webhooks.on("pull_request.opened", async ({ id, payload }) => {
    await handlePullRequestEvent(payload as PullRequestPayload, id);
  });

  webhooks.on("pull_request.synchronize", async ({ id, payload }) => {
    await handlePullRequestEvent(payload as PullRequestPayload, id);
  });

  webhooks.on("pull_request.reopened", async ({ id, payload }) => {
    await handlePullRequestEvent(payload as PullRequestPayload, id);
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
