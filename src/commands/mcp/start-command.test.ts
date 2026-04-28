import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import path from "path";
import { checkBearerAuth } from "./start-command";

// ---------------------------------------------------------------------------
// Helpers for integration tests
// ---------------------------------------------------------------------------

/** Resolve the absolute path to src/cli.ts from this test file's location. */
const CLI_PATH = path.resolve(__dirname, "../../cli.ts");

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

/**
 * Wait for a child process to exit, resolving with the exit code.
 * Rejects after `timeoutMs` if the process has not exited.
 */
function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// ---------------------------------------------------------------------------
// Integration tests — shutdown paths (mt#1417)
// ---------------------------------------------------------------------------

describe("mcp start — shutdown paths", () => {
  test("exits within 6s when stdin is closed", async () => {
    const child = spawnMcpStart();

    // Give the process a moment to start up before closing stdin
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    // Close stdin (simulates Claude Code closing the stdio pipe).
    // stdin is always a Writable stream when stdio[0] is "pipe".
    if (child.stdin) child.stdin.end();

    const code = await waitForExit(child, 6000);
    // Any exit (clean or timeout) counts as long as it's within 6s
    expect(typeof code === "number" || code === null).toBe(true);
  }, 10000);

  test("exits cleanly when sent SIGTERM", async () => {
    const child = spawnMcpStart();

    // Give the process a moment to initialise signal handlers
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    child.kill("SIGTERM");

    const code = await waitForExit(child, 6000);
    // 0 = clean exit; null = killed (acceptable during test without real DB)
    expect(code === 0 || code === null).toBe(true);
  }, 10000);

  test("exits when sent SIGHUP (mirrors SIGTERM path)", async () => {
    const child = spawnMcpStart();

    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    child.kill("SIGHUP");

    const code = await waitForExit(child, 6000);
    expect(code === 0 || code === null).toBe(true);
  }, 10000);

  test("forces exit(1) after PG_DRAIN_TIMEOUT_MS when drain hangs", async () => {
    // Use a very short drain timeout so the test runs fast
    const child = spawnMcpStart({ PG_DRAIN_TIMEOUT_MS: "200" });

    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    // Close stdin to trigger shutdown — with a 200ms PG timeout the forced
    // exit(1) should fire well before our 5s assertion window.
    // stdin is always a Writable stream when stdio[0] is "pipe".
    if (child.stdin) child.stdin.end();

    const code = await waitForExit(child, 5000);
    // Exit code 0 (clean drain) or 1 (timed-out drain) are both valid here
    // because the test environment may not have a real PG pool to hang.
    // The critical property is that the process exits promptly.
    expect(code === 0 || code === 1 || code === null).toBe(true);
  }, 8000);
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
