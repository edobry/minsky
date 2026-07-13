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
import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { createServer, request as httpRequest } from "http";
import type { Server } from "http";
import net from "net";
import os from "os";
import fs from "fs";
import path from "path";
import { tmpdir } from "os";
import { createCockpitServer } from "./server";
import { FakeAskRepository } from "@minsky/domain/ask/repository";

const TEST_TOKEN = "test-server-security-token";
const CONTENT_TYPE_JSON = "application/json";
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
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: hostHeader } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
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
  // isPublicDeployment escape hatch (Railway entrypoint, services/cockpit/src/server.ts)
  // -------------------------------------------------------------------------

  describe("isPublicDeployment (Railway entrypoint carve-out)", () => {
    test("skips the Host-header allowlist — an arbitrary Host header is allowed", async () => {
      const s = await startTestServer({ isPublicDeployment: true });
      closeList.push(s.close);
      const res = await requestWithHost(s.port, "/api/health", "my-app.up.railway.app");
      expect(res.status).toBe(200);
    });

    test("skips mutation auth — a mutation with no token/cookie is not rejected with 401", async () => {
      const s = await startTestServer({ isPublicDeployment: true, ...emptyAskRepoOverride() });
      closeList.push(s.close);
      const res = await fetch(`${s.url}/api/asks/nonexistent/resolve`, {
        method: "POST",
        headers: { "Content-Type": CONTENT_TYPE_JSON },
        body: JSON.stringify({ responder: "operator", payload: {} }),
      });
      // No 401 gate — falls through to the route, which 404s on the unknown id.
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
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
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
