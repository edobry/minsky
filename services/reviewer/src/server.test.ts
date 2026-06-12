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
import type { AlertSink } from "./alert-sink";

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
  modelTimeoutMs: 120_000,
  githubTimeoutMs: 30_000,
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

/**
 * Capture lines written to process.stdout during a test.
 *
 * Winston's Console transport writes to process.stdout.write directly,
 * bypassing the standard `console` global. We intercept at the stream
 * level so the winston path is captured regardless of which logger API
 * the code under test uses.
 */
function captureConsoleLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  // process.stdout.write can be called with (string | Buffer, ...) — we only
  // care about the string form that winston produces.
  // Node's overloaded WriteStream.write signatures use `Error | undefined` for
  // the callback err parameter. We must match that exactly (not `Error | null`)
  // or TS rejects the assignment with TS2322 — see PR #1017 CI fix from mt#1255.
  process.stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void
  ): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    // Winston emits one JSON object per line followed by "\n".
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) logs.push(trimmed);
    }
    // Call the real write so other transports / the terminal still work.
    if (typeof encodingOrCb === "function") {
      return originalWrite(chunk, encodingOrCb);
    }
    if (cb !== undefined) {
      return originalWrite(chunk, encodingOrCb as BufferEncoding, cb);
    }
    if (encodingOrCb !== undefined) {
      return originalWrite(chunk, encodingOrCb as BufferEncoding);
    }
    return originalWrite(chunk);
  };

  return {
    logs,
    restore: () => {
      process.stdout.write = originalWrite;
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

  test("missing x-github-delivery synthesizes a unique synthetic-<uuid> per request (R2 BLOCKING regression)", async () => {
    // R2 BLOCKING fix: when x-github-delivery is absent, the server previously
    // fell back to the literal "unknown". Combined with the DO NOTHING upsert
    // semantics from R1 BLOCKING #1, that collapsed every missing-header POST
    // into a single row — defeating the "persist every webhook" goal.
    // The fix synthesizes "synthetic-${crypto.randomUUID()}" per request.
    const { logs, restore } = captureConsoleLogs();

    try {
      const body = buildPRPayload();

      // Two POSTs without x-github-delivery; signature and event present so
      // the handler reaches the persistence path before any 400.
      const signature = await signPayload(body);
      await Promise.all([
        fetch(`${baseUrl}/webhook`, {
          method: "POST",
          headers: {
            "content-type": CONTENT_TYPE_JSON,
            [HEADER_SIGNATURE]: signature,
            [HEADER_EVENT]: "pull_request",
            // x-github-delivery deliberately omitted
          },
          body,
        }),
        fetch(`${baseUrl}/webhook`, {
          method: "POST",
          headers: {
            "content-type": CONTENT_TYPE_JSON,
            [HEADER_SIGNATURE]: signature,
            [HEADER_EVENT]: "pull_request",
            // x-github-delivery deliberately omitted
          },
          body,
        }),
      ]);

      // Tick to let both webhook_received log lines flush.
      await new Promise<void>((r) => setTimeout(r, 50));

      // Collect every webhook_received log entry and inspect their delivery_id.
      const webhookReceivedEntries: string[] = [];
      for (const line of logs) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed["event"] === "webhook_received") {
            const id = parsed["delivery_id"];
            if (typeof id === "string") webhookReceivedEntries.push(id);
          }
        } catch {
          // not JSON — skip
        }
      }

      expect(webhookReceivedEntries.length).toBe(2);
      // Both delivery_ids must be synthetic (i.e., not "unknown" and not absent).
      expect(webhookReceivedEntries[0]).toMatch(/^synthetic-/);
      expect(webhookReceivedEntries[1]).toMatch(/^synthetic-/);
      // The two synthesized IDs must be distinct — uniqueness via crypto.randomUUID().
      // If they collide, the DO NOTHING upsert silently drops one row.
      expect(webhookReceivedEntries[0]).not.toBe(webhookReceivedEntries[1]);
    } finally {
      restore();
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

    try {
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
    } finally {
      // Always restore stdout, even if an assertion above threw — otherwise
      // the patched write leaks into sibling tests and causes flake.
      restore();
    }
  });

  test("shutdown_drain_start carries inflightCount=0 when no reviews in flight", async () => {
    const { logs, restore } = captureConsoleLogs();

    try {
      const { gracefulShutdown } = createApp(BASE_CONFIG, async () => STUB_REVIEW_RESULT);
      await gracefulShutdown();

      const drainStart = findLogEvent(logs, EVENT_DRAIN_START);
      expect(drainStart).toBeTruthy();
      expect((drainStart as Record<string, unknown>)["inflightCount"]).toBe(0);
    } finally {
      restore();
    }
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

// ---------------------------------------------------------------------------
// /retrigger auth (mt#2346): authenticated by the MCP auth token (cfg.mcpToken,
// from MINSKY_MCP_AUTH_TOKEN), NOT the webhook HMAC secret.
// ---------------------------------------------------------------------------

describe("/retrigger auth (mt#2346)", () => {
  const MCP_TOKEN = "test-mcp-auth-token";
  const CONFIG_WITH_MCP_TOKEN: ReviewerConfig = { ...BASE_CONFIG, mcpToken: MCP_TOKEN };

  // runReview is never reached by these auth-focused tests: they either fail
  // auth, or pass auth and fail body validation before any dispatch.
  const noopRunReview: RunReviewFn = async () => STUB_REVIEW_RESULT;

  async function postRetrigger(
    baseUrl: string,
    auth: string | undefined,
    body: unknown
  ): Promise<Response> {
    return fetch(`${baseUrl}/retrigger`, {
      method: "POST",
      headers: {
        "content-type": CONTENT_TYPE_JSON,
        ...(auth !== undefined ? { authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  test("accepts the MCP auth token — passes auth, reaches body validation (400, not 401)", async () => {
    const { server } = createApp(CONFIG_WITH_MCP_TOKEN, noopRunReview);
    try {
      // Correct token but an invalid (empty) body: a 400 — rather than 401 —
      // proves the request got PAST the auth gate to body validation.
      const res = await postRetrigger(`http://localhost:${server.port}`, `Bearer ${MCP_TOKEN}`, {});
      expect(res.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });

  test("rejects the webhook HMAC secret — no longer valid retrigger auth (SC: secret is webhook-only)", async () => {
    const { server } = createApp(CONFIG_WITH_MCP_TOKEN, noopRunReview);
    try {
      const res = await postRetrigger(
        `http://localhost:${server.port}`,
        `Bearer ${CONFIG_WITH_MCP_TOKEN.webhookSecret}`,
        { pr: 1, owner: "o", repo: "r" }
      );
      expect(res.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  test("rejects a missing Authorization header with 401", async () => {
    const { server } = createApp(CONFIG_WITH_MCP_TOKEN, noopRunReview);
    try {
      const res = await postRetrigger(`http://localhost:${server.port}`, undefined, {
        pr: 1,
        owner: "o",
        repo: "r",
      });
      expect(res.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  test("returns 503 when MINSKY_MCP_AUTH_TOKEN is unset on the service (fail closed)", async () => {
    // BASE_CONFIG has mcpToken: undefined.
    const { server } = createApp(BASE_CONFIG, noopRunReview);
    try {
      const res = await postRetrigger(`http://localhost:${server.port}`, `Bearer anything`, {
        pr: 1,
        owner: "o",
        repo: "r",
      });
      expect(res.status).toBe(503);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// /alert-test (mt#2451): on-demand test send through the deployed alert sink.
// Same bearer auth as /retrigger (cfg.mcpToken). Mirrors the /retrigger tests.
// ---------------------------------------------------------------------------

describe("/alert-test (mt#2451)", () => {
  const MCP_TOKEN = "test-mcp-auth-token";
  const CONFIG_WITH_MCP_TOKEN: ReviewerConfig = { ...BASE_CONFIG, mcpToken: MCP_TOKEN };
  const noopRunReview: RunReviewFn = async () => STUB_REVIEW_RESULT;

  type RecordingSink = AlertSink & {
    calls: Array<{ severity: string; title: string; body: string }>;
  };

  /** Fake AlertSink that records each notify() call. */
  function makeFakeSink(): RecordingSink {
    const calls: Array<{ severity: string; title: string; body: string }> = [];
    return {
      calls,
      async notify(severity, title, body) {
        calls.push({ severity, title, body });
      },
    };
  }

  async function postAlertTest(baseUrl: string, auth: string | undefined): Promise<Response> {
    return fetch(`${baseUrl}/alert-test`, {
      method: "POST",
      headers: { ...(auth !== undefined ? { authorization: auth } : {}) },
    });
  }

  test("returns 503 when MINSKY_MCP_AUTH_TOKEN is unset (fail closed)", async () => {
    // BASE_CONFIG has mcpToken: undefined.
    const { server } = createApp(BASE_CONFIG, noopRunReview);
    try {
      const res = await postAlertTest(`http://localhost:${server.port}`, "Bearer anything");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("alert-test auth not configured");
    } finally {
      server.stop(true);
    }
  });

  test("rejects a missing Authorization header with 401", async () => {
    const { server } = createApp(
      CONFIG_WITH_MCP_TOKEN,
      noopRunReview,
      undefined,
      undefined,
      makeFakeSink()
    );
    try {
      const res = await postAlertTest(`http://localhost:${server.port}`, undefined);
      expect(res.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  test("rejects a wrong bearer token with 401", async () => {
    const { server } = createApp(
      CONFIG_WITH_MCP_TOKEN,
      noopRunReview,
      undefined,
      undefined,
      makeFakeSink()
    );
    try {
      const res = await postAlertTest(`http://localhost:${server.port}`, "Bearer wrong-token");
      expect(res.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  test("returns 503 with an actionable message when authed but no sink is configured", async () => {
    // Inject null to represent ALERT_SINK_TYPE unset/off.
    const { server } = createApp(CONFIG_WITH_MCP_TOKEN, noopRunReview, undefined, undefined, null);
    try {
      const res = await postAlertTest(`http://localhost:${server.port}`, `Bearer ${MCP_TOKEN}`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; hint?: string };
      expect(body.error).toBe("no alert sink configured");
      expect(body.hint).toContain("ALERT_SINK_TYPE");
    } finally {
      server.stop(true);
    }
  });

  test("authed + sink configured → 200 and sends an info-severity message through the SAME sink instance", async () => {
    const fake = makeFakeSink();
    const { server } = createApp(CONFIG_WITH_MCP_TOKEN, noopRunReview, undefined, undefined, fake);
    try {
      const res = await postAlertTest(`http://localhost:${server.port}`, `Bearer ${MCP_TOKEN}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; deliveryAttempted: boolean };
      expect(body.ok).toBe(true);
      expect(body.deliveryAttempted).toBe(true);
      // The send path was actually invoked on the injected (shared) sink.
      expect(fake.calls.length).toBe(1);
      expect(fake.calls[0]?.severity).toBe("info");
      expect(fake.calls[0]?.title).toContain("alert test");
    } finally {
      server.stop(true);
    }
  });
});
