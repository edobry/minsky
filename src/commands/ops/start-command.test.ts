/**
 * Tests for `minsky ops start`.
 *
 * Covers:
 * - Command registers correctly and is discoverable
 * - Health endpoint responds to GET /health with 200
 * - SIGTERM shuts down cleanly within 5s
 * - parsePositiveIntEnv utility function
 *
 * @see mt#2101 — implementation task
 */

import { describe, expect, test, spyOn, mock } from "bun:test";
import { spawn } from "child_process";
import path from "path";
import { parsePositiveIntEnv, adoptionSweeperTick } from "./start-command";
import { log } from "@minsky/shared/logger";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

// ---------------------------------------------------------------------------
// Unit tests: parsePositiveIntEnv
// ---------------------------------------------------------------------------

// Shared constant for the test env var name — avoids magic string duplication.
const TEST_INT_VAR = "__MINSKY_OPS_TEST_INT_VAR__";

/**
 * Helper: temporarily set an env var, run a callback, then restore.
 */
function withEnv(key: string, value: string, fn: () => void): void {
  const original = process.env[key];
  process.env[key] = value;
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

describe("parsePositiveIntEnv", () => {
  test("returns fallback when env var is absent", () => {
    const result = parsePositiveIntEnv("__NONEXISTENT_MINSKY_OPS_VAR__", 42);
    expect(result).toBe(42);
  });

  test("returns fallback when env var is empty string", () => {
    withEnv(TEST_INT_VAR, "", () => {
      const result = parsePositiveIntEnv(TEST_INT_VAR, 99);
      expect(result).toBe(99);
    });
  });

  test("parses a valid positive integer", () => {
    withEnv(TEST_INT_VAR, "1234", () => {
      const result = parsePositiveIntEnv(TEST_INT_VAR, 0);
      expect(result).toBe(1234);
    });
  });

  test("throws on a non-integer value", () => {
    withEnv(TEST_INT_VAR, "not-a-number", () => {
      expect(() => parsePositiveIntEnv(TEST_INT_VAR, 0)).toThrow();
    });
  });

  test("throws on zero", () => {
    withEnv(TEST_INT_VAR, "0", () => {
      expect(() => parsePositiveIntEnv(TEST_INT_VAR, 42)).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests: ops start command boot + health endpoint
// ---------------------------------------------------------------------------

const CLI_PATH = path.resolve(__dirname, "../../cli.ts");

/**
 * Spawn `bun <CLI_PATH> ops start` with a random port (0 = OS-assigned).
 */
function spawnOpsStart(env?: Record<string, string>) {
  return spawn("bun", [CLI_PATH, "ops", "start", "--port", "0"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

/** Result returned from waitForExit: exit code + accumulated output. */
interface ExitResult {
  code: number | null;
  output: string;
}

/**
 * Wait for a child process to exit, resolving with exit code + accumulated output.
 * Rejects after `timeoutMs` if the process has not exited.
 */
function waitForExit(proc: ReturnType<typeof spawn>, timeoutMs: number): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Process did not exit within ${timeoutMs}ms. Output: ${output}`));
    }, timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/**
 * Wait for a specific marker string to appear in the child's output.
 * Rejects after `timeoutMs` if the marker never appears.
 */
function waitForOutput(
  proc: ReturnType<typeof spawn>,
  marker: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Marker "${marker}" not seen within ${timeoutMs}ms. Output: ${output}`));
    }, timeoutMs);

    const handler = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve(output);
      }
    };

    proc.stdout?.on("data", handler);
    proc.stderr?.on("data", handler);
  });
}

describe("ops start command", () => {
  test("createOpsStartCommand returns a Command named 'start'", async () => {
    const { createOpsStartCommand } = await import("./start-command");
    const cmd = createOpsStartCommand();
    expect(cmd.name()).toBe("start");
    // Verify --port and --host options are registered.
    const optionNames = cmd.options.map((o) => o.long);
    expect(optionNames).toContain("--port");
    expect(optionNames).toContain("--host");
  });

  test("createOpsCommand returns a Command named 'ops' with 'start' subcommand", async () => {
    const { createOpsCommand } = await import("./index");
    const cmd = createOpsCommand();
    expect(cmd.name()).toBe("ops");
    const subNames = cmd.commands.map((c) => c.name());
    expect(subNames).toContain("start");
  });

  test("GET /health returns 200 with loop status", async () => {
    // Skip if no DB config — can't initialize the domain container
    if (!process.env["DATABASE_URL"] && !process.env["MINSKY_PERSISTENCE_POSTGRES_URL"]) {
      console.log("SKIP: no database URL configured, skipping integration test");
      return;
    }

    const proc = spawnOpsStart();

    // Wait for the server to log that it's listening.
    const output = await waitForOutput(proc, "ops_server.listening", 30_000);

    // Extract the port from the log output (Bun assigns a random port for port 0).
    // Log line example: "port":12345
    const portMatch = output.match(/"port"\s*:\s*(\d+)/);
    expect(portMatch).not.toBeNull();
    const portStr = portMatch?.[1] ?? "";
    expect(portStr).not.toBe("");
    const assignedPort = parseInt(portStr, 10);

    // Probe the health endpoint.
    const resp = await fetch(`http://127.0.0.1:${assignedPort}/health`);
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as {
      service: string;
      status: string;
      loops: Array<{ name: string; enabled: boolean }>;
    };
    expect(body.service).toBe("minsky-ops");
    expect(body.status).toBe("ok");
    expect(Array.isArray(body.loops)).toBe(true);

    // Verify adoption-sweeper loop is registered (disabled by default).
    const sweeper = body.loops.find((l) => l.name === "adoption-sweeper");
    expect(sweeper).toBeDefined();
    expect(sweeper?.enabled).toBe(false);

    // Send SIGTERM and verify clean shutdown within 5s.
    proc.kill("SIGTERM");
    const exitResult = await waitForExit(proc, 5_000);
    expect(exitResult.code).toBe(0);
  }, 35_000);

  test("SIGTERM shuts down cleanly within 5s", async () => {
    // Skip if no DB config
    if (!process.env["DATABASE_URL"] && !process.env["MINSKY_PERSISTENCE_POSTGRES_URL"]) {
      console.log("SKIP: no database URL configured, skipping integration test");
      return;
    }

    const proc = spawnOpsStart();

    // Wait for initialization log.
    await waitForOutput(proc, "ops_service.started", 30_000);

    // Send SIGTERM.
    proc.kill("SIGTERM");

    // Expect clean exit (code 0) within 5s.
    const result = await waitForExit(proc, 5_000);
    expect(result.code).toBe(0);
  }, 35_000);
});

// ---------------------------------------------------------------------------
// Unit tests: adoptionSweeperTick — callsite-check container-blindness fix
// (mt#3328)
// ---------------------------------------------------------------------------

/**
 * Build a minimal `AppContainerInterface` fake that resolves `"taskService"`
 * to the given fake object, regardless of key. `adoptionSweeperTick` only
 * ever calls `container.get("taskService")`, so this narrow fake avoids
 * having to stub every other `AppServices` key.
 */
function makeFakeContainer(taskService: Record<string, unknown>): AppContainerInterface {
  return {
    get: (() => taskService) as AppContainerInterface["get"],
  } as unknown as AppContainerInterface;
}

/** Repo root, resolved from this test file's location (src/commands/ops/). */
const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("adoptionSweeperTick", () => {
  test("grep failure (simulated missing repo) hard-skips: distinct log event, no task creation, tick rejects", async () => {
    const createTaskSpy = mock(() => ({ id: "mt#unused", title: "unused", status: "TODO" }));
    const taskService = {
      getWorkspacePath: () => "/nonexistent/repo/path/for/mt-3328-test",
      listTasks: mock(() => []),
      getTaskSpecContent: mock(() => ({ content: "" })),
      createTaskFromTitleAndSpec: createTaskSpy,
    };
    const container = makeFakeContainer(taskService);

    // Simulates the container-blindness scenario: git grep can never run
    // (no .git — e.g. the Railway image, per mt#3328) so every invocation
    // rejects with a non-1 exit code.
    const execAsyncFn = mock(() => {
      const notARepoError = "fatal: not a git repository (or any of the parent directories): .git";
      const err = Object.assign(new Error(notARepoError), {
        code: 128,
        stderr: notARepoError,
      });
      return Promise.reject(err);
    });

    const errorSpy = spyOn(log, "error");
    errorSpy.mockClear();

    try {
      await expect(adoptionSweeperTick(container, { execAsyncFn })).rejects.toThrow(
        /callsite check unavailable/
      );

      // Distinct structured log event fired for the positive-control failure
      // (never converted into a silent "zero callsites" outcome).
      const unavailableCalls = errorSpy.mock.calls.filter(
        (call) => call[0] === "adoption_sweeper.callsite_check_unavailable"
      );
      expect(unavailableCalls.length).toBeGreaterThan(0);
      expect(unavailableCalls[0]?.[1]).toMatchObject({ source: "positive_control" });

      // Never files a task when the check could not run.
      expect(createTaskSpy.mock.calls.length).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("zero-match grep on a real repo preserves the existing unadopted (file-a-task) path", async () => {
    // A per-run-unique name: the literal name itself must NOT appear
    // anywhere in the repo's committed/on-disk source (including this very
    // test file), or the real git grep below would find a false match.
    // Assigning Date.now() to a variable first (rather than interpolating it
    // directly in the template literal) means only the variable REFERENCE
    // appears in this file's source text, not the runtime-expanded digits.
    const runSuffix = Date.now();
    const signalName = `mt3328TestOnlyZeroMatchCanarySymbol_${runSuffix}`;
    const specText = ["## Summary", "", `export function ${signalName}() {}`, ""].join("\n");

    const createTaskSpy = mock((title: string, _spec: string, _options?: unknown) => ({
      id: "mt#99999",
      title,
      status: "TODO",
    }));

    const taskService = {
      getWorkspacePath: () => REPO_ROOT,
      listTasks: mock(
        (opts?: { status?: string }) =>
          opts && opts.status === "DONE"
            ? [{ id: "mt#12345", title: "Fake done task", status: "DONE" }]
            : [] // No existing adoption follow-up task.
      ),
      getTaskSpecContent: mock(() => ({ content: specText })),
      createTaskFromTitleAndSpec: createTaskSpy,
    };
    const container = makeFakeContainer(taskService);

    const errorSpy = spyOn(log, "error");
    errorSpy.mockClear();

    try {
      // No execAsyncFn override: exercises the REAL git grep against the
      // real repo. The positive control (self-referential canary) succeeds
      // because its own function is committed to start-command.ts; the
      // invented signal name is guaranteed absent from the tree, exercising
      // the genuine zero-match path (not the unavailable path).
      // executeOverride: true selects the execute (not dry-run) branch
      // directly, without touching process.env (mt#3328 review R1).
      await adoptionSweeperTick(container, { executeOverride: true });

      const unavailableCalls = errorSpy.mock.calls.filter(
        (call) => call[0] === "adoption_sweeper.callsite_check_unavailable"
      );
      expect(unavailableCalls.length).toBe(0);

      expect(createTaskSpy.mock.calls.length).toBe(1);
      expect(createTaskSpy.mock.calls[0]?.[0]).toBe(`mt#12345 adoption: ${signalName}`);
    } finally {
      errorSpy.mockRestore();
    }
  }, 30_000);

  test("dry-run mode (default) logs a proposed filing without creating a task", async () => {
    // See the sibling test above for why Date.now() is assigned to a
    // variable first rather than interpolated directly.
    const runSuffix = Date.now();
    const signalName = `mt3328TestOnlyDryRunCanarySymbol_${runSuffix}`;
    const specText = ["## Summary", "", `export function ${signalName}() {}`, ""].join("\n");

    const createTaskSpy = mock(() => ({ id: "mt#unused", title: "unused", status: "TODO" }));
    const taskService = {
      getWorkspacePath: () => REPO_ROOT,
      listTasks: mock((opts?: { status?: string }) =>
        opts && opts.status === "DONE"
          ? [{ id: "mt#54321", title: "Fake done task 2", status: "DONE" }]
          : []
      ),
      getTaskSpecContent: mock(() => ({ content: specText })),
      createTaskFromTitleAndSpec: createTaskSpy,
    };
    const container = makeFakeContainer(taskService);

    const infoSpy = spyOn(log, "info");
    infoSpy.mockClear();

    try {
      // No executeOverride: exercises the real default (dry-run) directly,
      // without touching process.env (mt#3328 review R1).
      await adoptionSweeperTick(container);

      // Dry-run never calls createTaskFromTitleAndSpec.
      expect(createTaskSpy.mock.calls.length).toBe(0);

      const proposedCalls = infoSpy.mock.calls.filter(
        (call) => call[0] === "adoption_sweeper.dry_run_proposed_filing"
      );
      expect(proposedCalls.length).toBe(1);
      expect(proposedCalls[0]?.[1]).toMatchObject({
        parentTaskId: "mt#54321",
        signalName,
      });
    } finally {
      infoSpy.mockRestore();
    }
  }, 30_000);
});
