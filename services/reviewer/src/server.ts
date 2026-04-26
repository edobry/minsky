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

// GitHub webhook payloads are bounded by GitHub at ~25MB, but typical PR
// events are well under 1MB. We cap reads at 5MB to prevent unauthenticated
// senders from triggering unbounded memory allocation before signature
// verification. Content-Length is checked first; if absent or zero, we let
// the read proceed (body will be bounded by the streaming limit Bun applies).
export const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB

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
      scope: result.scope,
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

/**
 * Handle a POST /webhook request. Extracted from the Bun.serve fetch handler
 * so it can be unit-tested without binding to a port.
 *
 * Exported for tests. The `verifyAndReceive` parameter is injected so tests
 * can stub out the @octokit/webhooks call without importing the module.
 *
 * Log-shape tests for `webhook_received` should follow the `buildRunReviewStartLog`
 * pattern in review-worker.test.ts — extract the log-shape as a pure function
 * and assert on it directly, rather than asserting on console.log spy output.
 * (Future log-shape tests for server.ts are tracked in the follow-up task.)
 */
export async function handleWebhookRequest(
  request: Request,
  verifyAndReceive: (params: {
    id: string;
    name: string;
    payload: string;
    signature: string;
  }) => Promise<void>
): Promise<Response> {
  const signature = request.headers.get("x-hub-signature-256");
  const deliveryId = request.headers.get("x-github-delivery") ?? "unknown";
  const eventName = request.headers.get("x-github-event");

  // Enforce a body-size cap BEFORE reading to prevent unauthenticated senders
  // from triggering unbounded memory allocation. Check Content-Length first
  // (zero means absent/unset — treat as allowed and let the streaming read
  // proceed normally). Real oversized requests set a positive Content-Length.
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    // Log at receipt without body (body not read), then reject.
    console.log(
      JSON.stringify({
        event: "webhook_received",
        delivery_id: deliveryId,
        github_event: eventName ?? null,
        action: undefined,
        // signature_present: whether the header key is present (not whether the value
        // is truthy). Empty-string header → null via getHeader → false is incorrect;
        // `!== null` captures the presence semantics we mean.
        signature_present: signature !== null,
        rejected: "body_too_large",
      })
    );
    return new Response("body too large", { status: 413 });
  }

  // Read body BEFORE the missing-headers check so we can include `action`
  // in the webhook_received log. The body-size cap above guards against
  // unauthenticated large-body reads; the actual read here is safe.
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
  //
  // `signature_present` uses `!== null` rather than `Boolean(signature)` so that
  // an empty-string header value reports true (header IS present, just empty).
  console.log(
    JSON.stringify({
      event: "webhook_received",
      delivery_id: deliveryId,
      github_event: eventName ?? null,
      action,
      signature_present: signature !== null,
    })
  );

  if (!signature || !eventName) {
    return new Response("missing signature or event headers", { status: 400 });
  }

  try {
    await verifyAndReceive({
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
      return handleWebhookRequest(request, (params) => webhooks.verifyAndReceive(params));
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
