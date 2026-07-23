/**
 * Tests for ManifestFlowProvisioner.
 *
 * Hermetic: mocks GitHub API fetch (for /app-manifests/<code>/conversions),
 * Bun.spawn (browser-open), and injects an InstallationLookup that skips the
 * WebCrypto JWT path (which requires a real PEM). The local callback server
 * runs for real, on an OS-assigned port probed fresh per test (see
 * `getFreePort` below) — never a hardcoded literal, so two concurrent suite
 * runs (routine in this repo — see mt#3124) cannot collide on the same port.
 *
 * @see mt#1087
 * @see mt#3124 — hardcoded 1989x literals replaced with a free-port probe,
 *   mirroring `src/cockpit/port-recovery.test.ts`'s bindListener/closeListener
 *   pattern. `ManifestFlowProvisioner`'s constructor rejects `port: 0`
 *   directly (the manifest's redirect_url must be known before the server
 *   binds), so the probe-then-reuse shape is required here, not a bare
 *   `port: 0`.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import net from "net";
import { setupTestMocks } from "../../../../../src/utils/test-utils/mocking";
import { ManifestFlowProvisioner, type InstallationLookup } from "./manifest-flow-provisioner";
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

/**
 * Per-test queue of installation-lookup return values. Each call shifts the
 * next value off the queue; if the queue is empty, returns undefined.
 */
let lookupQueue: (number | undefined)[] = [];

function makeLookup(): InstallationLookup {
  return async () => {
    const next = lookupQueue.shift();
    return next;
  };
}

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

/**
 * Bind an OS-assigned TCP port, then release it immediately so
 * `ManifestFlowProvisioner` (which requires a concrete, pre-known port — see
 * its constructor) can bind the same number a moment later. Mirrors
 * `src/cockpit/port-recovery.test.ts`'s `bindListener`/`closeListener`/
 * `findFreePort` helpers (mt#3124, mt#2764's reviewed fix design).
 */
