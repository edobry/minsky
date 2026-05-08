import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import path from "path";
import {
  checkBearerAuth,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  composeRequestBaseUrl,
  normalizeEndpointPath,
  OAUTH_FLOW_NOT_SUPPORTED_BODY,
  OAUTH_REGISTER_NOT_SUPPORTED_BODY,
} from "./start-command";

// ---------------------------------------------------------------------------
// Helpers for integration tests
// ---------------------------------------------------------------------------

/** Resolve the absolute path to src/cli.ts from this test file's location. */
const CLI_PATH = path.resolve(__dirname, "../../cli.ts");

/** Log line printed by the cleanup path; tests assert it appears to prove the
 * shutdown handler ran (vs the kernel default action terminating the process). */
const SHUTDOWN_MARKER = "Stopping Minsky MCP Server";

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

describe("OAuth Discovery pure-function builders (mt#1655)", () => {
  // Pure-function shape pinning. The HTTP integration tests below cover the
  // route behavior end-to-end; these unit tests cover the builder contract
  // (frozen output, expected fields) without needing to spawn a server.

  test("buildAuthorizationServerMetadata returns RFC 8414 minimal shape", () => {
    const meta = buildAuthorizationServerMetadata("https://example.com");
    expect(meta.issuer).toBe("https://example.com");
    expect(meta.response_types_supported).toEqual([]);
    // mt#1657: SDK validators require these as strings even with no flows.
    expect(meta.authorization_endpoint).toBe("https://example.com/oauth/authorize");
    expect(meta.token_endpoint).toBe("https://example.com/oauth/token");
    expect(Object.isFrozen(meta)).toBe(true);
  });

  test("buildProtectedResourceMetadata returns RFC 9728 minimal shape", () => {
    const meta = buildProtectedResourceMetadata("https://example.com/mcp");
    expect(meta.resource).toBe("https://example.com/mcp");
    expect(Object.isFrozen(meta)).toBe(true);
  });

  test("OAUTH_REGISTER_NOT_SUPPORTED_BODY uses RFC 7591 error-key conventions", () => {
    expect(OAUTH_REGISTER_NOT_SUPPORTED_BODY.error).toBe("registration_not_supported");
    expect(typeof OAUTH_REGISTER_NOT_SUPPORTED_BODY.error_description).toBe("string");
    expect(Object.isFrozen(OAUTH_REGISTER_NOT_SUPPORTED_BODY)).toBe(true);
  });

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

describe("OAuth Discovery HTTP routes (mt#1655 integration)", () => {
  // These tests spawn the server in --http mode on a random port, wait for
  // the ready log, and fetch the .well-known endpoints. Pins the route
  // behavior change (404 -> 200) and the per-request URL composition that
  // R1 BLOCKING #1 flagged as untested.

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

  test("GET /.well-known/oauth-authorization-server returns 200 + RFC 8414 minimal metadata", async () => {
    const { child, ready } = spawnHttpMcp(PORT_AUTH_SERVER);
    try {
      await ready;
      const response = await fetch(
        `http://127.0.0.1:${PORT_AUTH_SERVER}/.well-known/oauth-authorization-server`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.issuer).toBeTypeOf("string");
      expect(body.response_types_supported).toEqual([]);
      // mt#1657: these are now present (SDK schema requires them as strings).
      expect(body.authorization_endpoint).toBeTypeOf("string");
      expect((body.authorization_endpoint as string).endsWith("/oauth/authorize")).toBe(true);
      expect(body.token_endpoint).toBeTypeOf("string");
      expect((body.token_endpoint as string).endsWith("/oauth/token")).toBe(true);
      // registration_endpoint stays absent — /register returns 400 directly.
      expect(body.registration_endpoint).toBeUndefined();
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10000).catch(() => {
        /* best-effort cleanup */
      });
    }
  }, 30000);

  test("GET /.well-known/oauth-protected-resource returns 200 + RFC 9728 minimal metadata", async () => {
    const { child, ready } = spawnHttpMcp(PORT_PROTECTED_RESOURCE);
    try {
      await ready;
      const response = await fetch(
        `http://127.0.0.1:${PORT_PROTECTED_RESOURCE}/.well-known/oauth-protected-resource`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.resource).toBeTypeOf("string");
      // The default endpoint is /mcp; resource should end with it.
      expect(body.resource).toMatch(/\/mcp$/);
      expect(body.authorization_servers).toBeUndefined();
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10000).catch(() => {
        /* best-effort cleanup */
      });
    }
  }, 30000);

  test("X-Forwarded-Proto: https produces an https issuer (trust proxy 1 wired correctly)", async () => {
    const { child, ready } = spawnHttpMcp(PORT_X_FORWARDED);
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
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.issuer).toBe("https://minsky-mcp-production.up.railway.app");
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10000).catch(() => {
        /* best-effort cleanup */
      });
    }
  }, 30000);

  test("POST /register continues to return 400 (regression check)", async () => {
    const { child, ready } = spawnHttpMcp(PORT_REGISTER);
    try {
      await ready;
      const response = await fetch(`http://127.0.0.1:${PORT_REGISTER}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("registration_not_supported");
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 10000).catch(() => {
        /* best-effort cleanup */
      });
    }
  }, 30000);

  // mt#1657: /oauth/authorize and /oauth/token stub handlers exist because
  // Claude Code's MCP SDK validates the authorization-server metadata
  // schema (requiring authorization_endpoint/token_endpoint as strings).
  // The handlers return 400 if any client actually attempts the flow.

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
        headers: { "Content-Type": "application/json" },
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
