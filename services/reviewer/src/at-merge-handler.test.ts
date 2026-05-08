/**
 * Tests for the pull_request.closed webhook handler (mt#1614 at-merge handler).
 *
 * Verifies:
 *   - A closed+merged PR on a task/mt-N branch calls session.get + apply_post_merge_state_sync.
 *   - A closed-without-merge PR (merged=false) does NOT trigger sync.
 *   - A closed+merged PR on a non-task branch is skipped gracefully.
 *   - When MINSKY_MCP_URL / MINSKY_MCP_TOKEN are absent, the handler logs and returns.
 *   - The handler returns 200 immediately (fire-and-forget), without waiting for MCP calls.
 *
 * Strategy: same pattern as server.test.ts — use createApp() with port=0,
 * sign payloads with @octokit/webhooks-methods, and intercept MCP calls
 * via a globalThis.fetch wrapper that records calls and returns fakes.
 *
 * The fake fetch intercepts only requests to MCP_URL. Real webhook delivery
 * hits the local Bun server (localhost:N/webhook). We patch fetch to
 * pass-through non-MCP URLs while intercepting MCP-bound calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sign } from "@octokit/webhooks-methods";
import type { ReviewerConfig } from "./config";
import { createApp } from "./server";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "test-at-merge-handler-secret";
const MCP_URL = "http://fake-mcp-server:9999/mcp";
const MCP_TOKEN = "test-mcp-token";
const MERGE_SHA = "abc123def456dead";
const MERGED_AT = "2026-05-06T10:00:00.000Z";
const DELIVERY_ID = "delivery-at-merge-001";

const HEADER_CONTENT_TYPE = "content-type";
const HEADER_SIGNATURE = "x-hub-signature-256";
const HEADER_DELIVERY = "x-github-delivery";
const HEADER_EVENT = "x-github-event";
const CONTENT_TYPE_JSON = "application/json";

// ---------------------------------------------------------------------------
// Config fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: ReviewerConfig = {
  appId: 1,
  privateKey: "",
  installationId: 1,
  webhookSecret: WEBHOOK_SECRET,
  provider: "openai",
  providerApiKey: "sk-fake",
  providerModel: "gpt-5",
  tier2Enabled: false,
  mcpUrl: MCP_URL,
  mcpToken: MCP_TOKEN,
  port: 0, // ephemeral
  logLevel: "info",
  modelTimeoutMs: 120_000,
  githubTimeoutMs: 30_000,
};

/** Config without MCP credentials — handler should bail gracefully. */
const NO_MCP_CONFIG: ReviewerConfig = {
  ...BASE_CONFIG,
  mcpUrl: undefined,
  mcpToken: undefined,
};

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

interface ClosedPRPayloadOptions {
  merged?: boolean;
  headRef?: string;
  prNumber?: number;
  mergeCommitSha?: string | null;
  mergedAt?: string | null;
}

function buildClosedPayload(opts: ClosedPRPayloadOptions = {}): string {
  const {
    merged = true,
    headRef = "task/mt-1614",
    prNumber = 999,
    mergeCommitSha = MERGE_SHA,
    mergedAt = MERGED_AT,
  } = opts;
  return JSON.stringify({
    action: "closed",
    pull_request: {
      number: prNumber,
      merged,
      merge_commit_sha: merged ? mergeCommitSha : null,
      merged_at: merged ? mergedAt : null,
      user: { login: "minsky-ai[bot]" },
      head: { ref: headRef, sha: "headsha123" },
      base: { ref: "main" },
    },
    repository: {
      owner: { login: "edobry" },
      name: "minsky",
    },
  });
}

// ---------------------------------------------------------------------------
// Fake fetch infrastructure — intercepts MCP calls without blocking real
// webhook POST to the test server (which goes to localhost, not MCP_URL).
// ---------------------------------------------------------------------------

interface McpCall {
  toolName: string;
  args: Record<string, unknown>;
}

type McpHandler = (toolName: string, args: Record<string, unknown>) => Promise<Response>;

