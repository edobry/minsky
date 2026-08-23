/**
 * Cockpit daemon security-hardening integration tests (mt#2538).
 *
 * Covers, at the real-HTTP-server level:
 *  (a) default bind is loopback (127.0.0.1, not 0.0.0.0) — and a socket to a
 *      non-loopback interface is refused when one exists on the test host.
 *  (b) mutation-auth: no token/cookie -> 401; valid bearer token or cookie
 *      passes.
 *  (c) the SPA's HTML response carries a Content-Security-Policy header.
 *  (d) a disallowed Host header is rejected with 403 (DNS-rebinding
 *      defense); an allowed one passes.
 *  (e) the SPA fallback / /api/* / /assets/* content-type regression
 *      (memory f558b1cb) still holds after the new middleware chain.
 *
 * Uses the same real-HTTP-server-on-a-random-port pattern as
 * cockpit.test.ts / server-static-assets.test.ts.
 */
/* eslint-disable custom/no-real-fs-in-tests -- mirrors server-static-assets.test.ts: a temp dist dir IS the contract under test for (e) */
/*
 * mt#4023 note: the isPublicDeployment block below used to assert that the
 * carve-out SKIPPED auth. That assertion described the exposure, not a
 * requirement — the deployment served the live corpus to anyone with the URL.
 * Those tests now assert the passkey gate instead.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { createServer, request as httpRequest } from "http";
import type { Server } from "http";
import net from "net";
import os from "os";
import fs from "fs";
import path from "path";
import { tmpdir } from "os";
import WebSocket from "ws";
import { createCockpitServer } from "./server";
import type { PasskeyStore } from "./passkey-auth";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import { attachDrivenSessionWebSocket } from "./driven-session-ws";
import { DrivenSessionRegistry, buildReconnectingDrivenSessionRecord } from "./driven-session-host";
import { buildAllowedHosts } from "./auth";

const TEST_TOKEN = "test-server-security-token";
const CONTENT_TYPE_JSON = "application/json";
/** Any token value works: the test stores accept whatever is presented. */
const SESSION_COOKIE_HEADER = "minsky_cockpit_session=test";
const CSP_HEADER = "content-security-policy";

/** A deterministic, empty AskRepository — without this override the route
 * lazily initializes a real DB-backed repository, which 503s in this test
 * environment (no DB configured) rather than 404ing on an unknown id. */
function emptyAskRepoOverride() {
  return { overrideAskRepository: new FakeAskRepository() };
}

interface TestServer {
  url: string;
  server: Server;
  port: number;
  close: () => Promise<void>;
}

async function startTestServer(
  opts?: Parameters<typeof createCockpitServer>[0],
  host: string = "127.0.0.1"
): Promise<TestServer> {
  const app = createCockpitServer({ overrideToken: TEST_TOKEN, ...opts });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
  const url = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return { url, server, port: addr.port, close };
}

/** Raw HTTP request that can set an arbitrary Host header (fetch's Host
 * header is not reliably overridable across runtimes — Node's http.request
 * always honors an explicitly-supplied Host header verbatim). */
async function requestWithHost(
  port: number,
  path: string,
  hostHeader: string
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: hostHeader } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** Race a raw WS-client connection attempt to either "opened" or "refused"
 * (any of `unexpected-response` / `error` / `close` firing before `open`) —
 * mirrors driven-session-ws.test.ts's `waitForWsOutcome` helper. */
function waitForWsOutcome(ws: WebSocket): Promise<"refused" | "opened"> {
  return new Promise<"refused" | "opened">((resolve) => {
    ws.on("open", () => resolve("opened"));
    ws.on("unexpected-response", () => resolve("refused"));
    ws.on("error", () => resolve("refused"));
    ws.on("close", () => resolve("refused"));
  });
}

/**
 * A `PasskeyStore` double whose only interesting behavior is that any
 * presented session token is valid (mt#4023). It exists so a test can reach
 * PAST the gate — the gate's denial path needs no store behavior at all,
 * since a request with no cookie never gets as far as a lookup.
 */
