/**
 * Tests for server.ts webhook handler and graceful-shutdown behavior.
 *
 * Strategy:
 *   - Use createApp() with an injected runReviewFn stub and port: 0 (ephemeral)
 *     so tests never touch production config or port 3000.
 *   - Sign POST bodies with @octokit/webhooks-methods so verifyAndReceive
 *     passes — we exercise the real signature check, not a mock.
 *   - Assert 200 within ~1s when runReview is stubbed to a slow promise,
 *     proving the detach-and-respond design is working.
 *   - Test gracefulShutdown by calling it directly with inflight promises
 *     already in flight, verifying the structured log events fire in order.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sign } from "@octokit/webhooks-methods";
import type { ReviewerConfig } from "./config";
import type { ReviewResult } from "./review-worker";
import { createApp, type RunReviewFn } from "./server";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "test-secret-for-server-tests";

// Shared header constant to avoid magic-string duplication lint warnings.
const CONTENT_TYPE_JSON = "application/json";
const HEADER_DELIVERY = "x-github-delivery";
const HEADER_SIGNATURE = "x-hub-signature-256";
const HEADER_EVENT = "x-github-event";
const EVENT_DRAIN_START = "shutdown_drain_start";
const EVENT_DRAIN_COMPLETE = "shutdown_drain_complete";

const BASE_CONFIG: ReviewerConfig = {
  appId: 1,
  privateKey: "",
  installationId: 1,
  webhookSecret: WEBHOOK_SECRET,
  provider: "openai",
  providerApiKey: "sk-fake",
  providerModel: "gpt-5",
  tier2Enabled: false,
  mcpUrl: undefined,
  mcpToken: undefined,
  port: 0, // ephemeral — Bun will pick a random free port
  logLevel: "info",
};

const STUB_REVIEW_RESULT: ReviewResult = {
  status: "reviewed",
  reason: "stub review",
  tier: 3,
};

/** Build a minimal pull_request.opened payload. */
function buildPRPayload(overrides: Partial<{ draft: boolean; prNumber: number }> = {}): string {
  const { draft = false, prNumber = 42 } = overrides;
  return JSON.stringify({
    action: "opened",
    pull_request: {
      number: prNumber,
      user: { login: "author" },
      draft,
      head: { sha: "abc123" },
    },
    repository: {
      owner: { login: "edobry" },
      name: "minsky",
    },
  });
}

/** Sign a payload body and return the x-hub-signature-256 header value. */
async function signPayload(body: string): Promise<string> {
  return sign(WEBHOOK_SECRET, body);
}