async function getFreePort(): Promise<number> {
  const server = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("listener has no address"));
        return;
      }
      resolve(addr.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

beforeEach(() => {
  manifestConversionResponse = { ok: true, body: FAKE_APP_RESPONSE };
  lookupQueue = [];
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
  test("happy path (App pre-installed): callback resolves immediately with installationId", async () => {
    // First lookup hits with an installation.
    lookupQueue = [99999];

    const port = await getFreePort();
    const provisioner = new ManifestFlowProvisioner({
      port,
      timeoutMs: 30_000,
      installationLookup: makeLookup(),
    });
    const promise = provisioner.provision(SAMPLE_SPEC);

    await new Promise((r) => setTimeout(r, 50));
    await fetch(`http://localhost:${port}/callback?code=abc123`);

    const creds = await promise;
    expect(creds.appId).toBe(FAKE_APP_RESPONSE.id);
    expect(creds.installationId).toBe(99999);
  });

  test("two-phase: /callback returns install link, /check-install completes installationId capture", async () => {
    // First lookup (during /callback) returns undefined; second (during /check-install) hits.
    lookupQueue = [undefined, 88888];

    const port = await getFreePort();
    const provisioner = new ManifestFlowProvisioner({
      port,
      timeoutMs: 30_000,
      installationLookup: makeLookup(),
    });
    const promise = provisioner.provision(SAMPLE_SPEC);

    await new Promise((r) => setTimeout(r, 50));

    const cbResp = await fetch(`http://localhost:${port}/callback?code=abc123`);
    expect(cbResp.status).toBe(200);
    const cbBody = await cbResp.text();
    expect(cbBody).toContain("App Created!");
    expect(cbBody).toContain("/check-install");

    await new Promise((r) => setTimeout(r, 20));
    const checkResp = await fetch(`http://localhost:${port}/check-install`);
    expect(checkResp.status).toBe(200);

    const creds = await promise;
    expect(creds.appId).toBe(FAKE_APP_RESPONSE.id);
    expect(creds.installationId).toBe(88888);
  });

  test("two-phase: /check-install before installation is set returns 404, eventual timeout", async () => {
    // Both lookups (during /callback + /check-install) return undefined.
    lookupQueue = [undefined, undefined];

    const port = await getFreePort();
    const provisioner = new ManifestFlowProvisioner({
      port,
      timeoutMs: 200,
      installationLookup: makeLookup(),
    });
    const promise = provisioner.provision(SAMPLE_SPEC);

    await new Promise((r) => setTimeout(r, 50));
    await fetch(`http://localhost:${port}/callback?code=abc123`);

    const checkResp = await fetch(`http://localhost:${port}/check-install`);
    expect(checkResp.status).toBe(404);

    // Provisioner still pending; let it time out — App created but not installed.
    await expect(promise).rejects.toThrow(/App was created but not installed in time/);
  });

  test("browser-cancel timeout fires BrowserCancelledError and shuts down server", async () => {
    const port = await getFreePort();
    const provisioner = new ManifestFlowProvisioner({
      port,
      timeoutMs: 100,
      installationLookup: makeLookup(),
    });
    await expect(provisioner.provision(SAMPLE_SPEC)).rejects.toBeInstanceOf(BrowserCancelledError);
  });

  test("BrowserCancelledError message describes the failure clearly when no callback arrives", async () => {
    const port = await getFreePort();
    const provisioner = new ManifestFlowProvisioner({
      port,
      timeoutMs: 80,
      installationLookup: makeLookup(),
    });
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

    const port = await getFreePort();
    const provisioner = new ManifestFlowProvisioner({
      port,
      timeoutMs: 30_000,
      installationLookup: makeLookup(),
    });
    const promise = provisioner.provision(SAMPLE_SPEC);

    await new Promise((r) => setTimeout(r, 50));
    fetch(`http://localhost:${port}/callback?code=baddata`).catch(() => {
      /* connection reset is expected when server shuts down */
    });

    await expect(promise).rejects.toThrow(/GitHub API error during manifest conversion/);
  });

  describe("construction-failure path (mt#3124)", () => {
    test("serve() throwing (port already bound) surfaces the underlying port-conflict error, not a ReferenceError, and clears the pending timer", async () => {
      const port = await getFreePort();

      // Hold the port externally so ManifestFlowProvisioner's own serve()
      // call throws synchronously inside provision() — reproducing the
      // EADDRINUSE collision from the mt#3124 incident directly.
      const holder = Bun.serve({ port, fetch: () => new Response("hold") });

      const originalSetTimeout = globalThis.setTimeout;
      const originalClearTimeout = globalThis.clearTimeout;
      const scheduledIds = new Set<ReturnType<typeof setTimeout>>();
      const clearedIds = new Set<ReturnType<typeof setTimeout>>();

      globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
        const id = originalSetTimeout(...args);
        scheduledIds.add(id);
        return id;
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
        clearedIds.add(id as ReturnType<typeof setTimeout>);
        return originalClearTimeout(id);
      }) as typeof clearTimeout;

      try {
        const provisioner = new ManifestFlowProvisioner({
          port,
          // A long timeout: if the construction-failure path did NOT clear
          // this timer, it would sit pending for the full 30s and could
          // fire — as the TDZ ReferenceError — into whichever unrelated
          // test happens to be running when it elapses (the exact
          // cross-file leak this task fixes). Asserting the timer was
          // cleared (below) is what actually proves it can't fire, without
          // needing to wait out the deadline.
          timeoutMs: 30_000,
          installationLookup: makeLookup(),
        });

        // The rejection must name the real, underlying error — not a TDZ
        // ReferenceError about `server`.
        await expect(provisioner.provision(SAMPLE_SPEC)).rejects.toThrow(
          new RegExp(`port ${port} in use`, "i")
        );

        // The construction-failure path must have scheduled the deadline
        // timer and then cleared it — leaving nothing pending.
        expect(scheduledIds.size).toBeGreaterThan(0);
        for (const id of scheduledIds) {
          expect(clearedIds.has(id)).toBe(true);
        }
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        holder.stop(true);
      }
    });
  });
});
