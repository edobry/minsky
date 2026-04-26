/**
 * minsky-reviewer webhook server.
 *
 * Stateless HTTP service. Receives GitHub webhooks, verifies signatures,
 * dispatches to the review worker, posts results back to GitHub.
 *
 * Deploys to Railway (or any Node-compatible target). See DEPLOY.md.
 */

import { Webhooks } from "@octokit/webhooks";
import { loadConfig } from "./config";
import { runReview } from "./review-worker";
import { loadSweeperConfig, startSweeper } from "./sweeper";

const config = loadConfig();

const webhooks = new Webhooks({
  secret: config.webhookSecret,
});

interface PullRequestPayload {
  pull_request: {
    number: number;
    user: { login: string };
    draft: boolean;
  };
  repository: { owner: { login: string }; name: string };
}

async function handlePullRequestEvent(payload: PullRequestPayload): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const prAuthor = payload.pull_request.user.login;

  if (payload.pull_request.draft) {
    console.log(
      JSON.stringify({
        event: "skip_draft",
        pr: prNumber,
        owner,
        repo,
      })
    );
    return;
  }

  const result = await runReview(config, owner, repo, prNumber, prAuthor);
  // Note: runReview is NOT wrapped in try/catch here. Errors propagate to
  // webhooks.verifyAndReceive → HTTP 500 → GitHub retries the delivery.
  // This is load-bearing for the Tier-3 mandatory-review guarantee: a
  // transient model/GitHub API failure would otherwise be swallowed, leaving
  // the mandatory review undone with no evidence beyond a log line.
  // Cost: on persistent failures (bad config, exhausted quota) GitHub will
  // retry several times before giving up; duplicate reviews are possible on
  // flaky errors. Sprint B adds per-SHA idempotency to eliminate duplicates.
  console.log(
    JSON.stringify({
      event: "review_result",
      pr: prNumber,
      owner,
      repo,
      status: result.status,
      reason: result.reason,
      tier: result.tier,
      reviewUrl: result.review?.htmlUrl,
      provider: result.providerUsed,
      model: result.providerModel,
      usage: result.usage,
      taskSpecFetch: result.taskSpecFetch,
    })
  );
}

webhooks.on("pull_request.opened", async ({ payload }) => {
  await handlePullRequestEvent(payload as PullRequestPayload);
});

webhooks.on("pull_request.synchronize", async ({ payload }) => {
  await handlePullRequestEvent(payload as PullRequestPayload);
});

webhooks.on("pull_request.reopened", async ({ payload }) => {
  await handlePullRequestEvent(payload as PullRequestPayload);
});

const server = Bun.serve({
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          provider: config.provider,
          model: config.providerModel,
          tier2Enabled: config.tier2Enabled,
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const signature = request.headers.get("x-hub-signature-256");
      const deliveryId = request.headers.get("x-github-delivery") ?? "unknown";
      const eventName = request.headers.get("x-github-event");
      const body = await request.text();

      if (!signature || !eventName) {
        return new Response("missing signature or event headers", { status: 400 });
      }

      try {
        await webhooks.verifyAndReceive({
          id: deliveryId,
          name: eventName,
          payload: body,
          signature,
        });
        return new Response("ok", { status: 200 });
      } catch (error) {
        // verifyAndReceive throws on both signature-verification failure
        // and handler errors; we can't distinguish perfectly at this layer.
        // Log the error and return 401 for the common bad-signature case;
        // legitimate handler errors appear in logs for debugging.
        const message = error instanceof Error ? error.message : String(error);
        const isSignatureError = /signature/i.test(message);
        console.error(
          JSON.stringify({
            event: isSignatureError ? "webhook_signature_invalid" : "webhook_dispatch_error",
            deliveryId,
            eventName,
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
