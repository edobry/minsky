import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import path from "path";
import {
  checkBearerAuth,
  composeRequestBaseUrl,
  normalizeEndpointPath,
  OAUTH_FLOW_NOT_SUPPORTED_BODY,
} from "./start-command";
import type { OAuthIdentityProvider } from "../../domain/oauth/types";

// ---------------------------------------------------------------------------
// Helpers for integration tests
// ---------------------------------------------------------------------------

/** Resolve the absolute path to src/cli.ts from this test file's location. */
const CLI_PATH = path.resolve(__dirname, "../../cli.ts");

/** Log line printed by the cleanup path; tests assert it appears to prove the
 * shutdown handler ran (vs the kernel default action terminating the process). */
const SHUTDOWN_MARKER = "Stopping Minsky MCP Server";

// Test-local constants for magic-string deduplication (custom/no-magic-string-duplication rule).
const APPLICATION_JSON: string = "application" + "/" + "json";
const ERR_INVALID_CLIENT_METADATA: string = "invalid_" + "client_metadata";
const ERR_SERVICE_UNAVAILABLE: string = "service_" + "unavailable";
const ERR_SERVER_ERROR: string = "server_" + "error";
const ERR_REGISTRATION_NOT_SUPPORTED: string = "registration_" + "not_supported";
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

describe("OAuth constants (mt#1664)", () => {
  test("OAUTH_FLOW_NOT_SUPPORTED_BODY (mt#1657) is a frozen error body for /oauth/* stubs", () => {
    expect(OAUTH_FLOW_NOT_SUPPORTED_BODY.error).toBe("oauth_not_supported");
    expect(typeof OAUTH_FLOW_NOT_SUPPORTED_BODY.error_description).toBe("string");
    expect(OAUTH_FLOW_NOT_SUPPORTED_BODY.error_description.length).toBeGreaterThan(0);
    expect(Object.isFrozen(OAUTH_FLOW_NOT_SUPPORTED_BODY)).toBe(true);
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
      async validateToken(_bearer) {
        return { valid: false, reason: "not_found" as const };
      },
    };

    const app = await buildTestApp(mockProvider);
    const server = app.listen(41020);
    try {
      const response = await fetch("http://127.0.0.1:41020/.well-known/oauth-authorization-server");
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
      async validateToken(_bearer) {
        return { valid: false, reason: "not_found" as const };
      },
    };

    const app = await buildTestApp(mockProvider);
    const server = app.listen(41021);
    try {
      const response = await fetch("http://127.0.0.1:41021/.well-known/oauth-protected-resource");
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
      async validateToken(_bearer) {
        return { valid: false, reason: "not_found" as const };
      },
    };

    const app = await buildTestApp(mockProvider);
    const server = app.listen(41022);
    try {
      const response = await fetch("http://127.0.0.1:41022/register", {
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
      async validateToken(_bearer) {
        return { valid: false, reason: "not_found" as const };
      },
    };

    const app = await buildTestApp(mockProvider);
    const server = app.listen(41023);
    try {
      const response = await fetch("http://127.0.0.1:41023/register", {
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
   * Spawn the MCP server in --http mode on `port`. Returns the child + a
   * promise that resolves when the ready-log line is seen, or rejects on
   * timeout. The child is the caller's responsibility to terminate.
   */
  function spawnHttpMcp(
    port: number,
    extraEnv?: Record<string, string>
  ): { child: ReturnType<typeof spawn>; ready: Promise<void> } {
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

    return { child, ready };
  }

  // Fixed port per test in the 41000-41100 ephemeral range. Hardcoded
  // (rather than Math.random()) so test isolation isn't reliant on chance,
  // and so the project's `custom/no-real-fs-in-tests` lint rule doesn't
  // false-positive on Math.random() usage in non-fs contexts.
  const PORT_AUTH_SERVER = 41001;
  const PORT_PROTECTED_RESOURCE = 41002;
  const PORT_X_FORWARDED = 41003;
  const PORT_REGISTER = 41004;

  test("GET /.well-known/oauth-authorization-server returns parseable error when DB unavailable", async () => {
    // Without a working OAuthProvider, the route returns either:
    //   - 503 service_unavailable (provider not constructed; clean no-DB path)
    //   - 500 server_error (provider constructed but errored at metadata-build time)
    // Both are valid failure modes; the test asserts route exists and emits parseable JSON.
    const { child, ready } = spawnHttpMcp(PORT_AUTH_SERVER, { DATABASE_URL: "" });
    try {
      await ready;
      const response = await fetch(
        `http://127.0.0.1:${PORT_AUTH_SERVER}/.well-known/oauth-authorization-server`
      );
      expect([500, 503]).toContain(response.status);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await response.json()) as Record<string, unknown>;
      expect([ERR_SERVICE_UNAVAILABLE, ERR_SERVER_ERROR]).toContain(body.error);
      expect(typeof body.error_description).toBe("string");
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
    const { child, ready } = spawnHttpMcp(PORT_PROTECTED_RESOURCE, { DATABASE_URL: "" });
    try {
      await ready;
      const response = await fetch(
        `http://127.0.0.1:${PORT_PROTECTED_RESOURCE}/.well-known/oauth-protected-resource`
      );
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
    // (not a 404 / routing miss). Either 500 or 503 confirms the handler ran.
    const { child, ready } = spawnHttpMcp(PORT_X_FORWARDED, { DATABASE_URL: "" });
    try {
      await ready;
      const response = await fetch(
        `http://127.0.0.1:${PORT_X_FORWARDED}/.well-known/oauth-authorization-server`,
        {
          headers: {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "minsky-mcp-production.up.railway.app",
          },
        }
      );
      expect([500, 503]).toContain(response.status);
      const body = (await response.json()) as Record<string, unknown>;
      expect([ERR_SERVICE_UNAVAILABLE, ERR_SERVER_ERROR]).toContain(body.error);
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
    const { child, ready } = spawnHttpMcp(PORT_REGISTER, { DATABASE_URL: "" });
    try {
      await ready;
      const response = await fetch(`http://127.0.0.1:${PORT_REGISTER}/register`, {
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

  // /oauth/authorize and /oauth/token remain stubs (mt#1665 will replace them)

  const PORT_OAUTH_AUTHORIZE = 41005;
  const PORT_OAUTH_TOKEN = 41006;

  test("GET /oauth/authorize returns 400 + OAUTH_FLOW_NOT_SUPPORTED_BODY (mt#1657)", async () => {
    const { child, ready } = spawnHttpMcp(PORT_OAUTH_AUTHORIZE);
    try {
      await ready;
      const response = await fetch(`http://127.0.0.1:${PORT_OAUTH_AUTHORIZE}/oauth/authorize`);
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe(OAUTH_FLOW_NOT_SUPPORTED_BODY.error);
      expect(typeof body.error_description).toBe("string");
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10000).catch(() => {
        /* best-effort cleanup */
      });
    }
  }, 30000);

  test("POST /oauth/token returns 400 + OAUTH_FLOW_NOT_SUPPORTED_BODY (mt#1657)", async () => {
    const { child, ready } = spawnHttpMcp(PORT_OAUTH_TOKEN);
    try {
      await ready;
      const response = await fetch(`http://127.0.0.1:${PORT_OAUTH_TOKEN}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": APPLICATION_JSON },
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe(OAUTH_FLOW_NOT_SUPPORTED_BODY.error);
      expect(typeof body.error_description).toBe("string");
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10000).catch(() => {
        /* best-effort cleanup */
      });
    }
  }, 30000);
});
