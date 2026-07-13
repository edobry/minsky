/**
 * Tests for the /review comment command handler (mt#2127).
 *
 * Uses createApp with a mock runReviewFn to verify the webhook handler
 * correctly gates on PR state, command pattern, and author association.
 */

import { describe, test, expect, mock } from "bun:test";
import { createApp, type RunReviewFn } from "./server";
import type { ReviewerConfig } from "./config";
import { createHmac } from "crypto";

const TEST_SECRET = "test-webhook-secret-for-mt2127";
// mt#2356: /retrigger auth uses the MCP auth token (cfg.mcpToken), NOT the
// webhook HMAC secret (mt#2346 re-authed the endpoint). Distinct constant so
// the tests exercise the real credential and stay hermetic regardless of env.
const TEST_MCP_TOKEN = "test-mcp-token-for-mt2346";
const JSON_CONTENT_TYPE = "application/json";

function makeConfig(overrides?: Partial<ReviewerConfig>): ReviewerConfig {
  return {
    appId: 1,
    privateKey: "fake-key",
    installationId: 1,
    webhookSecret: TEST_SECRET,
    provider: "openai",
    providerApiKey: "fake",
    providerModel: "gpt-5",
    tier2Enabled: false,
    mcpUrl: undefined,
    mcpToken: undefined,
    port: 0,
    logLevel: "error",
    modelTimeoutMs: 5000,
    githubTimeoutMs: 5000,
    ...overrides,
  };
}

function signPayload(payload: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${sig}`;
}

function makeIssueCommentPayload(overrides?: {
  state?: string;
  body?: string;
  association?: string;
  hasPullRequest?: boolean;
}): Record<string, unknown> {
  return {
    action: "created",
    issue: {
      number: 42,
      state: overrides?.state ?? "open",
      ...(overrides?.hasPullRequest !== false
        ? { pull_request: { url: "https://api.github.com/repos/edobry/minsky/pulls/42" } }
        : {}),
      user: { login: "test-author" },
    },
    comment: {
      id: 1,
      body: overrides?.body ?? "/review",
      user: { login: "test-commenter" },
      author_association: overrides?.association ?? "MEMBER",
    },
    repository: { owner: { login: "edobry" }, name: "minsky" },
  };
}

async function sendWebhook(
  server: ReturnType<typeof Bun.serve>,
  event: string,
  payload: Record<string, unknown>
): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, TEST_SECRET);
  const deliveryId = `test-${crypto.randomUUID()}`;

  return fetch(`http://localhost:${server.port}/webhook`, {
    method: "POST",
    headers: {
      "x-hub-signature-256": signature,
      "x-github-delivery": deliveryId,
      "x-github-event": event,
      "content-type": "application/json",
    },
    body,
  });
}

describe("comment command /review", () => {
  test("ignores comments on issues (not PRs)", async () => {
    const runReviewFn = mock(() =>
      Promise.resolve({
        status: "reviewed" as const,
        reason: null,
        tier: 3,
        scope: "normal" as const,
      })
    ) as unknown as RunReviewFn;

    const { server, gracefulShutdown } = createApp(makeConfig(), runReviewFn);

    try {
      const payload = makeIssueCommentPayload({ hasPullRequest: false });
      const res = await sendWebhook(server, "issue_comment", payload);
      expect(res.status).toBe(200);
      expect(runReviewFn).not.toHaveBeenCalled();
    } finally {
      await gracefulShutdown();
    }
  });

  test("ignores comments on closed PRs", async () => {
    const runReviewFn = mock(() =>
      Promise.resolve({
        status: "reviewed" as const,
        reason: null,
        tier: 3,
        scope: "normal" as const,
      })
    ) as unknown as RunReviewFn;

    const { server, gracefulShutdown } = createApp(makeConfig(), runReviewFn);

    try {
      const payload = makeIssueCommentPayload({ state: "closed" });
      const res = await sendWebhook(server, "issue_comment", payload);
      expect(res.status).toBe(200);
      expect(runReviewFn).not.toHaveBeenCalled();
    } finally {
      await gracefulShutdown();
    }
  });

  test("ignores non-/review comments", async () => {
    const runReviewFn = mock(() =>
      Promise.resolve({
        status: "reviewed" as const,
        reason: null,
        tier: 3,
        scope: "normal" as const,
      })
    ) as unknown as RunReviewFn;

    const { server, gracefulShutdown } = createApp(makeConfig(), runReviewFn);

    try {
      const payload = makeIssueCommentPayload({ body: "looks good to me" });
      const res = await sendWebhook(server, "issue_comment", payload);
      expect(res.status).toBe(200);
      expect(runReviewFn).not.toHaveBeenCalled();
    } finally {
      await gracefulShutdown();
    }
  });

  test("ignores embedded /review in longer text", async () => {
    const runReviewFn = mock(() =>
      Promise.resolve({
        status: "reviewed" as const,
        reason: null,
        tier: 3,
        scope: "normal" as const,
      })
    ) as unknown as RunReviewFn;

    const { server, gracefulShutdown } = createApp(makeConfig(), runReviewFn);

    try {
      const payload = makeIssueCommentPayload({ body: "some text /review more text" });
      const res = await sendWebhook(server, "issue_comment", payload);
      expect(res.status).toBe(200);
      expect(runReviewFn).not.toHaveBeenCalled();
    } finally {
      await gracefulShutdown();
    }
  });

  test("ignores /review from non-collaborators", async () => {
    const runReviewFn = mock(() =>
      Promise.resolve({
        status: "reviewed" as const,
        reason: null,
        tier: 3,
        scope: "normal" as const,
      })
    ) as unknown as RunReviewFn;

    const { server, gracefulShutdown } = createApp(makeConfig(), runReviewFn);

    try {
      const payload = makeIssueCommentPayload({ association: "NONE" });
      const res = await sendWebhook(server, "issue_comment", payload);
      expect(res.status).toBe(200);
      expect(runReviewFn).not.toHaveBeenCalled();
    } finally {
      await gracefulShutdown();
    }
  });

  test("ignores /review from first-time contributors", async () => {
    const runReviewFn = mock(() =>
      Promise.resolve({
        status: "reviewed" as const,
        reason: null,
        tier: 3,
        scope: "normal" as const,
      })
    ) as unknown as RunReviewFn;

    const { server, gracefulShutdown } = createApp(makeConfig(), runReviewFn);

    try {
      const payload = makeIssueCommentPayload({ association: "FIRST_TIME_CONTRIBUTOR" });
      const res = await sendWebhook(server, "issue_comment", payload);
      expect(res.status).toBe(200);
      expect(runReviewFn).not.toHaveBeenCalled();
    } finally {
      await gracefulShutdown();
    }
  });
});

