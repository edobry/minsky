import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import path from "path";
import { checkBearerAuth } from "./start-command";

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
 * this immediately before registering its signal handlers (mt#1417), so it's
 * the deterministic readiness signal. Sending SIGTERM/SIGHUP before this line
 * appears would hit the default signal handler and exit with code=null,
 * masking real handler regressions.
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

    const { code, output } = await waitForExit(child, 3000);
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
    // Promptness: even with a hung drain the timeout caps the wait. Allow
    // generous slack for spawn-warmup overhead while still failing if the
    // process hung past the buffer window.
    expect(elapsedMs).toBeLessThan(2500);
  }, 10000);

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