let mcpCalls: McpCall[] = [];
let mcpHandler: McpHandler | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpCalls = [];
  mcpHandler = null;

  // Wrap fetch: MCP calls go to the handler; all others go to the real fetch.
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.startsWith(MCP_URL)) {
      // Intercept MCP call
      const body = JSON.parse(init?.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;
      const args = body.params.arguments;
      mcpCalls.push({ toolName, args });

      if (mcpHandler) {
        return mcpHandler(toolName, args);
      }
      // Default: return success
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "test",
          result: { content: [{ type: "text", text: JSON.stringify({ success: true }) }] },
        }),
        { status: 200, headers: { "Content-Type": CONTENT_TYPE_JSON } }
      );
    }

    // Pass-through: real fetch for webhook delivery to local server
    return originalFetch(input, init);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sendWebhook(
  baseUrl: string,
  body: string,
  eventName = "pull_request"
): Promise<Response> {
  const signature = await sign(WEBHOOK_SECRET, body);
  return globalThis.fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: {
      [HEADER_CONTENT_TYPE]: CONTENT_TYPE_JSON,
      [HEADER_SIGNATURE]: signature,
      [HEADER_DELIVERY]: DELIVERY_ID,
      [HEADER_EVENT]: eventName,
    },
    body,
  });
}

function mcpResponse(data: unknown): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "test",
      result: { content: [{ type: "text", text: JSON.stringify(data) }] },
    }),
    { status: 200, headers: { "Content-Type": CONTENT_TYPE_JSON } }
  );
}

// ---------------------------------------------------------------------------
// Tests: closed+merged PR on task branch
// ---------------------------------------------------------------------------