/** Send a signed webhook POST to the given server base URL. */
async function sendWebhook(
  baseUrl: string,
  body: string,
  eventName = "pull_request"
): Promise<Response> {
  const signature = await signPayload(body);
  return fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: {
      "content-type": CONTENT_TYPE_JSON,
      [HEADER_SIGNATURE]: signature,
      [HEADER_DELIVERY]: "delivery-001",
      [HEADER_EVENT]: eventName,
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect console.log lines for structured-log assertions. */
function captureConsoleLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return {
    logs,
    restore: () => {
      console.log = original;
    },
  };
}

/** Parse structured log lines and find the first matching event. */
function findLogEvent(logs: string[], eventName: string): Record<string, unknown> | null {
  for (const line of logs) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["event"] === eventName) return parsed;
    } catch {
      // not JSON — skip
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Webhook handler: returns 200 quickly
// ---------------------------------------------------------------------------

describe("webhook handler", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let reviewStarted: Promise<void>;
  let resolveReview: () => void;

  beforeEach(() => {
    // reviewStarted lets the test wait until runReview was actually called.
    reviewStarted = new Promise<void>((res) => {
      resolveReview = res;
    });

    // Slow runReview: signals reviewStarted immediately, then takes 5s to complete.
    const slowRunReview: RunReviewFn = async () => {
      resolveReview();
      // Simulate a review that takes a long time (will be drained by shutdown or
      // just left in-flight for the 200-immediately test).
      await new Promise<void>((res) => setTimeout(res, 5_000));
      return STUB_REVIEW_RESULT;
    };

    ({ server } = createApp(BASE_CONFIG, slowRunReview));
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
    // Stop the server; don't await full drain to keep tests fast.
    server.stop(true);
  });

  test("responds 200 immediately for pull_request.opened, before runReview finishes", async () => {
    const body = buildPRPayload();
    const startMs = performance.now();
    const res = await sendWebhook(baseUrl, body);
    const elapsedMs = performance.now() - startMs;

    expect(res.status).toBe(200);
    // The response should arrive long before the 5s slow runReview resolves.
    // We allow 2s headroom for CI latency.
    expect(elapsedMs).toBeLessThan(2_000);

    // Wait for the review to have been kicked off (resolveReview will be called)
    await reviewStarted;
  });

  test("responds 400 when signature header is absent", async () => {
    const body = buildPRPayload();
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": CONTENT_TYPE_JSON,
        [HEADER_DELIVERY]: "delivery-002",
        [HEADER_EVENT]: "pull_request",
      },
      body,
    });
    expect(res.status).toBe(400);
  });

  test("responds 401 when signature is invalid", async () => {
    const body = buildPRPayload();
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": CONTENT_TYPE_JSON,
        [HEADER_SIGNATURE]: "sha256=badbadbadbad",
        [HEADER_DELIVERY]: "delivery-003",
        [HEADER_EVENT]: "pull_request",
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  test("skips draft PRs — returns 200 without scheduling a review", async () => {
    let reviewWasCalled = false;
    const checkRunReview: RunReviewFn = async () => {
      reviewWasCalled = true;
      return STUB_REVIEW_RESULT;
    };
    // Create a fresh app with a review-tracking stub.
    const { server: draftServer } = createApp(BASE_CONFIG, checkRunReview);
    const draftBase = `http://localhost:${draftServer.port}`;

    try {
      const body = buildPRPayload({ draft: true });
      const res = await sendWebhook(draftBase, body);
      expect(res.status).toBe(200);

      // Give the event loop a tick to confirm nothing was queued.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(reviewWasCalled).toBe(false);
    } finally {
      draftServer.stop(true);
    }
  });

  test("/health returns inflightCount", async () => {
    const body = buildPRPayload();
    // Kick off a slow review so inflight > 0.
    const webhookPromise = sendWebhook(baseUrl, body);

    // Wait for reviewStarted before checking health, so the inflight count is >0.
    await reviewStarted;

    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as Record<string, unknown>;
    expect(typeof healthBody["inflightCount"]).toBe("number");
    expect((healthBody["inflightCount"] as number) >= 1).toBe(true);

    await webhookPromise;
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

describe("gracefulShutdown", () => {
  test("logs shutdown_drain_start with correct inflightCount, then shutdown_drain_complete", async () => {
    const { logs, restore } = captureConsoleLogs();

    // Use a blocking runReview to keep reviews in inflight during drain.
    let releaseReviews: () => void = () => {};
    const reviewsBlocked = new Promise<void>((res) => {
      releaseReviews = res;
    });

    const blockingRunReview: RunReviewFn = async () => {
      await reviewsBlocked;
      return STUB_REVIEW_RESULT;
    };

    const { server: blockServer, gracefulShutdown: blockShutdown } = createApp(
      BASE_CONFIG,
      blockingRunReview
    );
    const blockBase = `http://localhost:${blockServer.port}`;

    // Send two webhooks — both will be in inflight (blocked on reviewsBlocked).
    await Promise.all([
      sendWebhook(blockBase, buildPRPayload({ prNumber: 1 })),
      sendWebhook(blockBase, buildPRPayload({ prNumber: 2 })),
    ]);

    // Give event loop a tick so both promises are registered in inflight.
    await new Promise<void>((r) => setTimeout(r, 20));

    // Start shutdown, then release reviews so drain completes.
    const shutdownPromise = blockShutdown();
    releaseReviews();
    await shutdownPromise;
    restore();

    const drainStart = findLogEvent(logs, EVENT_DRAIN_START);
    const drainComplete = findLogEvent(logs, EVENT_DRAIN_COMPLETE);

    expect(drainStart).toBeTruthy();
    expect(drainComplete).toBeTruthy();

    // drain_start must appear before drain_complete in log order.
    const startIdx = logs.findIndex((l) => l.includes(EVENT_DRAIN_START));
    const completeIdx = logs.findIndex((l) => l.includes(EVENT_DRAIN_COMPLETE));
    expect(startIdx).toBeLessThan(completeIdx);

    // inflightCount in drain_start must be a number.
    expect(typeof (drainStart as Record<string, unknown>)["inflightCount"]).toBe("number");
  });

  test("shutdown_drain_start carries inflightCount=0 when no reviews in flight", async () => {
    const { logs, restore } = captureConsoleLogs();

    const { gracefulShutdown } = createApp(BASE_CONFIG, async () => STUB_REVIEW_RESULT);
    await gracefulShutdown();
    restore();

    const drainStart = findLogEvent(logs, EVENT_DRAIN_START);
    expect(drainStart).toBeTruthy();
    expect((drainStart as Record<string, unknown>)["inflightCount"]).toBe(0);
  });

  test("review errors do NOT prevent graceful shutdown from completing", async () => {
    const errorRunReview: RunReviewFn = async () => {
      throw new Error("simulated review failure");
    };

    const { server: errServer, gracefulShutdown } = createApp(BASE_CONFIG, errorRunReview);
    const errBase = `http://localhost:${errServer.port}`;

    // Kick off a review that will error.
    await sendWebhook(errBase, buildPRPayload());
    await new Promise<void>((r) => setTimeout(r, 20));

    // Shutdown must complete even though the review errored.
    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });
});
