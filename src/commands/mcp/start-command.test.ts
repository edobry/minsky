import { describe, expect, test, afterEach } from "bun:test";
import { spawn } from "child_process";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "path";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  checkBearerAuth,
  composeRequestBaseUrl,
  composeWwwAuthenticate,
  normalizeEndpointPath,
  extractBearer,
  validateOAuthBearer,
  injectAgentIdMeta,
  buildSubagentDispatchTracker,
  wireSubagentDispatchTrackerWithRetry,
} from "./start-command";
import type { OAuthIdentityProvider, OAuthValidationResult } from "@minsky/domain/oauth/types";
import { AGENT_ID_META_KEY } from "@minsky/domain/agent-identity/layer2";
import { SubagentDispatchTracker } from "../../mcp/subagent-dispatch-tracker";
import {
  PersistenceProvider,
  type PersistenceCapabilities,
} from "@minsky/domain/persistence/types";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

// ---------------------------------------------------------------------------
// Helpers for integration tests
// ---------------------------------------------------------------------------

/** Resolve the absolute path to src/cli.ts from this test file's location. */
const CLI_PATH = path.resolve(__dirname, "../../cli.ts");

// ---------------------------------------------------------------------------
// Port allocation (mt#2764): every listener binds an OS-assigned ephemeral
// port instead of a fixed 41xxx literal. Fixed literals collide deterministically
// whenever two suite runs overlap — routine in this repo, where multiple agent
// sessions run the full suite concurrently. `lsof` on a live failure caught a
// peer session's `mcp start --http` holding one of the fixed literals.
// Mirrors src/cockpit/port-recovery.test.ts's bind-0-then-read pattern.
// ---------------------------------------------------------------------------

/**
 * Bind an in-process HTTP app on an OS-assigned port and return the app's
 * server plus the concrete port it landed on. Awaits the `listening` event so
 * `server.address()` is populated before the port is read.
 */