function passkeyStoreWith(enrolled: number, sessionValid: boolean): PasskeyStore {
  return {
    listPasskeys: async () =>
      Array.from({ length: enrolled }, (_, i) => ({
        id: `p${i}`,
        credentialId: `c${i}`,
        publicKey: "",
        counter: 0,
      })),
    findPasskeyByCredentialId: async () => null,
    insertPasskey: async () => "p1",
    updatePasskeyCounter: async () => {},
    createSession: async () => {},
    findValidSession: async () => (sessionValid ? { id: "s1" } : null),
    deleteSession: async () => {},
  };
}

function alwaysAuthenticatedPasskeyStore(): PasskeyStore {
  return {
    listPasskeys: async () => [{ id: "p1", credentialId: "c1", publicKey: "", counter: 0 }],
    findPasskeyByCredentialId: async () => null,
    insertPasskey: async () => "p1",
    updatePasskeyCounter: async () => {},
    createSession: async () => {},
    findValidSession: async () => ({ id: "s1" }),
    deleteSession: async () => {},
  };
}

describe("Cockpit daemon security hardening (mt#2538)", () => {
  const closeList: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closeList.splice(0)) {
      await close();
    }
  });

  // -------------------------------------------------------------------------
  // (a) default bind is loopback
  // -------------------------------------------------------------------------

  test("binding with the loopback host listens on 127.0.0.1, not 0.0.0.0", async () => {
    const s = await startTestServer();
    closeList.push(s.close);
    const addr = s.server.address();
    if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
    expect(addr.address).toBe("127.0.0.1");
  });

  test("a socket to a non-loopback interface is refused when bound to loopback", async () => {
    const s = await startTestServer();
    closeList.push(s.close);

    const nonLoopback = Object.values(os.networkInterfaces())
      .flat()
      .find((iface) => iface !== undefined && iface.family === "IPv4" && !iface.internal);

    if (!nonLoopback) {
      // No non-loopback interface on this machine (common in CI sandboxes) —
      // nothing to probe; the loopback-only bind is trivially satisfied.
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({
        host: nonLoopback.address,
        port: s.port,
        timeout: 1000,
      });
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error("connection to the non-loopback interface unexpectedly succeeded"));
      });
      socket.once("error", () => resolve());
      socket.once("timeout", () => {
        socket.destroy();
        resolve();
      });
    });
  });

  // -------------------------------------------------------------------------
  // (b) mutation auth: bearer token / cookie required
  // -------------------------------------------------------------------------

  test("a mutation without a token or cookie is rejected with 401", async () => {
    const s = await startTestServer();
    closeList.push(s.close);
    const res = await fetch(`${s.url}/api/asks/nonexistent/resolve`, {
      method: "POST",
      headers: { "Content-Type": CONTENT_TYPE_JSON },
      body: JSON.stringify({ responder: "operator", payload: {} }),
    });
    expect(res.status).toBe(401);
  });

  test("a mutation with a valid bearer token passes auth (reaches route logic)", async () => {
    const s = await startTestServer(emptyAskRepoOverride());
    closeList.push(s.close);
    const res = await fetch(`${s.url}/api/asks/nonexistent/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": CONTENT_TYPE_JSON,
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ responder: "operator", payload: {} }),
    });
    // Auth passed the 401 gate — the route itself 404s on the unknown ask id.
    expect(res.status).toBe(404);
  });

  test("a mutation with an invalid bearer token is rejected with 401", async () => {
    const s = await startTestServer();
    closeList.push(s.close);
    const res = await fetch(`${s.url}/api/asks/nonexistent/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": CONTENT_TYPE_JSON,
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ responder: "operator", payload: {} }),
    });
    expect(res.status).toBe(401);
  });

  test("a mutation with a valid cockpit cookie passes auth (reaches route logic)", async () => {
    const s = await startTestServer(emptyAskRepoOverride());
    closeList.push(s.close);
    const res = await fetch(`${s.url}/api/asks/nonexistent/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": CONTENT_TYPE_JSON,
        Cookie: `minsky_cockpit=${TEST_TOKEN}`,
      },
      body: JSON.stringify({ responder: "operator", payload: {} }),
    });
    expect(res.status).toBe(404);
  });

  test("a GET on a first visit mints the minsky_cockpit cookie", async () => {
    const s = await startTestServer();
    closeList.push(s.close);
    const res = await fetch(`${s.url}/api/health`);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("minsky_cockpit=");
    expect(setCookie).toContain("HttpOnly");
  });

  test("a GET carrying the cookie already does not re-mint it", async () => {
    const s = await startTestServer();
    closeList.push(s.close);
    const res = await fetch(`${s.url}/api/health`, {
      headers: { Cookie: `minsky_cockpit=${TEST_TOKEN}` },
    });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // (c) CSP header
  // -------------------------------------------------------------------------

  test("GET / carries a Content-Security-Policy header", async () => {
    const s = await startTestServer();
    closeList.push(s.close);
    const res = await fetch(`${s.url}/`);
    const csp = res.headers.get(CSP_HEADER) ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  test("--dev mode uses the relaxed CSP variant (allows unsafe-eval for HMR)", async () => {
    const s = await startTestServer({ dev: true });
    closeList.push(s.close);
    const res = await fetch(`${s.url}/api/health`);
    const csp = res.headers.get(CSP_HEADER) ?? "";
    expect(csp).toContain("'unsafe-eval'");
  });

  // -------------------------------------------------------------------------
  // (d) Host-header allowlist (DNS-rebinding defense)
  // -------------------------------------------------------------------------

  test("a disallowed Host header is rejected with 403", async () => {
    const s = await startTestServer();
    closeList.push(s.close);
    const res = await requestWithHost(s.port, "/api/health", "evil.example.com");
    expect(res.status).toBe(403);
  });

  test("the loopback Host header (127.0.0.1) is allowed", async () => {
    const s = await startTestServer();
    closeList.push(s.close);
    const res = await requestWithHost(s.port, "/api/health", `127.0.0.1:${s.port}`);
    expect(res.status).toBe(200);
  });

  test("the localhost Host header is allowed", async () => {
    const s = await startTestServer();
    closeList.push(s.close);
    const res = await requestWithHost(s.port, "/api/health", `localhost:${s.port}`);
    expect(res.status).toBe(200);
  });

  test("an explicit --host opt-in value is added to the allowlist", async () => {
    const s = await startTestServer({ host: "cockpit.example.internal" });
    closeList.push(s.close);
    const res = await requestWithHost(s.port, "/api/health", "cockpit.example.internal");
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Operator-configured extra allowed hosts (mt#3641 — Tailscale tailnet
  // access). Distinct from the --host BIND opt-in above: the daemon stays
  // bound to loopback (Tailscale's own recommended posture) while a
  // declaratively-configured tailnet MagicDNS name is layered ADDITIVELY
  // onto the allowlist — an arbitrary, unconfigured Host must still 403.
  // -------------------------------------------------------------------------

  describe("cockpit.allowedHosts — operator-configured extra Host names", () => {
    const TAILNET_HOST = "my-node.tail1234.ts.net";

    test("a request whose Host matches a configured extra host returns 200", async () => {
      const s = await startTestServer({ extraAllowedHosts: [TAILNET_HOST] });
      closeList.push(s.close);
      const res = await requestWithHost(s.port, "/api/health", TAILNET_HOST);
      expect(res.status).toBe(200);
    });

    test("a request whose Host is an arbitrary, unconfigured name still 403s (allowlist ADDITION, not a bypass)", async () => {
      const s = await startTestServer({ extraAllowedHosts: [TAILNET_HOST] });
      closeList.push(s.close);
      const res = await requestWithHost(s.port, "/api/health", "some-other-host.example.com");
      expect(res.status).toBe(403);
    });

    test("does NOT mint the plain-HTTP cookie for a request via the configured extra host, even while bound to loopback (criterion 3 re-derivation)", async () => {
      const s = await startTestServer({ extraAllowedHosts: [TAILNET_HOST] });
      closeList.push(s.close);
      const res = await requestWithHost(s.port, "/api/health", TAILNET_HOST);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    test("still mints the cookie for a loopback-Host request even when extra hosts are configured", async () => {
      const s = await startTestServer({ extraAllowedHosts: [TAILNET_HOST] });
      closeList.push(s.close);
      const res = await requestWithHost(s.port, "/api/health", `127.0.0.1:${s.port}`);
      const setCookie = res.headers["set-cookie"];
      expect(String(Array.isArray(setCookie) ? setCookie.join(";") : (setCookie ?? ""))).toContain(
        "minsky_cockpit="
      );
    });

    describe("WebSocket upgrade over the configured extra host (mt#2750 cross-origin defense + mt#3641)", () => {
      /** Register a placeholder driven-session record so the upgrade completes
       * (101) without spawning a real session driver — the auth/allowlist/origin
       * checks all run BEFORE session resolution, so this is sufficient to
       * observe "accepted" vs "refused" at that layer. */
      function attachFakeDrivenSession(server: Server, allowedHosts: Set<string>): string {
        const registry = new DrivenSessionRegistry();
        const sessionId = "mt3641-tailnet-ws-test";
        registry.register(
          buildReconnectingDrivenSessionRecord({
            localId: sessionId,
            harnessSessionId: null,
            cwd: "/tmp",
            permissionMode: "default",
            taskId: null,
            minskySessionId: null,
            status: "unrecoverable",
            unrecoverableReason: "server-security.test.ts placeholder — never spawned",
            driverGeneration: 0,
            startedAt: new Date().toISOString(),
          })
        );
        attachDrivenSessionWebSocket(server, { token: TEST_TOKEN, allowedHosts, registry });
        return sessionId;
      }

      test("a WS upgrade carrying the configured tailnet Host and a matching Origin is accepted", async () => {
        const s = await startTestServer({ extraAllowedHosts: [TAILNET_HOST] });
        closeList.push(s.close);
        const sessionId = attachFakeDrivenSession(
          s.server,
          buildAllowedHosts(undefined, [TAILNET_HOST])
        );

        const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/driven-session/${sessionId}/ws`, {
          headers: {
            Host: TAILNET_HOST,
            Origin: `http://${TAILNET_HOST}`,
            Authorization: `Bearer ${TEST_TOKEN}`,
          },
        });
        const outcome = await waitForWsOutcome(ws);
        if (ws.readyState === ws.OPEN) ws.close();
        expect(outcome).toBe("opened");
      });

      test("a WS upgrade with the configured tailnet Host but a MISMATCHED Origin is refused (mt#2750 cross-origin defense survives)", async () => {
        const s = await startTestServer({ extraAllowedHosts: [TAILNET_HOST] });
        closeList.push(s.close);
        const sessionId = attachFakeDrivenSession(
          s.server,
          buildAllowedHosts(undefined, [TAILNET_HOST])
        );

        const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/driven-session/${sessionId}/ws`, {
          headers: {
            Host: TAILNET_HOST,
            Origin: "http://evil.example.com",
            Authorization: `Bearer ${TEST_TOKEN}`,
          },
        });
        const outcome = await waitForWsOutcome(ws);
        if (ws.readyState === ws.OPEN) ws.close();
        expect(outcome).toBe("refused");
      });
    });
  });

  // -------------------------------------------------------------------------
  // isPublicDeployment escape hatch (Railway entrypoint, services/cockpit/src/server.ts)
  // -------------------------------------------------------------------------

  describe("isPublicDeployment (Railway entrypoint carve-out)", () => {
    test("skips the Host-header allowlist — an arbitrary Host header is allowed", async () => {
      const s = await startTestServer({ isPublicDeployment: true });
      closeList.push(s.close);
      const res = await requestWithHost(s.port, "/api/health", "my-app.up.railway.app");
      expect(res.status).toBe(200);
    });

    test("a LOCAL daemon answers /api/auth/status with gated:false (mt#4023)", async () => {
      // Regression guard for a near-miss: if this route were simply left
      // unmounted locally, the SPA catch-all would answer it with index.html —
      // an HTML 200 the client fails closed on, locking the local daemon out
      // of itself. The explicit answer is what keeps local behavior unchanged.
      const s = await startTestServer({});
      closeList.push(s.close);
      const res = await fetch(`${s.url}/api/auth/status`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(CONTENT_TYPE_JSON);
      expect(await res.json()).toMatchObject({ gated: false });
    });

    test("the GATED deployment reports gated:true and unauthenticated (mt#4023)", async () => {
      const s = await startTestServer({
        isPublicDeployment: true,
        passkeyStore: alwaysAuthenticatedPasskeyStore(),
      });
      closeList.push(s.close);
      const res = await fetch(`${s.url}/api/auth/status`);
      expect(await res.json()).toMatchObject({ gated: true, authenticated: false });
    });

    test("requires a passkey session — an unauthenticated request is rejected with 401 (mt#4023)", async () => {
      const s = await startTestServer({
        isPublicDeployment: true,
        passkeyStore: alwaysAuthenticatedPasskeyStore(),
        ...emptyAskRepoOverride(),
      });
      closeList.push(s.close);
      // No cookie: the gate denies before the route is reached. Until mt#4023
      // this asserted the opposite — that the carve-out skipped auth entirely,
      // which is exactly the exposure that task closed.
      const res = await fetch(`${s.url}/api/asks/nonexistent/resolve`, {
        method: "POST",
        headers: { "Content-Type": CONTENT_TYPE_JSON },
        body: JSON.stringify({ responder: "operator", payload: {} }),
      });
      expect(res.status).toBe(401);
    });

    test("reads are gated too — an unauthenticated GET of a data route is 401 (mt#4023)", async () => {
      const s = await startTestServer({
        isPublicDeployment: true,
        passkeyStore: alwaysAuthenticatedPasskeyStore(),
      });
      closeList.push(s.close);
      const res = await fetch(`${s.url}/api/tasks`);
      expect(res.status).toBe(401);
    });

    test("/api/health stays public — the deploy healthcheck must not need a session", async () => {
      const s = await startTestServer({
        isPublicDeployment: true,
        passkeyStore: alwaysAuthenticatedPasskeyStore(),
      });
      closeList.push(s.close);
      const res = await fetch(`${s.url}/api/health`);
      expect(res.status).toBe(200);
    });

    describe("preview-mode mutation guard interaction (mt#4023 PR #2902 R1)", () => {
      let previousPreview: string | undefined;

      beforeEach(() => {
        previousPreview = process.env.MINSKY_COCKPIT_PREVIEW;
        process.env.MINSKY_COCKPIT_PREVIEW = "true";
      });

      afterEach(() => {
        if (previousPreview === undefined) delete process.env.MINSKY_COCKPIT_PREVIEW;
        else process.env.MINSKY_COCKPIT_PREVIEW = previousPreview;
      });

      test("a passkey ceremony POST is not blocked by the preview mutation guard", async () => {
        const s = await startTestServer({
          isPublicDeployment: true,
          passkeyStore: passkeyStoreWith(0, false),
        });
        closeList.push(s.close);
        const res = await fetch(`${s.url}/api/auth/passkey/register/start`, {
          method: "POST",
          headers: { "Content-Type": CONTENT_TYPE_JSON },
          body: "{}",
        });
        // 403 here would mean the deployment is permanently un-signinable:
        // every data route denied, and the only way through returning 403.
        expect(res.status).not.toBe(403);
        expect(res.status).toBe(200);
      });

      test("a non-auth mutation IS still blocked once past the gate", async () => {
        const s = await startTestServer({
          isPublicDeployment: true,
          passkeyStore: alwaysAuthenticatedPasskeyStore(),
          ...emptyAskRepoOverride(),
        });
        closeList.push(s.close);
        const res = await fetch(`${s.url}/api/asks/nonexistent/resolve`, {
          method: "POST",
          headers: { "Content-Type": CONTENT_TYPE_JSON, Cookie: SESSION_COOKIE_HEADER },
          body: JSON.stringify({ responder: "operator", payload: {} }),
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ preview: true });
      });
    });

    test("first-run enrollment is open while NO passkey exists (mt#4023 SC3)", async () => {
      const s = await startTestServer({
        isPublicDeployment: true,
        passkeyStore: passkeyStoreWith(0, false),
      });
      closeList.push(s.close);
      const res = await fetch(`${s.url}/api/auth/passkey/register/start`, {
        method: "POST",
        headers: { "Content-Type": CONTENT_TYPE_JSON },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ceremonyId: expect.any(String) });
    });

    test("enrollment CLOSES once a passkey exists — the bootstrap window is not reusable (mt#4023 SC3)", async () => {
      // The security property: whoever reaches the URL second cannot enroll
      // themselves. Without this the gate would be a race, not a gate.
      const s = await startTestServer({
        isPublicDeployment: true,
        passkeyStore: passkeyStoreWith(1, false),
      });
      closeList.push(s.close);
      const res = await fetch(`${s.url}/api/auth/passkey/register/start`, {
        method: "POST",
        headers: { "Content-Type": CONTENT_TYPE_JSON },
        body: "{}",
      });
      expect(res.status).toBe(403);
    });

    test("an authenticated operator CAN still add another passkey (mt#4023 SC3)", async () => {
      const s = await startTestServer({
        isPublicDeployment: true,
        passkeyStore: passkeyStoreWith(1, true),
      });
      closeList.push(s.close);
      const res = await fetch(`${s.url}/api/auth/passkey/register/start`, {
        method: "POST",
        headers: { "Content-Type": CONTENT_TYPE_JSON, Cookie: SESSION_COOKIE_HEADER },
        body: "{}",
      });
      expect(res.status).toBe(200);
    });

    test("with a valid session, the request reaches the route (404 on unknown id)", async () => {
      const s = await startTestServer({
        isPublicDeployment: true,
        passkeyStore: alwaysAuthenticatedPasskeyStore(),
        ...emptyAskRepoOverride(),
      });
      closeList.push(s.close);
      const res = await fetch(`${s.url}/api/asks/nonexistent/resolve`, {
        method: "POST",
        headers: { "Content-Type": CONTENT_TYPE_JSON, Cookie: SESSION_COOKIE_HEADER },
        body: JSON.stringify({ responder: "operator", payload: {} }),
      });
      // 404, not 401: the gate passed and the route itself answered.
      expect(res.status).toBe(404);
    });

    test("still sets the CSP header (additive, not skipped)", async () => {
      const s = await startTestServer({ isPublicDeployment: true });
      closeList.push(s.close);
      const res = await fetch(`${s.url}/`);
      expect(res.headers.get(CSP_HEADER) ?? "").toContain("default-src 'self'");
    });
  });

  // -------------------------------------------------------------------------
  // (e) regression — SPA / api / assets content types unaffected by the new
  //     middleware chain (memory f558b1cb)
  // -------------------------------------------------------------------------

  describe("content-type regression after the security middleware chain", () => {
    let distDir: string;

    beforeAll(() => {
      distDir = fs.mkdtempSync(path.join(tmpdir(), "cockpit-security-dist-"));
      fs.mkdirSync(path.join(distDir, "assets"));
      fs.writeFileSync(
        path.join(distDir, "assets", "chunk-abc123.js"),
        "export const ok = true;\n"
      );
      fs.writeFileSync(
        path.join(distDir, "index.html"),
        '<!doctype html><html><body><div id="root"></div></body></html>\n'
      );
    });

    afterAll(() => {
      fs.rmSync(distDir, { recursive: true, force: true });
    });

    test("SPA fallback route still returns text/html", async () => {
      const s = await startTestServer({ overrideWebDistDir: distDir });
      closeList.push(s.close);
      const res = await fetch(`${s.url}/agents`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
    });

    test("/api/* still returns application/json", async () => {
      const s = await startTestServer({ overrideWebDistDir: distDir });
      closeList.push(s.close);
      const res = await fetch(`${s.url}/api/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain(CONTENT_TYPE_JSON);
    });

    test("/assets/* still returns a JavaScript content type", async () => {
      const s = await startTestServer({ overrideWebDistDir: distDir });
      closeList.push(s.close);
      const res = await fetch(`${s.url}/assets/chunk-abc123.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("javascript");
    });
  });
});
