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

const config = loadConfig();

const webhooks = new Webhooks({
  secret: config.webhookSecret,
});

interface PullRequestPayload {
  pull_request: {
    number: number;
    user: { login: string };
    draft: boolean;
    head: { sha: string };
  };
  repository: { owner: { login: string }; name: string };
}

async function handlePullRequestEvent(
  payload: PullRequestPayload,
  deliveryId: string
): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const prAuthor = payload.pull_request.user.login;
  const headSha = payload.pull_request.head.sha;

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

  const result = await runReview(config, owner, repo, prNumber, prAuthor, deliveryId, headSha);
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
      delivery_id: deliveryId,
      sha: headSha,
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

if (config.provider === "anthropic") {
  console.warn(
    JSON.stringify({
      event: "degraded_config_warning",
      message:
        "REVIEWER_PROVIDER=anthropic: implementer and reviewer likely share the Claude model family. Chinese wall captures context-isolation benefit only, not architectural diversity. Consider openai or google for full Sprint A coverage. See services/reviewer/README.md.",
    })
  );
}
