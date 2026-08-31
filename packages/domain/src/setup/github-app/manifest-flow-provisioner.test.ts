/**
 * Tests for ManifestFlowProvisioner.
 *
 * Hermetic: mocks GitHub API fetch (for /app-manifests/<code>/conversions),
 * Bun.spawn (browser-open), and injects an InstallationLookup that skips the
 * WebCrypto JWT path (which requires a real PEM). The local callback server
 * runs for real, on an OS-assigned port probed fresh per test (see
 * `getFreePort` below) — never a hardcoded literal.
 *
 * That probe NARROWS the collision window; it does not close it (mt#3605).
 * `getFreePort` releases the port before the provisioner re-binds it, so a
 * concurrent process can still take it in between — this comment previously
 * claimed concurrent runs "cannot collide", and then two tests here failed
 * with EADDRINUSE on port 52595 in a single gated run (2026-08-03). Tests that
 * need a working server therefore go through `startProvisionerOnFreePort`,
 * which retries the probe-and-bind on a fresh port when it loses that race.
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
import {
  ManifestFlowProvisioner,
  type InstallationLookup,
  type ManifestFlowProvisionerOptions,
} from "./manifest-flow-provisioner";
import { BrowserCancelledError } from "./provisioner";
import type { AppCredentials, AppManifestSpec } from "./types";

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

/** Attempts to win the probe-then-bind race before giving up (mt#3605). */
const MAX_BIND_ATTEMPTS = 3;

/**
 * Upper bound on how long to wait for a bind failure to surface (mt#3605).
 *
 * This is a CEILING, not a fixed delay: the wait below races the provision
 * promise against this timer, so a rejection returns immediately and only the
 * success path pays the full window. That keeps a loaded runner from silently
 * skipping the retry because the rejection took longer than a tight fixed
 * sleep to arrive (PR #2570 R1).
 */
const BIND_SETTLE_MAX_MS = 100;

/** Base delay between bind attempts; jittered to avoid a thundering herd. */
const BIND_RETRY_BASE_MS = 10;

/**
 * True iff `err` is the shape a lost port race takes — `Bun.serve()` failing to
 * bind. Deliberately NARROW: every other rejection `provision()` can produce
 * (BrowserCancelledError, the not-installed-in-time timeout, a GitHub API
 * error) must fall through so the retry cannot mask a real failure. This
 * mirrors mt#2764's rule for the sibling helper in
 * `src/commands/mcp/start-command.test.ts` — retry the bind-race SHAPE only,
 * never a genuine timeout.
 */
function isPortBindRace(err: unknown): boolean {
  if (err && typeof err === "object" && (err as { code?: unknown }).code === "EADDRINUSE") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  // Three phrasings, because the `code` property is not guaranteed to be present
  // on every runtime/version (PR #2570 R1):
  //   - `EADDRINUSE`               — the symbolic code, when it reaches the text
  //   - `Is port 52595 in use?`    — Bun's `Bun.serve()` wording
  //   - `address already in use`   — Node's libuv wording, and most POSIX strerror
  return /EADDRINUSE|is port \d+ in use|address (already )?in use/i.test(message);
}

/**
 * Mint a free port and start a provisioner on it, retrying the whole
 * probe-construct-bind sequence when the bind loses the race.
 *
 * `getFreePort()` above releases the port before `ManifestFlowProvisioner`
 * re-binds it, leaving a TOCTOU window: under the parallel suite another
 * process can take the port in between. That is not hypothetical — it fired
 * twice in one `run-tests-gated.ts` run on 2026-08-03 (port 52595), failing
 * the fail-closed pre-push gate on an unrelated branch. The probe cannot hold
 * the port instead, because the constructor needs a concrete port number
 * before it binds (the manifest's `redirect_url` embeds it — see mt#3124).
 *
 * Retrying is therefore the mitigation, matching the reviewed design mt#2764
 * landed for the same race in `start-command.test.ts`.
 *
 * NOTE for callers: the `construction-failure path (mt#3124)` test below must
 * NOT use this helper — it holds the port on purpose to assert the collision
 * surfaces correctly, and a retry would defeat exactly what it verifies.
 *
 * Contract of the returned `result` (PR #2570 R1): it is the provisioner's OWN
 * promise, unwrapped and unmodified. This helper attaches an internal observer
 * to it, which only marks it handled — it neither swallows the rejection nor
 * substitutes a different one, so callers still `await` it for the credentials
 * or assert on it with `expect(result).rejects...` exactly as they would on a
 * direct `provision()` call. `attempts` reports how many binds it took.
 */