async function listenOnEphemeralPort(app: {
  listen: (port: number, host: string, cb: () => void) => import("http").Server;
}): Promise<{ server: import("http").Server; port: number }> {
  const server = await new Promise<import("http").Server>((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  const addr = server.address() as AddressInfo;
  return { server, port: addr.port };
}

/**
 * Find an unused TCP port WITHOUT holding it: bind 0, read the assigned port,
 * close. Used for the spawned-child MCP server, whose CLI validates `--port`
 * as 1–65535 (so it cannot accept `--port 0` directly). A small
 * bind-then-close-then-spawn window remains, but it is vastly safer than a
 * fixed literal and matches the repo's existing free-port pattern.
 */
async function findFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Bind an in-process HTTP app on a SPECIFIC, already-known port and resolve
 * once listening. Used by the audience-bound OAuth tests below, where the
 * port must be minted with `findFreePort()` BEFORE the app starts listening
 * (the port is baked into the JWT audience claim and the app's configured
 * `endpointUrl` ahead of the listen call), so `listenOnEphemeralPort`'s
 * bind-0-then-read pattern doesn't apply.
 */
async function listenOnKnownPort(
  app: { listen: (port: number, host: string, cb: () => void) => import("http").Server },
  port: number
): Promise<import("http").Server> {
  return new Promise<import("http").Server>((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
}

/** Log line printed by the cleanup path; tests assert it appears to prove the
 * shutdown handler ran (vs the kernel default action terminating the process). */
const SHUTDOWN_MARKER = "Stopping Minsky MCP Server";

// Test-local constants for magic-string deduplication (custom/no-magic-string-duplication rule).
const APPLICATION_JSON: string = "application" + "/" + "json";
const ERR_INVALID_CLIENT_METADATA: string = "invalid_" + "client_metadata";
const ERR_SERVICE_UNAVAILABLE: string = "service_" + "unavailable";
const ERR_SERVER_ERROR: string = "server_" + "error";
const ERR_REGISTRATION_NOT_SUPPORTED: string = "registration_" + "not_supported";
// mt#2493 dedup constants (concatenated to match the file convention above).
// Canonical-case header NAME for res.set(); Node lowercases header names on
// retrieval, so reads use response.headers.get("www-authenticate") (lowercase).
const WWW_AUTHENTICATE: string = "WWW-" + "Authenticate";
const HDR_X_FORWARDED_PROTO: string = "X-Forwarded-" + "Proto";
const HDR_X_FORWARDED_HOST: string = "X-Forwarded-" + "Host";
const AUDIENCE_MISMATCH_DESC: string = "audience" + " mismatch";
const GRANT_AUTHORIZATION_CODE: string = "authorization_" + "code";

/**
 * Spawn `bun <CLI_PATH> mcp start` and return the child process.
 * The caller is responsible for sending signals / closing stdio.
 */
function spawnMcpStart(env?: Record<string, string>) {
  return spawn("bun", [CLI_PATH, "mcp", "start"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

/** Result returned from waitForExit: exit code + accumulated stderr+stdout output. */
interface ExitResult {
  code: number | null;
  output: string;
}

/**
 * Wait for a child process to exit, resolving with the exit code AND the
 * accumulated stderr+stdout output. Output capture lets tests assert on the
 * cleanup-path log lines ("Stopping Minsky MCP Server...", "Shutdown timed out
 * after Nms; forcing exit") so a regression that exits with the right code
 * but skips the cleanup path no longer passes silently (PR #881 R1 NON-BLOCKING).
 *
 * Rejects after `timeoutMs` if the process has not exited.
 */
function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    let output = "";
    const append = (chunk: Buffer | string) => {
      // String() handles both string and Buffer; node.d.ts override doesn't
      // expose Buffer.toString(encoding) so we avoid passing the encoding arg.
      output += typeof chunk === "string" ? chunk : String(chunk);
    };
    // Cast through a narrower type because the project's node.d.ts override
    // doesn't expose the (data, listener) overload of EventEmitter.on.
    const stdoutEmitter = child.stdout as unknown as {
      on(event: "data", listener: (chunk: Buffer | string) => void): void;
    } | null;
    const stderrEmitter = child.stderr as unknown as {
      on(event: "data", listener: (chunk: Buffer | string) => void): void;
    } | null;
    if (stdoutEmitter) stdoutEmitter.on("data", append);
    if (stderrEmitter) stderrEmitter.on("data", append);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Process did not exit within ${timeoutMs}ms. Captured output:\n${output}`));
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/**
 * Wait until the child has logged "Press Ctrl+C to stop" — the server prints
 * this AFTER registering its SIGTERM/SIGINT/SIGHUP and stdin "close" shutdown
 * handlers (mt#1417, PR #881 R2 ordering fix), so it's the deterministic
 * readiness signal: by the time this line appears, all handlers are already
 * attached. Sending shutdown events before this line would hit the kernel
 * default action and exit with code=null, masking real handler regressions.
 *
 * Rejects after `timeoutMs` if the readiness line is never seen.
 */
function waitForReady(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  const READY_MARKER = "Press Ctrl+C to stop";
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      // String() handles both string and Buffer; node.d.ts override doesn't
      // expose Buffer.toString(encoding) so we avoid passing the encoding arg.
      buffer += typeof chunk === "string" ? chunk : String(chunk);
      if (buffer.includes(READY_MARKER)) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    // Cast through a narrower type because the project's node.d.ts override
    // doesn't expose the (data, listener) overload of EventEmitter.on.
    const stdoutEmitter = child.stdout as unknown as {
      on(event: "data", listener: (chunk: Buffer | string) => void): void;
    } | null;
    const stderrEmitter = child.stderr as unknown as {
      on(event: "data", listener: (chunk: Buffer | string) => void): void;
    } | null;
    if (stdoutEmitter) stdoutEmitter.on("data", onData);
    if (stderrEmitter) stderrEmitter.on("data", onData);
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `Server did not log readiness marker "${READY_MARKER}" within ${timeoutMs}ms. ` +
              `Captured output so far:\n${buffer}`
          )
        );
      }
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Integration tests — shutdown paths (mt#1417)
// ---------------------------------------------------------------------------

describe("mcp start — shutdown paths", () => {
  test("exits with code 0 and runs cleanup path when stdin is closed", async () => {
    const child = spawnMcpStart();

    await waitForReady(child, 5000);

    // Close stdin (simulates Claude Code closing the stdio pipe).
    // stdin is always a Writable stream when stdio[0] is "pipe".
    if (child.stdin) child.stdin.end();

    const { code, output } = await waitForExit(child, 6000);
    expect(code).toBe(0);
    expect(output).toContain(SHUTDOWN_MARKER);
  }, 12000);

  test("exits cleanly with code 0 and runs cleanup path when sent SIGTERM", async () => {
    const child = spawnMcpStart();

    await waitForReady(child, 5000);

    child.kill("SIGTERM");

    const { code, output } = await waitForExit(child, 6000);
    expect(code).toBe(0);
    expect(output).toContain(SHUTDOWN_MARKER);
  }, 12000);

  test("exits cleanly with code 0 and runs cleanup path when sent SIGHUP", async () => {
    const child = spawnMcpStart();

    await waitForReady(child, 5000);

    child.kill("SIGHUP");

    const { code, output } = await waitForExit(child, 6000);
    expect(code).toBe(0);
    expect(output).toContain(SHUTDOWN_MARKER);
  }, 12000);

  test("hard-timeout path: exits promptly within drain-timeout + cleanup buffer", async () => {
    // Force a very short drain timeout. In test env without a real hung pool the
    // drain typically succeeds cleanly (code 0), but the property the test
    // protects is "exits promptly within drain_timeout + cleanup_buffer".
    // If drain DID hang, the timeout-path log line "Shutdown timed out after"
    // proves the forced-exit path fired.
    const child = spawnMcpStart({ PG_DRAIN_TIMEOUT_MS: "200" });

    await waitForReady(child, 5000);

    const startedAt = Date.now();

    // stdin is always a Writable stream when stdio[0] is "pipe".
    if (child.stdin) child.stdin.end();

    const { code, output } = await waitForExit(child, 7000);
    // eslint-disable-next-line custom/no-real-fs-in-tests -- timing measurement, not path creation
    const elapsedMs = Date.now() - startedAt;

    // Process must have exited; either path is acceptable.
    expect(code === 0 || code === 1).toBe(true);
    // Cleanup path log line must appear regardless of which exit fired.
    expect(output).toContain(SHUTDOWN_MARKER);
    // If exit was forced (code 1), the warn-log line must be present.
    if (code === 1) {
      expect(output).toContain("Shutdown timed out after");
    }
    // Promptness: even with a hung drain the timeout caps the wait. The bound
    // is drain-timeout (200ms) + generous CI slack to absorb spawn warmup +
    // contended-runner overhead while still failing if the process hung past
    // the buffer window (PR #881 R2 NON-BLOCKING — was 2500ms, too tight for CI).
    expect(elapsedMs).toBeLessThan(6000);
  }, 12000);

  test("PG_DRAIN_TIMEOUT_MS sanitization: junk env value falls back to default, doesn't immediately exit(1) (PR #881 R1 BLOCKING regression-protect)", async () => {
    // Pre-fix bug: parseInt("garbage", 10) === NaN; setTimeout(NaN) coerces
    // to 0 → hard-timeout fires immediately on shutdown, forcing exit(1) even
    // when a clean drain would have succeeded. Post-fix: junk values fall
    // back to the 5000ms default and the process exits cleanly via SIGTERM.
    const child = spawnMcpStart({ PG_DRAIN_TIMEOUT_MS: "this-is-not-a-number" });

    await waitForReady(child, 5000);
    child.kill("SIGTERM");

    const { code, output } = await waitForExit(child, 6000);
    expect(code).toBe(0);
    expect(output).toContain(SHUTDOWN_MARKER);
    // The forced-exit path's log line must NOT appear — the default kicked in.
    expect(output).not.toContain("Shutdown timed out after");
  }, 12000);
});

describe("checkBearerAuth", () => {
  const TOKEN = "s3cret-token-example-1234";

  test("accepts a well-formed Bearer header with matching token", () => {
    expect(checkBearerAuth(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  test("is case-insensitive on the scheme", () => {
    expect(checkBearerAuth(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(checkBearerAuth(`BEARER ${TOKEN}`, TOKEN)).toBe(true);
  });

  test("tolerates multiple whitespace between scheme and token", () => {
    expect(checkBearerAuth(`Bearer  ${TOKEN}`, TOKEN)).toBe(true);
    expect(checkBearerAuth(`Bearer\t${TOKEN}`, TOKEN)).toBe(true);
  });

  test("rejects missing header", () => {
    expect(checkBearerAuth(undefined, TOKEN)).toBe(false);
    expect(checkBearerAuth("", TOKEN)).toBe(false);
  });

  test("rejects non-Bearer schemes", () => {
    expect(checkBearerAuth(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(checkBearerAuth(`Token ${TOKEN}`, TOKEN)).toBe(false);
    expect(checkBearerAuth(TOKEN, TOKEN)).toBe(false);
  });

  test("rejects a Bearer header with the wrong token", () => {
    expect(checkBearerAuth(`Bearer not-the-token`, TOKEN)).toBe(false);
    expect(checkBearerAuth(`Bearer ${TOKEN}-extra`, TOKEN)).toBe(false);
  });

  test("rejects when expected token is empty", () => {
    expect(checkBearerAuth(`Bearer ${TOKEN}`, "")).toBe(false);
  });

  test("rejects a Bearer header with an empty token", () => {
    expect(checkBearerAuth("Bearer ", TOKEN)).toBe(false);
    expect(checkBearerAuth("Bearer", TOKEN)).toBe(false);
  });

  test("does not accept a prefix match (entire token must match)", () => {
    expect(checkBearerAuth(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
  });

  test("trims trailing whitespace on the token", () => {
    expect(checkBearerAuth(`Bearer ${TOKEN}   `, TOKEN)).toBe(true);
  });
});

describe("OAuth Discovery URL composition (mt#1655)", () => {
  describe("normalizeEndpointPath", () => {
    test("preserves a leading slash unchanged", () => {
      expect(normalizeEndpointPath("/mcp")).toBe("/mcp");
      expect(normalizeEndpointPath("/")).toBe("/");
      expect(normalizeEndpointPath("/api/v1/mcp")).toBe("/api/v1/mcp");
    });

    test("prepends a leading slash when missing — fixes mt#1655 R1 finding 3", () => {
      // Without normalization, embedding `--endpoint mcp` (no slash) into
      // `https://example.com${endpoint}` produces invalid `https://example.commcp`.
      expect(normalizeEndpointPath("mcp")).toBe("/mcp");
      expect(normalizeEndpointPath("api/v1/mcp")).toBe("/api/v1/mcp");
    });
  });

  describe("composeRequestBaseUrl", () => {
    test("composes from req.protocol + req.hostname", () => {
      const req = { protocol: "https", hostname: "example.com" } as import("express").Request;
      expect(composeRequestBaseUrl(req)).toBe("https://example.com");
    });

    test("falls back to localhost when hostname is missing or empty", () => {
      const reqEmpty = { protocol: "http", hostname: "" } as import("express").Request;
      expect(composeRequestBaseUrl(reqEmpty)).toBe("http://localhost");
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests for OAuth route handlers via express app (mt#1664)
// These tests wire a mock OAuthIdentityProvider directly into an express app
// to verify route behavior without spawning a subprocess.
// ---------------------------------------------------------------------------

describe("OAuth route handlers — with provider (mt#1664 unit)", () => {
  // Import express inline to build a minimal test app
  const buildTestApp = async (provider: OAuthIdentityProvider) => {
    const expressModule = await import("express");
    const expressApp = expressModule.default();
    expressApp.use(expressModule.default.json());

    expressApp.get("/.well-known/oauth-authorization-server", async (req, res) => {
      try {
        const metadata = await provider.discoveryMetadata(req);
        res.json(metadata);
      } catch (err) {
        res.status(500).json({ error: ERR_SERVER_ERROR, error_description: String(err) });
      }
    });

    expressApp.get("/.well-known/oauth-protected-resource", async (req, res) => {
      try {
        const metadata = await provider.protectedResourceMetadata(req);
        res.json(metadata);
      } catch (err) {
        res.status(500).json({ error: ERR_SERVER_ERROR, error_description: String(err) });
      }
    });

    expressApp.post("/register", async (req, res) => {
      try {
        const result = await provider.registerClient(req.body);
        res.status(201).json(result);
      } catch (err) {
        res.status(400).json({
          error: ERR_INVALID_CLIENT_METADATA,
          error_description: String(err),
        });
      }
    });

    return expressApp;
  };

  test("discoveryMetadata — RFC 8414 real fields delivered to route", async () => {
    const mockProvider: OAuthIdentityProvider = {
      async discoveryMetadata(_req) {
        return {
          issuer: "https://example.com",
          authorization_endpoint: "https://example.com/oauth/authorize",
          token_endpoint: "https://example.com/oauth/token",
          registration_endpoint: "https://example.com/register",
          response_types_supported: ["code"],
          grant_types_supported: [GRANT_AUTHORIZATION_CODE, "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "mcp", "offline_access"],
        };
      },
      async protectedResourceMetadata(_req) {
        return {
          resource: "https://example.com/mcp",
          authorization_servers: ["https://example.com"],
        };
      },
      async registerClient(_body) {
        return {
          client_id: "test-client-id",
          client_secret: "test-secret",
          redirect_uris: ["https://example.com/callback"],
          grant_types: [GRANT_AUTHORIZATION_CODE, "refresh_token"],
          token_endpoint_auth_method: "client_secret_basic",
        };
      },
      async authorize(_req, _res) {},
      async token(_req, _res) {},
      async forwardInteraction(_req, _res) {},
      async validateToken(_bearer) {
        return { valid: false, reason: "not_found" as const };
      },
    };

    const app = await buildTestApp(mockProvider);
    const { server, port } = await listenOnEphemeralPort(app);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      // RFC 8414 required fields
      expect(body.issuer).toBe("https://example.com");
      expect(body.authorization_endpoint).toBe("https://example.com/oauth/authorize");
      expect(body.token_endpoint).toBe("https://example.com/oauth/token");
      expect(body.registration_endpoint).toBe("https://example.com/register");
      // Real flows advertised (mt#1664 replaces empty stub)
      expect(body.response_types_supported).toEqual(["code"]);
      expect(body.grant_types_supported).toEqual([GRANT_AUTHORIZATION_CODE, "refresh_token"]);
      expect(body.code_challenge_methods_supported).toEqual(["S256"]);
      expect(Array.isArray(body.scopes_supported)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("protectedResourceMetadata — RFC 9728 real fields delivered to route", async () => {
    const mockProvider: OAuthIdentityProvider = {
      async discoveryMetadata(_req) {
        return {
          issuer: "https://example.com",
          authorization_endpoint: "https://example.com/oauth/authorize",
          token_endpoint: "https://example.com/oauth/token",
          response_types_supported: ["code"],
        };
      },
      async protectedResourceMetadata(_req) {
        return {
          resource: "https://example.com/mcp",
          authorization_servers: ["https://example.com"],
          scopes_supported: ["mcp"],
          bearer_methods_supported: ["header"],
        };
      },
      async registerClient(_body) {
        return {
          client_id: "c",
          redirect_uris: [],
          grant_types: [],
          token_endpoint_auth_method: "none",
        };
      },
      async authorize(_req, _res) {},
      async token(_req, _res) {},
      async forwardInteraction(_req, _res) {},
      async validateToken(_bearer) {
        return { valid: false, reason: "not_found" as const };
      },
    };

    const app = await buildTestApp(mockProvider);
    const { server, port } = await listenOnEphemeralPort(app);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      // RFC 9728 required fields
      expect(body.resource).toBe("https://example.com/mcp");
      expect(body.authorization_servers).toEqual(["https://example.com"]);
      expect(Array.isArray(body.scopes_supported)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("POST /register — valid body returns 201 + client credentials (RFC 7591)", async () => {
    const mockProvider: OAuthIdentityProvider = {
      async discoveryMetadata(_req) {
        return {
          issuer: "https://example.com",
          authorization_endpoint: "https://example.com/oauth/authorize",
          token_endpoint: "https://example.com/oauth/token",
          response_types_supported: ["code"],
        };
      },
      async protectedResourceMetadata(_req) {
        return {
          resource: "https://example.com/mcp",
          authorization_servers: ["https://example.com"],
        };
      },
      async registerClient(body) {
        return {
          client_id: "new-client-id",
          client_secret: "new-client-secret",
          client_name: body.client_name,
          redirect_uris: body.redirect_uris,
          grant_types: body.grant_types ?? [GRANT_AUTHORIZATION_CODE],
          token_endpoint_auth_method: "client_secret_basic",
          registration_access_token: "reg-access-token",
        };
      },
      async authorize(_req, _res) {},
      async token(_req, _res) {},
      async forwardInteraction(_req, _res) {},
      async validateToken(_bearer) {
        return { valid: false, reason: "not_found" as const };
      },
    };

    const app = await buildTestApp(mockProvider);
    const { server, port } = await listenOnEphemeralPort(app);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/register`, {
        method: "POST",
        headers: { "Content-Type": APPLICATION_JSON },
        body: JSON.stringify({
          client_name: "Test Client",
          redirect_uris: ["https://example.com/callback"],
          grant_types: [GRANT_AUTHORIZATION_CODE],
        }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as Record<string, unknown>;
      expect(typeof body.client_id).toBe("string");
      expect(typeof body.client_secret).toBe("string");
      expect(body.registration_access_token).toBeTypeOf("string");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("POST /register — invalid body returns 400 with RFC 7591 error format", async () => {
    const mockProvider: OAuthIdentityProvider = {
      async discoveryMetadata(_req) {
        return {
          issuer: "https://example.com",
          authorization_endpoint: "https://example.com/oauth/authorize",
          token_endpoint: "https://example.com/oauth/token",
          response_types_supported: ["code"],
        };
      },
      async protectedResourceMetadata(_req) {
        return {
          resource: "https://example.com/mcp",
          authorization_servers: ["https://example.com"],
        };
      },
      async registerClient(_body) {
        throw new Error("redirect_uris is required for client registration");
      },
      async authorize(_req, _res) {},
      async token(_req, _res) {},
      async forwardInteraction(_req, _res) {},
      async validateToken(_bearer) {
        return { valid: false, reason: "not_found" as const };
      },
    };

    const app = await buildTestApp(mockProvider);
    const { server, port } = await listenOnEphemeralPort(app);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/register`, {
        method: "POST",
        headers: { "Content-Type": APPLICATION_JSON },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      // RFC 7591 §3.2.2 error format
      expect(body.error).toBe(ERR_INVALID_CLIENT_METADATA);
      expect(typeof body.error_description).toBe("string");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("OAuth Discovery HTTP routes (mt#1655 / mt#1664 integration)", () => {
  // These tests spawn the server in --http mode on a random port, wait for
  // the ready log, and fetch the OAuth endpoints. Without a DATABASE_URL the
  // server has no OAuth provider; well-known endpoints return 503 and /register
  // returns 400. The /oauth/* stubs remain 400 regardless.

  const HTTP_READY_MARKER = "Ready to receive MCP requests via HTTP";

  /**
   * Spawn the MCP server in --http mode on an OS-assigned free port (mt#2764:
   * `findFreePort()` picks the port since the CLI's `--port` validation
   * rejects `0`). Returns the child, the port it was launched on, and a
   * promise that resolves when the ready-log line is seen, or rejects on
   * timeout. The child is the caller's responsibility to terminate.
   */
  async function spawnHttpMcp(
    extraEnv?: Record<string, string>
  ): Promise<{ child: ReturnType<typeof spawn>; ready: Promise<void>; port: number }> {
    const port = await findFreePort();
    const child = spawn(
      "bun",
      [CLI_PATH, "mcp", "start", "--http", "--port", String(port), "--host", "127.0.0.1"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...extraEnv },
      }
    );

    const ready = new Promise<void>((resolve, reject) => {
      let buffered = "";
      const append = (chunk: Buffer | string) => {
        buffered += typeof chunk === "string" ? chunk : String(chunk);
        if (buffered.includes(HTTP_READY_MARKER)) {
          resolve();
        }
      };
      const stdoutEmitter = child.stdout as unknown as {
        on(event: "data", listener: (chunk: Buffer | string) => void): void;
      } | null;
      const stderrEmitter = child.stderr as unknown as {
        on(event: "data", listener: (chunk: Buffer | string) => void): void;
      } | null;
      if (stdoutEmitter) stdoutEmitter.on("data", append);
      if (stderrEmitter) stderrEmitter.on("data", append);
      const timeoutId = setTimeout(() => {
        reject(new Error(`HTTP server did not ready within timeout. Buffered: ${buffered}`));
      }, 15000);
      child.on("exit", () => clearTimeout(timeoutId));
    });

    return { child, ready, port };
  }

  test("GET /.well-known/oauth-authorization-server returns parseable error when DB unavailable", async () => {
    // Three valid outcomes — the test's load-bearing invariant is "route exists,
    // handler ran, response body is parseable JSON":
    //   - 200 with OAuth metadata (provider wired via local config — common dev case)
    //   - 503 service_unavailable (provider not constructed; clean no-DB path)
    //   - 500 server_error (provider constructed but errored at metadata-build time)
    // The test cannot reliably force the no-DB path with just DATABASE_URL="" because
    // the persistence layer reads from ~/.config/minsky/config.yaml independently
    // (mt#1987: empirically observed during the test-fixup pass; the env var alone is
    // insufficient to fully disable persistence).
    const { child, ready, port } = await spawnHttpMcp({ DATABASE_URL: "" });
    try {
      await ready;
      const response = await fetch(
        `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`
      );
      expect([200, 500, 503]).toContain(response.status);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await response.json()) as Record<string, unknown>;
      if (response.status === 200) {
        expect(body.issuer).toBeTypeOf("string");
        expect(body.authorization_endpoint).toBeTypeOf("string");
        expect(body.token_endpoint).toBeTypeOf("string");
      } else {
        expect([ERR_SERVICE_UNAVAILABLE, ERR_SERVER_ERROR]).toContain(body.error);
        expect(typeof body.error_description).toBe("string");
      }
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10000).catch(() => {
        /* best-effort cleanup */
      });
    }
  }, 30000);

  test("GET /.well-known/oauth-protected-resource returns parseable JSON", async () => {
    // RFC 9728 protected-resource metadata is structurally simple — the provider can
    // build it from the request URL without DB state. Three valid outcomes:
    //   - 200 with {resource, authorization_servers} (provider succeeded)
    //   - 503 service_unavailable (provider not constructed; clean no-DB path)
    //   - 500 server_error (provider constructed but errored at metadata-build time)
    const { child, ready, port } = await spawnHttpMcp({ DATABASE_URL: "" });
    try {
      await ready;
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
      expect([200, 500, 503]).toContain(response.status);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await response.json()) as Record<string, unknown>;
      if (response.status === 200) {
        expect(body.resource).toBeTypeOf("string");
      } else {
        expect([ERR_SERVICE_UNAVAILABLE, ERR_SERVER_ERROR]).toContain(body.error);
        expect(typeof body.error_description).toBe("string");
      }
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10000).catch(() => {
        /* best-effort cleanup */
      });
    }
  }, 30000);

  test("X-Forwarded-Proto: https is forwarded correctly (trust proxy 1 wired)", async () => {
    // Verifies that the trust-proxy setting is still active and the route fires
    // (not a 404 / routing miss). Any of 200, 500, or 503 confirms the handler ran.
    // The 200 path additionally proves the issuer is constructed from the forwarded
    // proto/host (the trust-proxy contract under test).
    const { child, ready, port } = await spawnHttpMcp({ DATABASE_URL: "" });
    try {
      await ready;
      const response = await fetch(
        `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`,
        {
          headers: {
            [HDR_X_FORWARDED_PROTO]: "https",
            [HDR_X_FORWARDED_HOST]: "minsky-mcp-production.up.railway.app",
          },
        }
      );
      expect([200, 500, 503]).toContain(response.status);
      const body = (await response.json()) as Record<string, unknown>;
      if (response.status === 200) {
        // Trust-proxy is wired correctly when the issuer URL reflects the
        // forwarded proto/host rather than the loopback the server bound to.
        expect(body.issuer).toMatch(/^https:\/\/minsky-mcp-production\.up\.railway\.app/);
      } else {
        expect([ERR_SERVICE_UNAVAILABLE, ERR_SERVER_ERROR]).toContain(body.error);
      }
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10000).catch(() => {
        /* best-effort cleanup */
      });
    }
  }, 30000);

  test("POST /register returns 400 with parseable error when DB unavailable", async () => {
    // Without a working OAuthProvider, /register returns 400 with one of:
    //   - registration_not_supported (provider not constructed; no-DB path)
    //   - invalid_client_metadata (provider constructed but registerClient threw)
    // Both are RFC 7591-shaped errors with parseable JSON.
    const { child, ready, port } = await spawnHttpMcp({ DATABASE_URL: "" });
    try {
      await ready;
      const response = await fetch(`http://127.0.0.1:${port}/register`, {
        method: "POST",
        headers: { "Content-Type": APPLICATION_JSON },
        body: "{}",
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect([ERR_REGISTRATION_NOT_SUPPORTED, ERR_INVALID_CLIENT_METADATA]).toContain(body.error);
      expect(typeof body.error_description).toBe("string");
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10000).catch(() => {
        /* best-effort cleanup */
      });
    }
  }, 30000);

  // /oauth/authorize and /oauth/token now delegate to OAuthIdentityProvider (mt#1665).
  // Without a DATABASE_URL the provider is not wired, so the endpoints return
  // 503 service_unavailable (no-provider path). The assertions are tolerant of
  // both 503 (no provider) and 500 (provider wired but errored) — same pattern
  // as the discovery endpoint tests above.

  test("GET /oauth/authorize returns parseable error when DB unavailable (mt#1665)", async () => {
    // Three valid outcomes — the test's load-bearing invariant is "route exists,
    // handler ran, response body is parseable JSON":
    //   - 400 invalid_request with a parameter-validation message
    //     (provider wired; common dev case — authorize() validates PKCE / params
    //     before touching DB, so it rejects the malformed request cleanly)
    //   - 503 service_unavailable (provider not constructed; clean no-DB path)
    //   - 500 server_error (provider constructed but authorize() threw before headers sent)
    // mt#1987: the 400 path was added when authorize() picked up parameter-shape
    // validation upstream of persistence access; the prior 500/503-only assertion
    // assumed the provider would fail at request handling.
    const { child, ready, port } = await spawnHttpMcp({ DATABASE_URL: "" });
    try {
      await ready;
      const response = await fetch(`http://127.0.0.1:${port}/oauth/authorize`);
      expect([400, 500, 503]).toContain(response.status);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await response.json()) as Record<string, unknown>;
      expect(typeof body.error).toBe("string");
      expect(typeof body.error_description).toBe("string");
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10000).catch(() => {
        /* best-effort cleanup */
      });
    }
  }, 30000);

  test("POST /oauth/token returns parseable error when DB unavailable (mt#1665)", async () => {
    // Three valid outcomes — same shape as /oauth/authorize above:
    //   - 400 invalid_request (content-type / form-encoding validation rejects the
    //     malformed request before persistence access)
    //   - 503 service_unavailable (provider not constructed)
    //   - 500 server_error (provider constructed but token() threw)
    // mt#1987: this test was updated alongside /oauth/authorize for the same reason.
    const { child, ready, port } = await spawnHttpMcp({ DATABASE_URL: "" });
    try {
      await ready;
      const response = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": APPLICATION_JSON },
        body: "{}",
      });
      expect([400, 500, 503]).toContain(response.status);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await response.json()) as Record<string, unknown>;
      expect(typeof body.error).toBe("string");
      expect(typeof body.error_description).toBe("string");
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10000).catch(() => {
        /* best-effort cleanup */
      });
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// Unit tests for extractBearer (mt#1666)
// ---------------------------------------------------------------------------

describe("extractBearer (mt#1666)", () => {
  test("extracts token from well-formed Bearer header", () => {
    expect(extractBearer("Bearer my-token-123")).toBe("my-token-123");
  });

  test("is case-insensitive on the scheme", () => {
    expect(extractBearer("bearer my-token-123")).toBe("my-token-123");
    expect(extractBearer("BEARER my-token-123")).toBe("my-token-123");
  });

  test("returns null for missing header", () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer("")).toBeNull();
  });

  test("returns null for non-Bearer schemes", () => {
    expect(extractBearer("Basic dXNlcjpwYXNz")).toBeNull();
    expect(extractBearer("Token abc123")).toBeNull();
  });

  test("returns null for empty token after Bearer", () => {
    expect(extractBearer("Bearer ")).toBeNull();
    expect(extractBearer("Bearer")).toBeNull();
  });

  test("trims trailing whitespace from token", () => {
    expect(extractBearer("Bearer my-token   ")).toBe("my-token");
  });
});

// ---------------------------------------------------------------------------
// Unit tests for validateOAuthBearer (mt#1666)
// ---------------------------------------------------------------------------

// Test-local constants for magic-string deduplication.
const ERR_INVALID_TOKEN: string = "invalid_" + "token";
const ENDPOINT_URL = "https://example.com/mcp";
const AUDIENCE_MISMATCH = "audience_" + "mismatch";
// agentId returned by mock provider in validateOAuthBearer unit tests
const VALIDATE_TEST_SUB = "user-abc";
const VALIDATE_TEST_AGENT_ID = `oauth:claude-ai:user-${VALIDATE_TEST_SUB}`;

/** Build a minimal mock OAuthIdentityProvider that returns a fixed validateToken result. */
function buildMockProvider(validateResult: OAuthValidationResult): OAuthIdentityProvider {
  return {
    async discoveryMetadata(_req) {
      return {
        issuer: "https://example.com",
        authorization_endpoint: "https://example.com/oauth/authorize",
        token_endpoint: "https://example.com/oauth/token",
        response_types_supported: ["code"],
      };
    },
    async protectedResourceMetadata(_req) {
      return {
        resource: "https://example.com/mcp",
        authorization_servers: ["https://example.com"],
      };
    },
    async registerClient(_body) {
      return {
        client_id: "c",
        redirect_uris: [],
        grant_types: [],
        token_endpoint_auth_method: "none",
      };
    },
    async authorize(_req, _res) {},
    async token(_req, _res) {},
    async forwardInteraction(_req, _res) {},
    async validateToken(_bearer) {
      return validateResult;
    },
  };
}

describe("validateOAuthBearer (mt#1666)", () => {
  test("returns ok=true with agentId when token is valid and audience matches", async () => {
    const provider = buildMockProvider({
      valid: true,
      principal: {
        sub: VALIDATE_TEST_SUB,
        clientId: "client-1",
        agentId: VALIDATE_TEST_AGENT_ID,
      },
      scopes: ["mcp"],
      audience: ENDPOINT_URL,
    });

    const result = await validateOAuthBearer("some-token", provider, ENDPOINT_URL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agentId).toBe(VALIDATE_TEST_AGENT_ID);
    }
  });

  test("returns ok=true when token audience is null (no audience binding)", async () => {
    const provider = buildMockProvider({
      valid: true,
      principal: {
        sub: VALIDATE_TEST_SUB,
        clientId: "client-1",
        agentId: VALIDATE_TEST_AGENT_ID,
      },
      scopes: ["mcp"],
      audience: null,
    });

    const result = await validateOAuthBearer("some-token", provider, ENDPOINT_URL);
    expect(result.ok).toBe(true);
  });

  test("returns ok=false with reason=expired when token is expired", async () => {
    const provider = buildMockProvider({ valid: false, reason: "expired" });
    const result = await validateOAuthBearer("some-token", provider, ENDPOINT_URL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
    }
  });

  test("returns ok=false with reason=revoked when token is revoked", async () => {
    const provider = buildMockProvider({ valid: false, reason: "revoked" });
    const result = await validateOAuthBearer("some-token", provider, ENDPOINT_URL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("revoked");
    }
  });

  test("returns ok=false with reason=audience_mismatch when audience does not match", async () => {
    const provider = buildMockProvider({
      valid: true,
      principal: {
        sub: VALIDATE_TEST_SUB,
        clientId: "client-1",
        agentId: VALIDATE_TEST_AGENT_ID,
      },
      scopes: ["mcp"],
      audience: "https://other-server.com/mcp",
    });

    const result = await validateOAuthBearer("some-token", provider, ENDPOINT_URL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(AUDIENCE_MISMATCH);
    }
  });

  test("returns ok=false with reason=not_found when token not found", async () => {
    const provider = buildMockProvider({ valid: false, reason: "not_found" });
    const result = await validateOAuthBearer("some-token", provider, ENDPOINT_URL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests — /mcp auth middleware (mt#1666)
// These tests wire a mock OAuthIdentityProvider + express app to verify the
// /mcp route accepts/rejects tokens as expected.
// ---------------------------------------------------------------------------

describe("OAuth /mcp auth middleware (mt#1666 unit)", () => {
  // Build a minimal express app that mimics the /mcp auth gating from startHttpServer.
  // We test the auth logic only (replacing the real MCP handler with a simple 200).
  const buildMcpAuthApp = async (opts: {
    staticToken?: string;
    provider?: OAuthIdentityProvider;
    endpointUrl?: string;
  }) => {
    const expressModule = await import("express");
    const expressApp = expressModule.default();
    // mt#2493: mirror production's trust-proxy so X-Forwarded-Proto/Host drive
    // the request base URL (and thus the WWW-Authenticate resource_metadata URL).
    expressApp.set("trust proxy", 1);
    expressApp.use(expressModule.default.json());

    const { checkBearerAuth: chkAuth, extractBearer: exBearer } = await import("./start-command");
    const { validateOAuthBearer: validateOAuth } = await import("./start-command");
    const metaKey = AGENT_ID_META_KEY;

    const staticToken = opts.staticToken;
    const oauthProvider = opts.provider;
    const endpointUrl = opts.endpointUrl ?? "http://127.0.0.1:0/mcp";

    expressApp.all("/mcp", async (req, res) => {
      // Mirror production gating logic: enforce auth when EITHER static-bearer OR
      // OAuth provider is configured (mt#1666 fix for the auto-reviewer-bot
      // BLOCKING #1 — previously this gated only on staticToken, leaving /mcp
      // unauthenticated in OAuth-only deployments).
      const authRequired = !!staticToken || !!oauthProvider;
      if (authRequired) {
        const header = req.header("authorization") ?? req.header("Authorization");
        const staticOk = !!staticToken && chkAuth(header, staticToken);

        if (staticOk) {
          // Pass through
        } else if (oauthProvider) {
          const bearer = exBearer(header);
          if (!bearer) {
            res.set(WWW_AUTHENTICATE, composeWwwAuthenticate(req));
            res.status(401).json({ error: "unauthorized", message: "valid bearer token required" });
            return;
          }

          const oauthResult = await validateOAuth(bearer, oauthProvider, endpointUrl);
          if (!oauthResult.ok) {
            const errorCode =
              oauthResult.reason === AUDIENCE_MISMATCH ? ERR_INVALID_TOKEN : "unauthorized";
            const description =
              oauthResult.reason === AUDIENCE_MISMATCH
                ? "audience mismatch"
                : oauthResult.reason === "expired"
                  ? "token expired"
                  : "invalid token";
            res.set(
              WWW_AUTHENTICATE,
              composeWwwAuthenticate(req, { error: errorCode, errorDescription: description })
            );
            res.status(401).json({ error: errorCode, error_description: description });
            return;
          }

          // Inject agentId into body (mt#1765: into params._meta, NOT top-level _meta).
          // Uses the real production helper so the test exercises the same code path the
          // middleware uses (no hand-mirrored copy that could drift — PR #1064 R1 NON-BLOCKING).
          if (req.method === "POST" && req.body && typeof req.body === "object") {
            if (Array.isArray(req.body)) {
              req.body = req.body.map((item: unknown) =>
                item && typeof item === "object" && !Array.isArray(item)
                  ? injectAgentIdMeta(item as Record<string, unknown>, oauthResult.agentId)
                  : item
              );
            } else {
              req.body = injectAgentIdMeta(
                req.body as Record<string, unknown>,
                oauthResult.agentId
              );
            }
          }
        } else {
          res.set(WWW_AUTHENTICATE, "Bearer");
          res.status(401).json({ error: "unauthorized", message: "valid bearer token required" });
          return;
        }
      }

      // Echo back the processed body and agentId for verification.
      // mt#1765: agentId now lives in params._meta, not top-level _meta.
      const body = req.body as Record<string, unknown>;
      const params =
        body?.params && typeof body.params === "object" && !Array.isArray(body.params)
          ? (body.params as Record<string, unknown>)
          : undefined;
      const paramsMeta =
        params?._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
          ? (params._meta as Record<string, unknown>)
          : undefined;
      const injectedAgentId = paramsMeta?.[metaKey] as string | undefined;
      res.json({ ok: true, agentId: injectedAgentId ?? null });
    });

    return expressApp;
  };

  const VALID_SUB = "test-user-abc";
  const VALID_AGENT_ID = `oauth:claude-ai:user-${VALID_SUB}`;

  test("static-bearer path continues to work with valid token (no regression)", async () => {
    const staticToken = "static-test-token-12345";
    const app = await buildMcpAuthApp({ staticToken });
    const { server, port } = await listenOnEphemeralPort(app);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": APPLICATION_JSON,
          Authorization: `Bearer ${staticToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1 }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      // Static path does NOT inject agentId (caller controls _meta)
      expect(body.agentId).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("OAuth-issued token authenticates and agentId is set correctly", async () => {
    const port = await findFreePort();
    const endpointUrl = `http://127.0.0.1:${port}/mcp`;
    const provider = buildMockProvider({
      valid: true,
      principal: { sub: VALID_SUB, clientId: "c1", agentId: VALID_AGENT_ID },
      scopes: ["mcp"],
      audience: endpointUrl,
    });
    const app = await buildMcpAuthApp({
      staticToken: "static-token",
      provider,
      endpointUrl,
    });
    const server = await listenOnKnownPort(app, port);
    try {
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": APPLICATION_JSON,
          Authorization: "Bearer oauth-issued-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1 }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      // agentId in ADR-006 Decision B format
      expect(body.agentId).toBe(VALID_AGENT_ID);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("expired OAuth token returns 401", async () => {
    const provider = buildMockProvider({ valid: false, reason: "expired" });
    const app = await buildMcpAuthApp({ staticToken: "static-token", provider });
    const { server, port } = await listenOnEphemeralPort(app);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": APPLICATION_JSON,
          Authorization: "Bearer expired-token",
        },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("unauthorized");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("revoked OAuth token returns 401", async () => {
    const provider = buildMockProvider({ valid: false, reason: "revoked" });
    const app = await buildMcpAuthApp({ staticToken: "static-token", provider });
    const { server, port } = await listenOnEphemeralPort(app);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": APPLICATION_JSON,
          Authorization: "Bearer revoked-token",
        },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("unauthorized");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("wrong-audience OAuth token returns 401 with invalid_token", async () => {
    const port = await findFreePort();
    const endpointUrl = `http://127.0.0.1:${port}/mcp`;
    const provider = buildMockProvider({
      valid: true,
      principal: { sub: VALID_SUB, clientId: "c1", agentId: VALID_AGENT_ID },
      scopes: ["mcp"],
      audience: "https://other-server.com/mcp",
    });
    const app = await buildMcpAuthApp({
      staticToken: "static-token",
      provider,
      endpointUrl,
    });
    const server = await listenOnKnownPort(app, port);
    try {
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": APPLICATION_JSON,
          Authorization: "Bearer audience-bound-token",
        },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe(ERR_INVALID_TOKEN);
      expect(body.error_description).toBe("audience mismatch");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("malformed bearer header returns 401", async () => {
    const provider = buildMockProvider({ valid: false, reason: "not_found" });
    const app = await buildMcpAuthApp({ staticToken: "static-token", provider });
    const { server, port } = await listenOnEphemeralPort(app);
    try {
      // Send a non-Bearer Authorization header
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": APPLICATION_JSON,
          Authorization: "Basic dXNlcjpwYXNz",
        },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("unauthorized");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // mt#1666 R1 BLOCKING #1 regression coverage: OAuth-only mode (no static token).
  // Pre-fix, the auth middleware gated entirely on `auth.enabled` (static-bearer
  // configured), leaving /mcp unauthenticated when ONLY OAuth was configured.
  // This test enforces that OAuth tokens are honored at the gate even when no
  // static token is set, AND that missing/invalid bearers return 401.
  test("OAuth-only mode (no staticToken): valid OAuth token authenticates and injects agentId", async () => {
    const sub = "oauth-only-user";
    const port = await findFreePort();
    const endpointUrl = `http://127.0.0.1:${port}/mcp`;
    const provider = buildMockProvider({
      valid: true,
      principal: { sub, clientId: "c", agentId: `oauth:claude-ai:user-${sub}` },
      scopes: ["mcp"],
      audience: endpointUrl,
    });
    const app = await buildMcpAuthApp({ provider, endpointUrl }); // NB: no staticToken
    const server = await listenOnKnownPort(app, port);
    try {
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: { "Content-Type": APPLICATION_JSON, Authorization: "Bearer oauth-jwt-token" },
        body: JSON.stringify({ method: "tools/list" }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.agentId).toBe(`oauth:claude-ai:user-${sub}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("OAuth-only mode (no staticToken): missing bearer header returns 401 (NOT pass-through)", async () => {
    const provider = buildMockProvider({ valid: false, reason: "not_found" });
    const app = await buildMcpAuthApp({ provider }); // NB: no staticToken
    const { server, port } = await listenOnEphemeralPort(app);
    try {
      // No Authorization header at all — must be rejected, NOT passed through.
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": APPLICATION_JSON },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("unauthorized");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ---- mt#2493: WWW-Authenticate header on the OAuth 401 (RFC 9728 §5.1) ----

  const FORWARDED_HOST = "minsky-mcp-production.up.railway.app";

  test("401 (missing bearer) carries WWW-Authenticate with the https resource_metadata URL (mt#2493)", async () => {
    const provider = buildMockProvider({ valid: false, reason: "not_found" });
    const app = await buildMcpAuthApp({ provider });
    const { server, port } = await listenOnEphemeralPort(app);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": APPLICATION_JSON,
          // Simulate the TLS-terminating edge so the advertised metadata URL is https.
          [HDR_X_FORWARDED_PROTO]: "https",
          [HDR_X_FORWARDED_HOST]: FORWARDED_HOST,
        },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
      const wwwAuth = response.headers.get("www-authenticate");
      expect(wwwAuth).toMatch(
        /^Bearer .*resource_metadata="https:\/\/minsky-mcp-production\.up\.railway\.app\/\.well-known\/oauth-protected-resource"/
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("401 (invalid token) carries WWW-Authenticate with the RFC 6750 error + resource_metadata (mt#2493)", async () => {
    const provider = buildMockProvider({ valid: false, reason: "expired" });
    const app = await buildMcpAuthApp({ provider });
    const { server, port } = await listenOnEphemeralPort(app);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": APPLICATION_JSON,
          Authorization: "Bearer some-expired-token",
          [HDR_X_FORWARDED_PROTO]: "https",
          [HDR_X_FORWARDED_HOST]: FORWARDED_HOST,
        },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
      const wwwAuth = response.headers.get("www-authenticate") ?? "";
      expect(wwwAuth).toMatch(/^Bearer /);
      expect(wwwAuth).toContain('error="unauthorized"');
      expect(wwwAuth).toMatch(
        /resource_metadata="https:\/\/minsky-mcp-production\.up\.railway\.app\/\.well-known\/oauth-protected-resource"/
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("composeWwwAuthenticate builds the RFC 9728 challenge from the request (mt#2493)", () => {
    const req = {
      protocol: "https",
      hostname: FORWARDED_HOST,
    } as unknown as import("express").Request;

    // Bare discovery hint (no token error).
    expect(composeWwwAuthenticate(req)).toBe(
      'Bearer resource_metadata="https://minsky-mcp-production.up.railway.app/.well-known/oauth-protected-resource"'
    );

    // With RFC 6750 error params (invalid/expired/revoked token case).
    expect(
      composeWwwAuthenticate(req, {
        error: "invalid_token",
        errorDescription: AUDIENCE_MISMATCH_DESC,
      })
    ).toBe(
      'Bearer error="invalid_token", error_description="audience mismatch", ' +
        'resource_metadata="https://minsky-mcp-production.up.railway.app/.well-known/oauth-protected-resource"'
    );
  });

  test("composeWwwAuthenticate escapes quotes/backslashes in quoted-string values (mt#2493)", () => {
    const req = {
      protocol: "https",
      hostname: FORWARDED_HOST,
    } as unknown as import("express").Request;

    // A description carrying a raw double-quote and a backslash must be escaped
    // per RFC 7230 quoted-string rules so it stays one well-formed parameter and
    // cannot inject a sibling auth-param.
    const header = composeWwwAuthenticate(req, {
      error: "invalid_token",
      errorDescription: 'a " quote and a \\ slash',
    });

    expect(header).toContain('error_description="a \\" quote and a \\\\ slash"');
    // resource_metadata still follows as its own well-formed parameter.
    expect(header).toContain(
      'resource_metadata="https://minsky-mcp-production.up.railway.app/.well-known/oauth-protected-resource"'
    );
  });
});

describe("OAuth _meta injection — JSONRPCMessageSchema compatibility (mt#1765)", () => {
  // Regression test for mt#1765: the OAuth-bearer middleware in start-command.ts
  // mutates req.body to add the agentId for Layer 2 to read. The SDK's
  // StreamableHTTPServerTransport pipes req.body through JSONRPCMessageSchema.parse,
  // which is .strict() at the JSON-RPC envelope level. A top-level _meta key fails
  // parse and the SDK returns -32700 "Parse error: Invalid JSON-RPC message" — the
  // class of failure that blocked claude.ai web from connecting after OAuth.
  //
  // These tests exercise the REAL `injectAgentIdMeta` helper (imported above), not a
  // hand-mirrored copy. Drift between production code and test mock is structurally
  // impossible (PR #1064 R1 NON-BLOCKING #1).

  const MT1765_TEST_AGENT_ID = "oauth:claude-ai:user-operator";

  test("post-injection body passes JSONRPCMessageSchema.parse (initialize request)", () => {
    // A realistic MCP initialize request (the exact shape claude.ai sends).
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "claude-ai", version: "1.0" },
      },
    };

    const injected = injectAgentIdMeta(initialize, MT1765_TEST_AGENT_ID);

    // The post-injection body must pass the SDK's strict schema.
    expect(JSONRPCMessageSchema.safeParse(injected).success).toBe(true);

    // And the agentId must land in params._meta where the SDK surfaces it to handlers.
    const params = (injected as Record<string, unknown>).params as Record<string, unknown>;
    const meta = params._meta as Record<string, unknown>;
    expect(meta[AGENT_ID_META_KEY]).toBe(MT1765_TEST_AGENT_ID);
  });

  test("post-injection body passes JSONRPCMessageSchema.parse (tools/list request)", () => {
    // tools/list with no caller params is a common shape post-handshake.
    const toolsList = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const injected = injectAgentIdMeta(toolsList, MT1765_TEST_AGENT_ID);
    expect(JSONRPCMessageSchema.safeParse(injected).success).toBe(true);
  });

  test("control: TOP-LEVEL _meta injection (the pre-mt#1765 bug shape) FAILS schema parse", () => {
    // The pre-mt#1765 shape: agentId at top level of the JSON-RPC envelope.
    // This is what the prior middleware produced and what -32700-blocked claude.ai.
    const buggyShape = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "x", version: "1" },
      },
      _meta: { [AGENT_ID_META_KEY]: MT1765_TEST_AGENT_ID },
    };

    // Documents the failure: JSONRPCRequestSchema is .strict() and rejects top-level extras.
    expect(JSONRPCMessageSchema.safeParse(buggyShape).success).toBe(false);
  });

  test("caller-declared params._meta wins over OAuth-derived (cooperative Layer 2)", () => {
    const callerDeclared = "subagent:claude-code:caller";
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "echo",
        _meta: { [AGENT_ID_META_KEY]: callerDeclared },
      },
    };
    const result = injectAgentIdMeta(msg, MT1765_TEST_AGENT_ID);
    const meta = (result.params as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(meta[AGENT_ID_META_KEY]).toBe(callerDeclared);
  });

  test("array params (positional) is NOT clobbered — message returned unchanged (PR #1064 R1 BLOCKING)", () => {
    // JSON-RPC 2.0 permits positional parameters via an array `params`. The pre-fix
    // injectMeta replaced it with an object, corrupting the payload. The fix
    // short-circuits and returns the message unchanged when `params` is an array.
    const positional = {
      jsonrpc: "2.0",
      id: 1,
      method: "some_method",
      params: ["arg1", 42, { nested: true }],
    };
    const result = injectAgentIdMeta(positional, MT1765_TEST_AGENT_ID);

    // Same object identity OR deep-equal preserved.
    expect(result.params).toEqual(positional.params);
    expect(Array.isArray(result.params)).toBe(true);

    // No top-level _meta was added either (we did not mutate the envelope at all).
    expect((result as Record<string, unknown>)._meta).toBeUndefined();
  });

  test("batch request: each item gets params._meta injection and the batch as a whole passes schema", () => {
    // Mirrors the production middleware's batch path: each message in the array is
    // independently injected. Mix two valid object-params messages so each one's
    // post-injection envelope is schema-clean.
    const batch = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "x", version: "1" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    const injected = batch.map((m) => injectAgentIdMeta(m, MT1765_TEST_AGENT_ID));

    for (const m of injected) {
      expect(JSONRPCMessageSchema.safeParse(m).success).toBe(true);
      const meta = ((m as Record<string, unknown>).params as Record<string, unknown>)
        ._meta as Record<string, unknown>;
      expect(meta[AGENT_ID_META_KEY]).toBe(MT1765_TEST_AGENT_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// SubagentDispatchTracker singleton wiring retry (mt#3044)
//
// buildSubagentDispatchTracker() previously ran EXACTLY ONCE, fire-and-forget,
// at MCP server startup. A failed/incomplete first attempt (e.g. a transient
// Postgres hiccup right after a restart) permanently latched
// debug_systemInfo.subagentDispatches to the zero-filled no-op tracker for
// the rest of the process's life. These tests exercise the promise-memoized,
// bounded-timeout retry wrapper (`wireSubagentDispatchTrackerWithRetry`) and
// its `getInstance()`-triggered retry driver (registered via
// `SubagentDispatchTracker.registerWireAttempt`).
//
// @see mt#3017 — reference implementation this mirrors (registry-setup.ts's getTracker)
// @see mt#3044 — this task
// ---------------------------------------------------------------------------

/**
 * PersistenceProvider fake whose `getDatabaseConnection()` behavior is
 * scripted per call — call N uses `behaviors[min(N, behaviors.length - 1)]`,
 * so a single-element array repeats forever and a multi-element array lets a
 * test script "first call fails, second call succeeds" (or "first call hangs
 * forever, second call succeeds").
 */
class ScriptedPersistenceProvider extends PersistenceProvider {
  readonly capabilities: PersistenceCapabilities = {
    sql: true,
    vectorStorage: false,
    transactions: true,
    jsonb: true,
    migrations: true,
  };
  private callCount = 0;

  constructor(private readonly behaviors: Array<() => Promise<unknown>>) {
    super();
  }

  getCapabilities(): PersistenceCapabilities {
    return this.capabilities;
  }
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  getConnectionInfo(): string {
    return "mt#3044-scripted-provider";
  }

  /** Number of times `getDatabaseConnection()` has been called so far. */
  get calls(): number {
    return this.callCount;
  }

  async getDatabaseConnection(): Promise<unknown> {
    const index = Math.min(this.callCount, this.behaviors.length - 1);
    const behavior = this.behaviors[index];
    this.callCount++;
    if (!behavior) {
      throw new Error("ScriptedPersistenceProvider: no behavior configured for this call");
    }
    return behavior();
  }
}

/**
 * Poll `SubagentDispatchTracker.isWired()` until it reports `true` (or
 * `timeoutMs` elapses) instead of a fixed-duration sleep. Used to wait for a
 * `getInstance()`-triggered background retry to settle deterministically
 * rather than hoping a fixed sleep was long enough — a fixed sleep risks
 * flakiness on a contended CI runner or slower environment (mt#3044 R1
 * NON-BLOCKING).
 */
async function waitForWired(timeoutMs = 1000, intervalMs = 5): Promise<void> {
  // performance.now() (monotonic) rather than Date.now() (wall-clock) --
  // also avoids custom/no-real-fs-in-tests' timestamp-uniqueness heuristic,
  // which flags `Date.now()` inside a BinaryExpression (a false positive
  // here — this is a deadline computation, not path/id uniqueness).
  const deadline = performance.now() + timeoutMs;
  while (!SubagentDispatchTracker.isWired() && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Minimal AppContainerInterface fake binding only "persistence". */
function makeContainer(
  persistence: PersistenceProvider
): Pick<AppContainerInterface, "has" | "get"> {
  return {
    has: (key: string) => key === "persistence",
    get: ((key: string) =>
      key === "persistence" ? persistence : undefined) as AppContainerInterface["get"],
  };
}

describe("SubagentDispatchTracker singleton wiring retry (mt#3044)", () => {
  afterEach(() => {
    // Isolate tests from each other: back to the pristine "never attempted"
    // boot state, and clear any registered retry callback.
    SubagentDispatchTracker.resetUnwiredForTest();
  });

  test("buildSubagentDispatchTracker: a single failed getDatabaseConnection() attempt leaves the singleton unwired", async () => {
    SubagentDispatchTracker.resetUnwiredForTest();
    const persistence = new ScriptedPersistenceProvider([
      async () => {
        throw new Error("transient connection hiccup");
      },
    ]);
    const container = makeContainer(persistence) as AppContainerInterface;

    const wired = await buildSubagentDispatchTracker(container);

    expect(wired).toBe(false);
    expect(SubagentDispatchTracker.isWired()).toBe(false);
  });

  test("mt#3044 SC#3 regression: a first failed attempt followed by a getInstance()-triggered retry results in the singleton being wired once the DB recovers", async () => {
    SubagentDispatchTracker.resetUnwiredForTest();

    const persistence = new ScriptedPersistenceProvider([
      async () => {
        throw new Error("transient connection hiccup");
      },
      async () => ({}) as unknown, // "healthy" connection on the second attempt
    ]);
    const container = makeContainer(persistence) as AppContainerInterface;

    // Eager startup attempt fails -- mirrors the real call site's first,
    // fire-and-forget invocation of wireSubagentDispatchTrackerWithRetry.
    const first = await wireSubagentDispatchTrackerWithRetry(container);
    expect(first).toBe(false);
    expect(SubagentDispatchTracker.isWired()).toBe(false);
    // getInstance() must still degrade gracefully while unwired -- it never
    // throws or returns null/undefined, only the no-op tracker.
    expect(SubagentDispatchTracker.getInstance()).toBeInstanceOf(SubagentDispatchTracker);

    // Register the retry callback exactly as the real start-command.ts call
    // site does, then call getInstance() -- the SAME entry point
    // debug.systemInfo and session.generate_prompt use. This getInstance()
    // call is the ONLY thing that triggers the second attempt below; nothing
    // else calls wireSubagentDispatchTrackerWithRetry a second time.
    SubagentDispatchTracker.registerWireAttempt(() =>
      wireSubagentDispatchTrackerWithRetry(container)
    );
    SubagentDispatchTracker.getInstance();

    // Wait for the background retry (fire-and-forget from getInstance()) to
    // settle -- polls isWired() rather than sleeping a fixed duration.
    await waitForWired();

    expect(persistence.calls).toBe(2);
    expect(SubagentDispatchTracker.isWired()).toBe(true);
  });

  test("wireSubagentDispatchTrackerWithRetry: concurrent callers during an in-flight attempt share the SAME promise (no duplicate DB-connection attempts)", async () => {
    SubagentDispatchTracker.resetUnwiredForTest();

    // No artificial delay needed: wireSubagentDispatchTrackerWithRetry's
    // dedup check ("if in-flight, return the existing promise") happens
    // SYNCHRONOUSLY on the second call, before either attempt's async work
    // has a chance to resolve -- correctness here doesn't depend on how
    // fast/slow getDatabaseConnection() resolves (mt#3044 R1 NON-BLOCKING:
    // removes the timing dependency entirely rather than tuning a sleep).
    const persistence = new ScriptedPersistenceProvider([async () => ({}) as unknown]);
    const container = makeContainer(persistence) as AppContainerInterface;

    const first = wireSubagentDispatchTrackerWithRetry(container);
    const second = wireSubagentDispatchTrackerWithRetry(container);
    expect(first).toBe(second);

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(true);
    expect(secondResult).toBe(true);
    expect(persistence.calls).toBe(1);
  });

  test("wireSubagentDispatchTrackerWithRetry: a hung getDatabaseConnection() resolves to false within the bound and frees the memo for the NEXT attempt", async () => {
    SubagentDispatchTracker.resetUnwiredForTest();

    const persistence = new ScriptedPersistenceProvider([
      () => new Promise(() => {}), // never resolves — simulates a hung connection attempt
      async () => ({}) as unknown, // healthy on the next attempt
    ]);
    const container = makeContainer(persistence) as AppContainerInterface;

    const hungResult = await wireSubagentDispatchTrackerWithRetry(container, 20);
    expect(hungResult).toBe(false);
    expect(SubagentDispatchTracker.isWired()).toBe(false);

    // The memo is freed even though the hung attempt is still silently
    // running in the background — the NEXT call starts a fresh attempt
    // instead of rejoining the permanently-stuck promise.
    const retryResult = await wireSubagentDispatchTrackerWithRetry(container, 20);
    expect(retryResult).toBe(true);
    expect(SubagentDispatchTracker.isWired()).toBe(true);
  });

  test("mt#3044 R1 BLOCKING #1 regression: a late-resolving timed-out attempt does not clobber a newer already-wired singleton", async () => {
    SubagentDispatchTracker.resetUnwiredForTest();

    // A "stale" attempt whose underlying getDatabaseConnection() call we
    // control manually, so we can resolve it AFTER a newer attempt has
    // already wired the singleton -- reproducing the exact race the
    // reviewer flagged: wireSubagentDispatchTrackerWithRetry's timeout
    // bound doesn't cancel the underlying buildSubagentDispatchTracker
    // call, so it keeps running in the background and could, without the
    // guard, call setInstance a second time once it finally resolves.
    let resolveStale: ((value: unknown) => void) | undefined;
    const stalePersistence = new ScriptedPersistenceProvider([
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    ]);
    const staleContainer = makeContainer(stalePersistence) as AppContainerInterface;

    const timedOut = await wireSubagentDispatchTrackerWithRetry(staleContainer, 20);
    expect(timedOut).toBe(false);
    expect(SubagentDispatchTracker.isWired()).toBe(false);

    // A second, independent (newer) attempt succeeds and wires the
    // singleton -- simulating a subsequent retry winning the race while the
    // stale attempt above is still silently pending.
    const freshPersistence = new ScriptedPersistenceProvider([async () => ({}) as unknown]);
    const freshContainer = makeContainer(freshPersistence) as AppContainerInterface;
    const freshResult = await wireSubagentDispatchTrackerWithRetry(freshContainer);
    expect(freshResult).toBe(true);
    expect(SubagentDispatchTracker.isWired()).toBe(true);

    const wiredAfterFreshAttempt = SubagentDispatchTracker.getInstance();

    // Now let the STALE attempt (from before the timeout) finally resolve.
    // Without the R1 BLOCKING #1 guard in buildSubagentDispatchTracker, this
    // would call setInstance again and silently replace the newer,
    // already-wired instance with a redundant one.
    resolveStale?.({} as unknown);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(SubagentDispatchTracker.isWired()).toBe(true);
    expect(SubagentDispatchTracker.getInstance()).toBe(wiredAfterFreshAttempt);
  });
});