describe("pull_request.closed webhook — merged=true, task/mt-N branch", () => {
  test("responds 200 immediately before MCP calls complete", async () => {
    let resolveSessionGet: (() => void) | undefined;
    const sessionGetStarted = new Promise<void>((res) => {
      resolveSessionGet = res;
    });

    mcpHandler = async (toolName, _args) => {
      if (toolName === "session.get") {
        resolveSessionGet?.();
        // Simulate slow MCP call — 2 seconds
        await new Promise<void>((r) => setTimeout(r, 2_000));
        return mcpResponse({ session: { sessionId: "test-session-1614" } });
      }
      return mcpResponse({ success: true });
    };

    const { server } = createApp(BASE_CONFIG, async () => ({
      status: "reviewed",
      reason: "stub",
      tier: 3,
    }));
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const body = buildClosedPayload({ merged: true, headRef: "task/mt-1614" });
      const startMs = performance.now();
      const res = await sendWebhook(baseUrl, body);
      const elapsedMs = performance.now() - startMs;

      expect(res.status).toBe(200);
      // Respond before the slow MCP completes (2s timeout, expect < 1s)
      expect(elapsedMs).toBeLessThan(1_000);

      // Wait to confirm MCP was called
      await sessionGetStarted;
    } finally {
      server.stop(true);
    }
  });

  test("calls session.get then apply_post_merge_state_sync for a merged task-branch PR", async () => {
    const SESSION_ID = "session-for-mt-1614";
    const syncCalled: Record<string, unknown>[] = [];

    mcpHandler = async (toolName, args) => {
      if (toolName === "session.get") {
        return mcpResponse({ session: { sessionId: SESSION_ID } });
      }
      if (toolName === "session.apply_post_merge_state_sync") {
        syncCalled.push({ ...args });
        return mcpResponse({ success: true, sessionId: SESSION_ID });
      }
      return mcpResponse({ success: true });
    };

    const { server } = createApp(BASE_CONFIG, async () => ({
      status: "reviewed",
      reason: "stub",
      tier: 3,
    }));
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const body = buildClosedPayload({
        merged: true,
        headRef: "task/mt-1614",
        mergeCommitSha: MERGE_SHA,
        mergedAt: MERGED_AT,
      });

      const res = await sendWebhook(baseUrl, body);
      expect(res.status).toBe(200);

      // Wait for the detached MCP calls to complete.
      await new Promise<void>((r) => setTimeout(r, 200));

      // Verify session.get was called with the task ID
      const sessionGetCalls = mcpCalls.filter((c) => c.toolName === "session.get");
      expect(sessionGetCalls.length).toBeGreaterThan(0);
      expect(sessionGetCalls[0]?.args["task"]).toBe("mt#1614");

      // Verify apply_post_merge_state_sync was called with session + trigger=webhook
      expect(syncCalled.length).toBeGreaterThan(0);
      const syncArgs = syncCalled[0];
      expect(syncArgs).toBeDefined();
      if (!syncArgs) return;
      expect(syncArgs["session"]).toBe(SESSION_ID);
      expect(syncArgs["trigger"]).toBe("webhook");
      expect(syncArgs["mergeSha"]).toBe(MERGE_SHA);
      expect(syncArgs["mergedAt"]).toBe(MERGED_AT);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: closed-without-merge PR — must NOT trigger sync
// ---------------------------------------------------------------------------

describe("pull_request.closed webhook — merged=false (rejected/closed)", () => {
  test("does NOT call MCP tools when PR closed without merge", async () => {
    const { server } = createApp(BASE_CONFIG, async () => ({
      status: "reviewed",
      reason: "stub",
      tier: 3,
    }));
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const body = buildClosedPayload({
        merged: false,
        headRef: "task/mt-1614",
        mergeCommitSha: null,
        mergedAt: null,
      });

      const res = await sendWebhook(baseUrl, body);
      expect(res.status).toBe(200);

      // Wait for event loop to settle.
      await new Promise<void>((r) => setTimeout(r, 100));

      // No MCP calls should have been made.
      const sessionCalls = mcpCalls.filter(
        (c) => c.toolName === "session.get" || c.toolName === "session.apply_post_merge_state_sync"
      );
      expect(sessionCalls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: non-task branches — should be skipped gracefully
// ---------------------------------------------------------------------------

describe("pull_request.closed webhook — non-task branch", () => {
  test("does NOT call MCP tools when branch is not task/mt-N pattern", async () => {
    const { server } = createApp(BASE_CONFIG, async () => ({
      status: "reviewed",
      reason: "stub",
      tier: 3,
    }));
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const body = buildClosedPayload({
        merged: true,
        headRef: "main", // Not a task branch
      });

      const res = await sendWebhook(baseUrl, body);
      expect(res.status).toBe(200);

      await new Promise<void>((r) => setTimeout(r, 100));

      const syncCalls = mcpCalls.filter(
        (c) => c.toolName === "session.apply_post_merge_state_sync"
      );
      expect(syncCalls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("does NOT call MCP for feature-branch style names", async () => {
    const { server } = createApp(BASE_CONFIG, async () => ({
      status: "reviewed",
      reason: "stub",
      tier: 3,
    }));
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const body = buildClosedPayload({
        merged: true,
        headRef: "feature/add-something",
      });

      const res = await sendWebhook(baseUrl, body);
      expect(res.status).toBe(200);

      await new Promise<void>((r) => setTimeout(r, 100));

      expect(mcpCalls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: MCP not configured
// ---------------------------------------------------------------------------

describe("pull_request.closed webhook — MCP not configured", () => {
  test("returns 200 and logs warning when mcpUrl is absent", async () => {
    const { server } = createApp(NO_MCP_CONFIG, async () => ({
      status: "reviewed",
      reason: "stub",
      tier: 3,
    }));
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const body = buildClosedPayload({ merged: true, headRef: "task/mt-1614" });
      const res = await sendWebhook(baseUrl, body);
      expect(res.status).toBe(200);

      await new Promise<void>((r) => setTimeout(r, 100));

      // No MCP calls — config missing
      expect(mcpCalls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: MCP session not found — graceful fallback
// ---------------------------------------------------------------------------

describe("pull_request.closed webhook — MCP session not found", () => {
  test("returns 200 even when session.get returns no session", async () => {
    mcpHandler = async (toolName, _args) => {
      if (toolName === "session.get") {
        // Session not found — returns empty
        return mcpResponse({ success: false, session: null });
      }
      return mcpResponse({ success: true });
    };

    const { server } = createApp(BASE_CONFIG, async () => ({
      status: "reviewed",
      reason: "stub",
      tier: 3,
    }));
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const body = buildClosedPayload({ merged: true, headRef: "task/mt-9999" });
      const res = await sendWebhook(baseUrl, body);
      expect(res.status).toBe(200);

      await new Promise<void>((r) => setTimeout(r, 100));

      // session.get was called
      const sessionGetCalls = mcpCalls.filter((c) => c.toolName === "session.get");
      expect(sessionGetCalls.length).toBeGreaterThan(0);

      // apply_post_merge_state_sync should NOT have been called
      const syncCalls = mcpCalls.filter(
        (c) => c.toolName === "session.apply_post_merge_state_sync"
      );
      expect(syncCalls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });
});
