/**
 * Tests for ManifestFlowProvisioner.
 *
 * Hermetic: mocks GitHub API fetch calls and Bun.spawn (browser-open).
 * The local callback server runs for real on a fixed test-only port; tests
 * use distinct ports to avoid collisions.
 *
 * @see mt#1087
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { setupTestMocks } from "../../../utils/test-utils/mocking";
import { ManifestFlowProvisioner } from "./manifest-flow-provisioner";
import { BrowserCancelledError } from "./provisioner";
import type { AppManifestSpec } from "./types";

setupTestMocks();

const SAMPLE_SPEC: AppManifestSpec = {
  name: "test-app",
  repo: "owner/repo",
  owner: "owner",
  permissions: { pull_requests: "write" },
  events: [],
  inactive: true,
};

const FAKE_APP_RESPONSE = {
  id: 12345,
  slug: "test-app",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  client_id: "Iv1.abc",
  client_secret: "shh",
  html_url: "https://github.com/apps/test-app",
};

let originalFetch: typeof fetch;
let originalSpawn: typeof Bun.spawn;
let manifestConversionResponse: { ok: boolean; status?: number; body: unknown } = {
  ok: true,
  body: FAKE_APP_RESPONSE,
};

function installGithubFetchMock(): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.github.com/")) {
      if (url.includes("/app-manifests/") && url.endsWith("/conversions")) {
        return new Response(JSON.stringify(manifestConversionResponse.body), {
          status: manifestConversionResponse.ok ? 200 : (manifestConversionResponse.status ?? 500),
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/app/installations")) {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not mocked", { status: 404 });
    }
    return originalFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
}

function installSpawnMock(): void {
  originalSpawn = Bun.spawn;
  Bun.spawn = ((..._args: unknown[]) => {
    return {
      pid: -1,
      kill: () => {},
      exited: Promise.resolve(0),
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
}

beforeEach(() => {
  manifestConversionResponse = { ok: true, body: FAKE_APP_RESPONSE };
  installGithubFetchMock();
  installSpawnMock();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  // Give the OS a moment to release any test-bound port before the next test.
  await new Promise((r) => setTimeout(r, 50));
});

describe("ManifestFlowProvisioner", () => {
  test("happy path: callback delivers credentials, server shuts down", async () => {
    const port = 19890;
    const provisioner = new ManifestFlowProvisioner({ port, timeoutMs: 30_000 });
    const promise = provisioner.provision(SAMPLE_SPEC);

    // Give the server a moment to bind before we hit /callback.
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`http://localhost:${port}/callback?code=abc123`);

    const creds = await promise;
    expect(creds.appId).toBe(FAKE_APP_RESPONSE.id);
    expect(creds.slug).toBe(FAKE_APP_RESPONSE.slug);
    expect(creds.clientId).toBe(FAKE_APP_RESPONSE.client_id);
    expect(creds.pem).toBe(FAKE_APP_RESPONSE.pem);
  });

  test("browser-cancel timeout fires BrowserCancelledError and shuts down server", async () => {
    const provisioner = new ManifestFlowProvisioner({ port: 19891, timeoutMs: 100 });
    await expect(provisioner.provision(SAMPLE_SPEC)).rejects.toBeInstanceOf(BrowserCancelledError);
  });

  test("BrowserCancelledError message describes the failure clearly", async () => {
    const provisioner = new ManifestFlowProvisioner({ port: 19892, timeoutMs: 80 });
    await expect(provisioner.provision(SAMPLE_SPEC)).rejects.toThrow(
      "App creation not approved in browser"
    );
  });

  test("GitHub API error from manifest conversion surfaces as a typed error", async () => {
    manifestConversionResponse = {
      ok: false,
      status: 500,
      body: "internal error",
    };

    const port = 19893;
    const provisioner = new ManifestFlowProvisioner({ port, timeoutMs: 30_000 });
    const promise = provisioner.provision(SAMPLE_SPEC);

    await new Promise((r) => setTimeout(r, 50));
    // Don't await this fetch — its connection may be reset when the
    // server stops on the error path. We only need to trigger the route.
    fetch(`http://localhost:${port}/callback?code=baddata`).catch(() => {
      /* connection reset is expected when server shuts down */
    });

    await expect(promise).rejects.toThrow(/GitHub API error during manifest conversion/);
  });
});