async function startProvisionerOnFreePort(
  options: Omit<ManifestFlowProvisionerOptions, "port">,
  spec: AppManifestSpec = SAMPLE_SPEC,
  // Seam so the retry path itself is testable: the race is a real-world timing
  // window that cannot be produced on demand, so the regression test below
  // injects a probe that hands back a port it is deliberately holding.
  probePort: () => Promise<number> = getFreePort
): Promise<{ port: number; result: Promise<AppCredentials>; attempts: number }> {
  let lastBindError: unknown;

  for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS; attempt++) {
    const port = await probePort();
    const started = new ManifestFlowProvisioner({ port, ...options }).provision(spec);

    // Record an early rejection. Attached SYNCHRONOUSLY, before any await:
    // `provision()` rejects on a failed bind within a microtask, and Bun
    // reports an unhandled rejection at queue drain — so deferring this
    // handler until after the settle wait fails the run on the very rejection
    // we are trying to absorb. Observed while building this test.
    //
    // `.catch()` returns a NEW promise; `started` stays rejected and is simply
    // marked handled, so callers can still attach their own
    // `expect(...).rejects` assertion to it.
    let rejection: unknown;
    let rejected = false;
    const observed = started.catch((err: unknown) => {
      rejected = true;
      rejection = err;
    });

    // Race the rejection against the ceiling rather than sleeping a fixed
    // interval: a bind failure is acted on the moment it arrives, and a slow
    // runner still gets the full window before we conclude the bind held.
    await Promise.race([observed, new Promise((r) => setTimeout(r, BIND_SETTLE_MAX_MS))]);

    if (rejected && isPortBindRace(rejection)) {
      lastBindError = rejection;
      // Jittered backoff so racing suites do not re-probe in lockstep. The
      // jitter is derived from the PID rather than `Math.random()`: the herd
      // being spread is across concurrent test PROCESSES, so a per-process
      // constant de-correlates them exactly as well while staying
      // deterministic within a run (and `custom/no-real-fs-in-tests` flags
      // `Math.random()` in tests, which CI treats as an error).
      const jitter = process.pid % BIND_RETRY_BASE_MS;
      await new Promise((r) => setTimeout(r, BIND_RETRY_BASE_MS * attempt + jitter));
      continue;
    }

    return { port, result: started, attempts: attempt };
  }

  throw new Error(
    `Could not bind a free port after ${MAX_BIND_ATTEMPTS} attempts: ${String(lastBindError)}`
  );
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

    const { port, result: promise } = await startProvisionerOnFreePort({
      timeoutMs: 30_000,
      installationLookup: makeLookup(),
    });

    await new Promise((r) => setTimeout(r, 50));
    await fetch(`http://localhost:${port}/callback?code=abc123`);

    const creds = await promise;
    expect(creds.appId).toBe(FAKE_APP_RESPONSE.id);
    expect(creds.installationId).toBe(99999);
  });

  test("two-phase: /callback returns install link, /check-install completes installationId capture", async () => {
    // First lookup (during /callback) returns undefined; second (during /check-install) hits.
    lookupQueue = [undefined, 88888];

    const { port, result: promise } = await startProvisionerOnFreePort({
      timeoutMs: 30_000,
      installationLookup: makeLookup(),
    });

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

  describe("mt#4815: values from the API are origin-checked AND escaped before being served", () => {
    /**
     * Drive /callback to the install-link page — the page carrying the href
     * this task is about — with `html_url` replaced, then finish the flow so
     * the provisioner resolves and shuts its server down rather than idling
     * until the timeout.
     */
    async function callbackPageWithHtmlUrl(htmlUrl: unknown): Promise<string> {
      lookupQueue = [undefined, 88888];
      manifestConversionResponse = {
        ok: true,
        body: { ...FAKE_APP_RESPONSE, html_url: htmlUrl },
      };

      const { port, result } = await startProvisionerOnFreePort({
        timeoutMs: 30_000,
        installationLookup: makeLookup(),
      });

      await new Promise((r) => setTimeout(r, 50));
      const resp = await fetch(`http://localhost:${port}/callback?code=abc123`);
      expect(resp.status).toBe(200);
      const body = await resp.text();

      await new Promise((r) => setTimeout(r, 20));
      await fetch(`http://localhost:${port}/check-install`);
      await result;

      return body;
    }

    // AT2 — the origin check's job.
    test("an off-origin html_url never reaches the Install App href", async () => {
      const body = await callbackPageWithHtmlUrl("https://github.com.evil.com/apps/test-app");

      expect(body).not.toContain("evil.com");
      expect(body).toContain('href="https://github.com/apps/test-app/installations/new"');
    });

    // AT3 — the escaping's job, and the case that proves the two defences are
    // not interchangeable. The host here IS github.com, so `trustedGitHubUrl`
    // passes the value through unchanged; only escaping stops the quote from
    // closing the attribute and injecting a handler after it.
    test("a quote in an ON-ORIGIN html_url cannot break out of the href attribute", async () => {
      const body = await callbackPageWithHtmlUrl(
        'https://github.com/apps/x" onmouseover="alert(1)'
      );

      expect(body).toContain("&quot;");
      // Nothing follows a closed href quote except the style attribute the
      // template itself writes.
      expect(body).not.toMatch(/href="[^"]*"\s+onmouseover/);
      expect(body).not.toContain('onmouseover="alert(1)"');
    });

    test("a legitimate html_url is rendered unchanged", async () => {
      const body = await callbackPageWithHtmlUrl("https://github.com/apps/test-app");
      expect(body).toContain('href="https://github.com/apps/test-app/installations/new"');
    });

    // The `app` object is a bare `as` cast over JSON.parse, so its declared
    // `id: number` is an assertion about GitHub's response, not a guarantee.
    // This covers the OTHER served page (the pre-installed happy path) and a
    // value that is not the URL.
    test("a non-numeric app id is escaped rather than interpolated raw", async () => {
      lookupQueue = [99999];
      manifestConversionResponse = {
        ok: true,
        body: { ...FAKE_APP_RESPONSE, id: "<script>alert(1)</script>" },
      };

      const { port, result } = await startProvisionerOnFreePort({
        timeoutMs: 30_000,
        installationLookup: makeLookup(),
      });

      await new Promise((r) => setTimeout(r, 50));
      const resp = await fetch(`http://localhost:${port}/callback?code=abc123`);
      const body = await resp.text();
      await result;

      expect(body).not.toContain("<script>");
      expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    });
  });

  test("two-phase: /check-install before installation is set returns 404, eventual timeout", async () => {
    // Both lookups (during /callback + /check-install) return undefined.
    lookupQueue = [undefined, undefined];

    const { port, result: promise } = await startProvisionerOnFreePort({
      timeoutMs: 200,
      installationLookup: makeLookup(),
    });

    await new Promise((r) => setTimeout(r, 50));
    await fetch(`http://localhost:${port}/callback?code=abc123`);

    const checkResp = await fetch(`http://localhost:${port}/check-install`);
    expect(checkResp.status).toBe(404);

    // Provisioner still pending; let it time out — App created but not installed.
    await expect(promise).rejects.toThrow(/App was created but not installed in time/);
  });

  test("browser-cancel timeout fires BrowserCancelledError and shuts down server", async () => {
    const { result } = await startProvisionerOnFreePort({
      timeoutMs: 100,
      installationLookup: makeLookup(),
    });
    await expect(result).rejects.toBeInstanceOf(BrowserCancelledError);
  });

  test("BrowserCancelledError message describes the failure clearly when no callback arrives", async () => {
    const { result } = await startProvisionerOnFreePort({
      timeoutMs: 80,
      installationLookup: makeLookup(),
    });
    await expect(result).rejects.toThrow("App creation not approved in browser");
  });

  test("GitHub API error from manifest conversion surfaces as a typed error", async () => {
    manifestConversionResponse = {
      ok: false,
      status: 500,
      body: "internal error",
    };

    const { port, result: promise } = await startProvisionerOnFreePort({
      timeoutMs: 30_000,
      installationLookup: makeLookup(),
    });

    await new Promise((r) => setTimeout(r, 50));
    fetch(`http://localhost:${port}/callback?code=baddata`).catch(() => {
      /* connection reset is expected when server shuts down */
    });

    await expect(promise).rejects.toThrow(/GitHub API error during manifest conversion/);
  });

  test("mt#3605: a lost probe-to-bind race retries on a fresh port instead of failing the suite", async () => {
    lookupQueue = [99999];

    // Hold a port and hand it to the FIRST probe, so attempt 1's bind is
    // guaranteed to lose exactly the way the real TOCTOU race loses. This is
    // the failure that fired twice on port 52595 in one gated run (2026-08-03).
    const contested = await getFreePort();
    const squatter = Bun.serve({ port: contested, fetch: () => new Response("held") });

    try {
      let probes = 0;
      const { port, result, attempts } = await startProvisionerOnFreePort(
        { timeoutMs: 30_000, installationLookup: makeLookup() },
        SAMPLE_SPEC,
        async () => {
          probes += 1;
          return probes === 1 ? contested : await getFreePort();
        }
      );

      // The race was lost and retried — not merely "it happened to work".
      expect(probes).toBeGreaterThan(1);
      expect(attempts).toBeGreaterThan(1);
      expect(port).not.toBe(contested);

      // And the provisioner is genuinely serving on the replacement port.
      await new Promise((r) => setTimeout(r, 50));
      await fetch(`http://localhost:${port}/callback?code=abc123`);
      const creds = await result;
      expect(creds.installationId).toBe(99999);
    } finally {
      squatter.stop(true);
    }
  });

  test("mt#3605: a non-bind rejection is NOT retried — the retry cannot mask a real failure", async () => {
    // BrowserCancelledError is the shape a genuine timeout takes. If the retry
    // discriminator were loose, this would burn all 3 attempts and change the
    // error the caller sees; it must pass through on the first attempt.
    const { result, attempts } = await startProvisionerOnFreePort({
      timeoutMs: 60,
      installationLookup: makeLookup(),
    });

    await expect(result).rejects.toBeInstanceOf(BrowserCancelledError);
    expect(attempts).toBe(1);
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
      // Track ONLY the provisioner's own deadline timer, identified by its
      // distinctive delay, rather than every timer scheduled during the window
      // (PR #2256 R1): Bun internals, the fetch stack, and other in-flight work
      // can schedule timers here too, and requiring all of them to be cleared
      // would make this test flake on timers it does not own.
      const DEADLINE_MS = 30_000;
      const deadlineIds = new Set<ReturnType<typeof setTimeout>>();
      const clearedIds = new Set<ReturnType<typeof setTimeout>>();

      globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
        const id = originalSetTimeout(...args);
        if (args[1] === DEADLINE_MS) deadlineIds.add(id);
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
          timeoutMs: DEADLINE_MS,
          installationLookup: makeLookup(),
        });

        // The rejection must name the real, underlying error — not a TDZ
        // ReferenceError about `server`.
        // Matches Bun's current phrasing plus the platform variants a
        // port-conflict can surface as (PR #2256 R1) — broad enough not to
        // false-negative off-macOS, still narrow enough that a TDZ
        // ReferenceError (the actual regression) does not match.
        await expect(provisioner.provision(SAMPLE_SPEC)).rejects.toThrow(
          new RegExp(`EADDRINUSE|address already in use|port ${port} in use`, "i")
        );

        // The construction-failure path must have scheduled the deadline
        // timer and then cleared it — leaving nothing pending.
        expect(deadlineIds.size).toBe(1);
        for (const id of deadlineIds) {
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
