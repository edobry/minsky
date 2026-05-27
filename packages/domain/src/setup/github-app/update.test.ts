/**
 * Tests for updateGithubApp.
 *
 * @see mt#2167
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { updateGithubApp } from "./update";
import type { CredentialStore } from "./credential-store";
import type { AppCredentials } from "./types";

const mockBuildJwt = async (_appId: number, _pem: string) => "fake-jwt-token";

const FAKE_CREDS: AppCredentials = {
  appId: 12345,
  slug: "test-app",
  clientId: "Iv1.abc123",
  clientSecret: "secret123",
  pem: "fake-pem-content",
  htmlUrl: "https://github.com/apps/test-app",
  installationId: 67890,
};

function makeMockStore(creds: AppCredentials | null): CredentialStore {
  return {
    exists: async () => creds !== null,
    read: async () => creds,
    write: async () => {},
  };
}

describe("updateGithubApp", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns error when no credentials exist", async () => {
    const store = makeMockStore(null);
    const result = await updateGithubApp({
      name: "nonexistent",
      store,
      events: ["push"],
      execute: false,
      buildJwt: mockBuildJwt,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("No stored credentials found");
    expect(result.message).toContain("nonexistent");
  });

  it("returns error when neither events nor permissions specified", async () => {
    const store = makeMockStore(FAKE_CREDS);
    const result = await updateGithubApp({
      name: "test-app",
      store,
      execute: false,
      buildJwt: mockBuildJwt,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Nothing to update");
  });

  it("shows dry-run preview without calling PATCH", async () => {
    const store = makeMockStore(FAKE_CREDS);
    const fetchCalls: { url: string; method?: string }[] = [];

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, method: init?.method });

      if (url.endsWith("/app") && !init?.method) {
        return new Response(
          JSON.stringify({
            events: ["pull_request"],
            permissions: { pull_requests: "write", metadata: "read" },
            name: "test-app",
            slug: "test-app",
          }),
          { status: 200 }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const result = await updateGithubApp({
      name: "test-app",
      store,
      events: ["pull_request", "issue_comment"],
      execute: false,
      buildJwt: mockBuildJwt,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.message).toContain("Would update");
    expect(result.message).toContain("issue_comment");
    expect(result.message).toContain("Pass --execute to apply");

    const patchCalls = fetchCalls.filter((c) => c.method === "PATCH");
    expect(patchCalls).toHaveLength(0);
  });

  it("shows no-op message when proposed matches current", async () => {
    const store = makeMockStore(FAKE_CREDS);

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/app") && !init?.method) {
        return new Response(
          JSON.stringify({
            events: ["pull_request"],
            permissions: { pull_requests: "write" },
            name: "test-app",
            slug: "test-app",
          }),
          { status: 200 }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const result = await updateGithubApp({
      name: "test-app",
      store,
      events: ["pull_request"],
      execute: false,
      buildJwt: mockBuildJwt,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.message).toContain("No changes");
    expect(result.message).not.toContain("Would update");
  });

  it("calls PATCH /app when --execute is true", async () => {
    const store = makeMockStore(FAKE_CREDS);
    const fetchCalls: { url: string; method?: string; body?: string }[] = [];

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, method: init?.method, body: init?.body as string });

      if (url.endsWith("/app") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/app")) {
        return new Response(
          JSON.stringify({
            events: ["pull_request", "issue_comment"],
            permissions: { pull_requests: "write", metadata: "read" },
            name: "test-app",
            slug: "test-app",
          }),
          { status: 200 }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const result = await updateGithubApp({
      name: "test-app",
      store,
      events: ["pull_request", "issue_comment"],
      execute: true,
      buildJwt: mockBuildJwt,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.message).toContain("updated successfully");

    const patchCalls = fetchCalls.filter((c) => c.method === "PATCH");
    expect(patchCalls).toHaveLength(1);

    const patchBody = JSON.parse(patchCalls[0]?.body ?? "{}");
    expect(patchBody.default_events).toEqual(["pull_request", "issue_comment"]);
  });

  it("sends permissions via PATCH when specified", async () => {
    const store = makeMockStore(FAKE_CREDS);
    const fetchCalls: { url: string; method?: string; body?: string }[] = [];

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, method: init?.method, body: init?.body as string });

      if (url.endsWith("/app") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/app")) {
        return new Response(
          JSON.stringify({
            events: ["pull_request"],
            permissions: { pull_requests: "write", contents: "read", metadata: "read" },
            name: "test-app",
            slug: "test-app",
          }),
          { status: 200 }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const result = await updateGithubApp({
      name: "test-app",
      store,
      permissions: { pull_requests: "write", contents: "write", metadata: "read" },
      execute: true,
      buildJwt: mockBuildJwt,
    });

    expect(result.success).toBe(true);

    const patchCalls = fetchCalls.filter((c) => c.method === "PATCH");
    expect(patchCalls).toHaveLength(1);

    const patchBody = JSON.parse(patchCalls[0]?.body ?? "{}");
    expect(patchBody.default_permissions).toEqual({
      pull_requests: "write",
      contents: "write",
      metadata: "read",
    });
  });

  it("reports PATCH failure with HTTP status", async () => {
    const store = makeMockStore(FAKE_CREDS);

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/app") && init?.method === "PATCH") {
        return new Response("Validation Failed", { status: 422 });
      }
      if (url.endsWith("/app")) {
        return new Response(
          JSON.stringify({
            events: ["pull_request"],
            permissions: { pull_requests: "write" },
            name: "test-app",
            slug: "test-app",
          }),
          { status: 200 }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const result = await updateGithubApp({
      name: "test-app",
      store,
      events: ["invalid_event"],
      execute: true,
      buildJwt: mockBuildJwt,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("PATCH /app failed");
    expect(result.message).toContain("422");
  });

  it("reports GET /app failure during initial read", async () => {
    const store = makeMockStore(FAKE_CREDS);

    globalThis.fetch = mock(async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const result = await updateGithubApp({
      name: "test-app",
      store,
      events: ["push"],
      execute: false,
      buildJwt: mockBuildJwt,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to read current App config");
    expect(result.message).toContain("401");
  });

  it("uses custom apiBaseUrl when provided", async () => {
    const store = makeMockStore(FAKE_CREDS);
    const fetchCalls: string[] = [];

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push(url);
      return new Response(
        JSON.stringify({
          events: [],
          permissions: {},
          name: "test-app",
          slug: "test-app",
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    await updateGithubApp({
      name: "test-app",
      store,
      events: ["push"],
      execute: false,
      apiBaseUrl: "https://ghe.example.com/api/v3",
      buildJwt: mockBuildJwt,
    });

    expect(fetchCalls[0]).toStartWith("https://ghe.example.com/api/v3/app");
  });
});
