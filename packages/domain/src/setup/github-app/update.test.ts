/**
 * Tests for updateGithubApp.
 *
 * @see mt#3218 — rewritten after discovering the PATCH /app endpoint this
 *   module previously called does not exist (404 on every real invocation).
 *   These tests assert the real contract: GET /app to read current state,
 *   NO mutating call, and an actionable message naming the settings URL.
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

  it("shows no-op message when proposed matches current, with no mutating request", async () => {
    const store = makeMockStore(FAKE_CREDS);
    const fetchCalls: { url: string; method?: string }[] = [];

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, method: init?.method });
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

    // No request other than the GET /app read was made.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.method).toBeUndefined();
  });

  it("no-op when permissions match but are ordered differently (PR #2317 R1)", async () => {
    // GET /app can return permission keys in a different order than the
    // caller's --permissions map was parsed in. JSON.stringify compares by
    // insertion order, so a naive comparison would false-positive as drift.
    const store = makeMockStore(FAKE_CREDS);

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/app") && !init?.method) {
        return new Response(
          JSON.stringify({
            events: [],
            // Live order: contents, then pull_requests, then metadata.
            permissions: { contents: "write", pull_requests: "write", metadata: "read" },
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
      // Requested order: pull_requests, then metadata, then contents — same
      // set, different insertion order.
      permissions: { pull_requests: "write", metadata: "read", contents: "write" },
      execute: false,
      buildJwt: mockBuildJwt,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("No changes");
  });

  it("never issues a PATCH request, regardless of --execute", async () => {
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
      execute: true,
      buildJwt: mockBuildJwt,
    });

    const patchCalls = fetchCalls.filter((c) => c.method === "PATCH");
    expect(patchCalls).toHaveLength(0);

    expect(result.success).toBe(false);
    expect(result.dryRun).toBe(true);
  });

  it("names the exact settings URL and the specific field that differs", async () => {
    const store = makeMockStore(FAKE_CREDS);

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/app") && !init?.method) {
        return new Response(
          JSON.stringify({
            events: ["pull_request"],
            permissions: { pull_requests: "write", contents: "read", metadata: "read" },
            name: "test-app",
            slug: "minsky-ai",
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

    expect(result.success).toBe(false);
    expect(result.settingsUrl).toBe("https://github.com/settings/apps/minsky-ai/permissions");
    expect(result.message).toContain("https://github.com/settings/apps/minsky-ai/permissions");
    expect(result.message).toContain("contents:read");
    expect(result.message).toContain("contents:write");
    expect(result.message).toMatch(/no api/i);
    expect(result.message).toMatch(/accept/i);
    expect(result.message).toContain("--execute was passed but has no effect");
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