describe("/retrigger endpoint", () => {
  test("rejects unauthenticated requests", async () => {
    const runReviewFn = mock(() =>
      Promise.resolve({
        status: "reviewed" as const,
        reason: null,
        tier: 3,
        scope: "normal" as const,
      })
    ) as unknown as RunReviewFn;

    const { server, gracefulShutdown } = createApp(
      makeConfig({ mcpToken: TEST_MCP_TOKEN }),
      runReviewFn
    );

    try {
      const res = await fetch(`http://localhost:${server.port}/retrigger`, {
        method: "POST",
        headers: { "content-type": JSON_CONTENT_TYPE },
        body: JSON.stringify({ pr: 42, owner: "edobry", repo: "minsky" }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unauthorized");
      // mt#2356: a rejected request must not trigger a review (no side effects).
      expect(runReviewFn).not.toHaveBeenCalled();
    } finally {
      await gracefulShutdown();
    }
  });

  test("rejects missing pr field", async () => {
    const runReviewFn = mock(() =>
      Promise.resolve({
        status: "reviewed" as const,
        reason: null,
        tier: 3,
        scope: "normal" as const,
      })
    ) as unknown as RunReviewFn;

    const { server, gracefulShutdown } = createApp(
      makeConfig({ mcpToken: TEST_MCP_TOKEN }),
      runReviewFn
    );

    try {
      const res = await fetch(`http://localhost:${server.port}/retrigger`, {
        method: "POST",
        headers: {
          "content-type": JSON_CONTENT_TYPE,
          authorization: `Bearer ${TEST_MCP_TOKEN}`,
        },
        body: JSON.stringify({ owner: "edobry", repo: "minsky" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("pr");
      // mt#2356: a rejected request must not trigger a review (no side effects).
      expect(runReviewFn).not.toHaveBeenCalled();
    } finally {
      await gracefulShutdown();
    }
  });

  test("rejects missing owner field", async () => {
    const runReviewFn = mock(() =>
      Promise.resolve({
        status: "reviewed" as const,
        reason: null,
        tier: 3,
        scope: "normal" as const,
      })
    ) as unknown as RunReviewFn;

    const { server, gracefulShutdown } = createApp(
      makeConfig({ mcpToken: TEST_MCP_TOKEN }),
      runReviewFn
    );

    try {
      const res = await fetch(`http://localhost:${server.port}/retrigger`, {
        method: "POST",
        headers: {
          "content-type": JSON_CONTENT_TYPE,
          authorization: `Bearer ${TEST_MCP_TOKEN}`,
        },
        body: JSON.stringify({ pr: 42, repo: "minsky" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("owner");
      // mt#2356: a rejected request must not trigger a review (no side effects).
      expect(runReviewFn).not.toHaveBeenCalled();
    } finally {
      await gracefulShutdown();
    }
  });

  test("rejects missing repo field", async () => {
    const runReviewFn = mock(() =>
      Promise.resolve({
        status: "reviewed" as const,
        reason: null,
        tier: 3,
        scope: "normal" as const,
      })
    ) as unknown as RunReviewFn;

    const { server, gracefulShutdown } = createApp(
      makeConfig({ mcpToken: TEST_MCP_TOKEN }),
      runReviewFn
    );

    try {
      const res = await fetch(`http://localhost:${server.port}/retrigger`, {
        method: "POST",
        headers: {
          "content-type": JSON_CONTENT_TYPE,
          authorization: `Bearer ${TEST_MCP_TOKEN}`,
        },
        body: JSON.stringify({ pr: 42, owner: "edobry" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("repo");
      // mt#2356: a rejected request must not trigger a review (no side effects).
      expect(runReviewFn).not.toHaveBeenCalled();
    } finally {
      await gracefulShutdown();
    }
  });
});
