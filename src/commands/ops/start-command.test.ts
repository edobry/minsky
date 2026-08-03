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

import { describe, expect, test, mock } from "bun:test";
import { spawn } from "child_process";
import path from "path";
import { gzipSync } from "node:zlib";
import {
  parsePositiveIntEnv,
  adoptionSweeperTick,
  adoptionSweeperPositiveControlCanary,
  ADOPTION_SWEEPER_POSITIVE_CONTROL_SIGNAL_NAME,
  classifyCallsiteCheckUnavailable,
  classifyDryRunProposedFiling,
  type EmitEventFn,
  type CallsiteCheckResult,
} from "./start-command";
import {
  checkCallsitesInSnapshot,
  extractTypeScriptSources,
  fetchRepoSourceSnapshot,
  type RepoSourceSnapshot,
} from "./adoption-sweeper-callsite-check";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

/**
 * Test-local helper: build an `EmitEventFn` that records every call into
 * `events`, for asserting on emitted structured events without spying on
 * the shared logger (mt#3629).
 */
function collectingEmitEvent(
  events: Array<{ level: "info" | "error"; event: string; payload: Record<string, unknown> }>
): EmitEventFn {
  return (level, event, payload) => {
    events.push({ level, event, payload });
  };
}

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

/**
 * Shared log-event-name constant (used by both the mt#3328 and mt#3351
 * describe blocks below) — extracted to satisfy
 * `custom/no-magic-string-duplication`.
 */
const CALLSITE_CHECK_UNAVAILABLE_EVENT = "adoption_sweeper.callsite_check_unavailable";
const DRY_RUN_PROPOSED_FILING_EVENT = "adoption_sweeper.dry_run_proposed_filing";
const POSITIVE_CONTROL_SOURCE = "positive_control";

describe("adoptionSweeperTick", () => {
  test("local git-grep command failure hard-skips: distinct log event, no task creation, tick rejects", async () => {
    const createTaskSpy = mock(() => ({ id: "mt#unused", title: "unused", status: "TODO" }));
    const taskService = {
      // REPO_ROOT has a real `.git`, so the mt#3351 router selects the local
      // git-grep path (not the GitHub-API path) — this test exercises a git
      // grep INVOCATION failure (corrupted repo, git binary crash, timeout,
      // etc.), distinct from the "no .git at all" container scenario, which
      // is covered by the "container path (no local .git)" describe block
      // below.
      getWorkspacePath: () => REPO_ROOT,
      listTasks: mock(() => []),
      getTaskSpecContent: mock(() => ({ content: "" })),
      createTaskFromTitleAndSpec: createTaskSpy,
    };
    const container = makeFakeContainer(taskService);

    // Simulates a git-grep command failure on a real repo: every invocation
    // rejects with a non-1 exit code (the mt#3328 "check could not run"
    // outcome).
    const execAsyncFn = mock(() => {
      const notARepoError = "fatal: not a git repository (or any of the parent directories): .git";
      const err = Object.assign(new Error(notARepoError), {
        code: 128,
        stderr: notARepoError,
      });
      return Promise.reject(err);
    });

    const events: Array<{
      level: "info" | "error";
      event: string;
      payload: Record<string, unknown>;
    }> = [];
    const emitEvent = collectingEmitEvent(events);

    await expect(adoptionSweeperTick(container, { execAsyncFn, emitEvent })).rejects.toThrow(
      /callsite check unavailable/
    );

    // Distinct structured event fired for the positive-control failure (never
    // converted into a silent "zero callsites" outcome). Asserted via the
    // injected sink, not a logger spy (mt#3629).
    const unavailableCalls = events.filter((e) => e.event === CALLSITE_CHECK_UNAVAILABLE_EVENT);
    expect(unavailableCalls.length).toBeGreaterThan(0);
    expect(unavailableCalls[0]?.payload).toMatchObject({ source: POSITIVE_CONTROL_SOURCE });

    // Never files a task when the check could not run.
    expect(createTaskSpy.mock.calls.length).toBe(0);
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

    const events: Array<{
      level: "info" | "error";
      event: string;
      payload: Record<string, unknown>;
    }> = [];
    const emitEvent = collectingEmitEvent(events);

    // No execAsyncFn override: exercises the REAL git grep against the
    // real repo. The positive control (self-referential canary) succeeds
    // because its own function is committed to start-command.ts; the
    // invented signal name is guaranteed absent from the tree, exercising
    // the genuine zero-match path (not the unavailable path).
    // executeOverride: true selects the execute (not dry-run) branch
    // directly, without touching process.env (mt#3328 review R1).
    await adoptionSweeperTick(container, { executeOverride: true, emitEvent });

    const unavailableCalls = events.filter((e) => e.event === CALLSITE_CHECK_UNAVAILABLE_EVENT);
    expect(unavailableCalls.length).toBe(0);

    expect(createTaskSpy.mock.calls.length).toBe(1);
    expect(createTaskSpy.mock.calls[0]?.[0]).toBe(`mt#12345 adoption: ${signalName}`);
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

    const events: Array<{
      level: "info" | "error";
      event: string;
      payload: Record<string, unknown>;
    }> = [];
    const emitEvent = collectingEmitEvent(events);

    // No executeOverride: exercises the real default (dry-run) directly,
    // without touching process.env (mt#3328 review R1).
    await adoptionSweeperTick(container, { emitEvent });

    // Dry-run never calls createTaskFromTitleAndSpec.
    expect(createTaskSpy.mock.calls.length).toBe(0);

    const proposedCalls = events.filter((e) => e.event === DRY_RUN_PROPOSED_FILING_EVENT);
    expect(proposedCalls.length).toBe(1);
    expect(proposedCalls[0]?.payload).toMatchObject({
      parentTaskId: "mt#54321",
      signalName,
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Unit tests: mt#3351 — container-compatible callsite check (GitHub API)
// ---------------------------------------------------------------------------

// Built with plain `Uint8Array` rather than `Buffer.alloc`/`Buffer.concat`:
// `src/types/node.d.ts` (a legacy fallback ambient declaration scoped to the
// root tsconfig project this test file compiles under) only declares
// `Buffer.from(...)`, not the static `alloc`/`concat` helpers — a
// pre-existing gap, not something to "fix" as part of this task.
const textEncoder = new TextEncoder();

/** Write `text`'s ASCII/UTF-8 bytes into `target` at `offset`, truncating at `target`'s end. */
function writeField(target: Uint8Array, text: string, offset: number): void {
  const bytes = textEncoder.encode(text);
  target.set(bytes.subarray(0, Math.min(bytes.length, target.length - offset)), offset);
}

function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Build a minimal valid ustar tar entry (single 512-byte header + padded
 * content) for `path`/`content`. No `prefix` field usage — test paths here
 * are all well under the 100-byte `name` field limit.
 */
function buildTarEntry(entryPath: string, content: string): Uint8Array {
  const header = new Uint8Array(512); // zero-filled
  writeField(header, entryPath, 0);
  writeField(header, "0000644\0", 100); // mode
  writeField(header, "0000000\0", 108); // uid
  writeField(header, "0000000\0", 116); // gid
  const contentBytes = textEncoder.encode(content);
  const sizeOctal = `${contentBytes.length.toString(8).padStart(11, "0")}\0`;
  writeField(header, sizeOctal, 124); // size
  writeField(header, "00000000000\0", 136); // mtime
  header[156] = "0".charCodeAt(0); // typeflag: regular file
  writeField(header, "ustar\0", 257); // magic
  writeField(header, "00", 263); // version

  // chksum: sum of all header bytes with the chksum field itself treated as
  // ASCII spaces, then written back as 6 octal digits + NUL + space.
  writeField(header, "        ", 148);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i] ?? 0;
  writeField(header, `${checksum.toString(8).padStart(6, "0")}\0 `, 148);

  const paddingLength = (512 - (contentBytes.length % 512)) % 512;
  return concatUint8Arrays([header, contentBytes, new Uint8Array(paddingLength)]);
}

/** Build a `.tar.gz` buffer wrapping every entry under a `<topLevelDir>/` prefix, GitHub-tarball-style. */
function buildTestTarGz(
  topLevelDir: string,
  entries: Array<{ path: string; content: string }>
): Uint8Array {
  const blocks = entries.map((e) => buildTarEntry(`${topLevelDir}/${e.path}`, e.content));
  const eofMarker = new Uint8Array(1024); // two zero blocks
  return gzipSync(concatUint8Arrays([...blocks, eofMarker]));
}

describe("adoptionSweeperPositiveControlCanary / ADOPTION_SWEEPER_POSITIVE_CONTROL_SIGNAL_NAME", () => {
  test("the canary function's name and the exported signal-name constant stay in sync", () => {
    // The coupling between this function's literal identifier and the
    // string constant is inherently manual (mt#3351 review R1 BLOCKING) —
    // the whole point of the canary is that the constant's VALUE textually
    // matches a real, grep-able identifier. This test is the structural
    // drift detector: if either is ever renamed without the other, this
    // fails immediately instead of silently breaking the positive control.
    expect(adoptionSweeperPositiveControlCanary.name).toBe(
      ADOPTION_SWEEPER_POSITIVE_CONTROL_SIGNAL_NAME
    );
  });
});

/**
 * Shared fixture constants for the `checkCallsitesInSnapshot` /
 * `extractTypeScriptSources` / `fetchRepoSourceSnapshot` suites below —
 * extracted to satisfy `custom/no-magic-string-duplication`.
 */
const SAMPLE_TS_CONTENT = "export function foo() {}";
const NESTED_TS_PATH = "src/nested/bar.ts";
const FAKE_INSTALLATION_TOKEN = "fake-installation-token";

describe("checkCallsitesInSnapshot", () => {
  function snapshotOf(files: Record<string, string>): RepoSourceSnapshot {
    return { files: new Map(Object.entries(files)) };
  }

  test("found: returns the count of matching files", () => {
    const snapshot = snapshotOf({
      "src/a.ts": "export function myAdoptedThing() {}",
      "src/b.ts": "import { myAdoptedThing } from './a';\nmyAdoptedThing();",
      "src/c.ts": "export function unrelated() {}",
    });

    const result = checkCallsitesInSnapshot(snapshot, "myAdoptedThing");
    expect(result).toEqual({ status: "found", count: 2 });
  });

  test("zero: returns zero when no file matches", () => {
    const snapshot = snapshotOf({ "src/a.ts": "export function somethingElse() {}" });
    const result = checkCallsitesInSnapshot(snapshot, "definitelyNotPresentSymbol");
    expect(result).toEqual({ status: "zero" });
  });

  test("unavailable: an invalid regex pattern is reported as unavailable, not zero", () => {
    const snapshot = snapshotOf({ "src/a.ts": SAMPLE_TS_CONTENT });
    // Unterminated character class — `[` means the same thing in both BRE
    // and JS regex (untouched by the BRE-to-JS escape translation below),
    // so this stays a genuine parse failure in both dialects, unlike a lone
    // `(` or `+` (see the BRE-parity test below for why those are NOT
    // invalid-pattern cases post-mt#3351).
    const result = checkCallsitesInSnapshot(snapshot, "foo[bar");
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toMatch(/Invalid pattern/);
    }
  });

  test("BRE parity: a literal '+' in an adoption signal's callsite is found, not silently missed", () => {
    // mt#3351 review non-blocking finding: git's default BRE dialect treats
    // `+ ? | ( ) { }` as literal unless backslash-escaped; JS RegExp treats
    // them as metacharacters unless escaped — the opposite default. An
    // UNESCAPED `new RegExp("foo+bar")` means "fo" + one-or-more "o" +
    // "bar" — it does NOT expect any "+" character at all, so it would
    // FAIL to find a genuine literal "foo+bar" substring. That's the
    // DANGEROUS direction for this sweeper: a false "zero" would file a
    // bogus duplicate adoption task even though the signal IS already
    // adopted. Escaping `+` (this fix) finds the literal substring
    // correctly instead.
    const snapshot = snapshotOf({ "src/a.ts": "the callsite is foo+bar here" });
    const result = checkCallsitesInSnapshot(snapshot, "foo+bar");
    expect(result).toEqual({ status: "found", count: 1 });
  });
});

describe("extractTypeScriptSources", () => {
  test("extracts only src/**/*.ts entries and strips the top-level <owner>-<repo>-<sha>/ prefix", () => {
    const tarGz = buildTestTarGz("edobry-minsky-abc1234", [
      { path: "src/foo.ts", content: SAMPLE_TS_CONTENT },
      { path: NESTED_TS_PATH, content: "export function bar() {}" },
      { path: "docs/readme.md", content: "# not typescript" },
      { path: "src/notes.txt", content: "not a .ts file" },
    ]);

    const snapshot = extractTypeScriptSources(new Uint8Array(tarGz));

    expect(Array.from(snapshot.files.keys()).sort()).toEqual(["src/foo.ts", NESTED_TS_PATH]);
    expect(snapshot.files.get("src/foo.ts")).toBe(SAMPLE_TS_CONTENT);
    expect(snapshot.files.get(NESTED_TS_PATH)).toBe("export function bar() {}");
  });
});

describe("fetchRepoSourceSnapshot", () => {
  test("success: extracts a snapshot from a direct 200 response (no redirect)", async () => {
    const tarGz = buildTestTarGz("edobry-minsky-def5678", [
      { path: "src/foo.ts", content: SAMPLE_TS_CONTENT },
    ]);

    const fetchImpl = mock(
      async () =>
        new Response(new Uint8Array(tarGz), {
          status: 200,
          statusText: "OK",
        })
    );

    const result = await fetchRepoSourceSnapshot({
      acquireTokenFn: async () => FAKE_INSTALLATION_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.snapshot.files.get("src/foo.ts")).toBe(SAMPLE_TS_CONTENT);
    }
    expect(fetchImpl.mock.calls.length).toBe(1);
  });

  test("success: follows an explicit 302 redirect, re-attaching Authorization to the redirect target", async () => {
    // Regression coverage for mt#3351 review R1 BLOCKING: GitHub's tarball
    // endpoint redirects cross-origin (api.github.com -> codeload.github.com),
    // and `fetch`'s automatic redirect-follow strips Authorization on a
    // cross-origin hop. This asserts the manual-redirect + re-attach path
    // actually resends the header to whatever URL the Location points at.
    const tarGz = buildTestTarGz("edobry-minsky-abcdef1", [
      { path: "src/foo.ts", content: SAMPLE_TS_CONTENT },
    ]);
    const redirectTarget =
      "https://codeload.github.com/edobry/minsky/legacy.tar.gz/refs/heads/main";

    const fetchImpl = mock(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      if (input === redirectTarget) {
        expect(init?.headers).toMatchObject({
          Authorization: `Bearer ${FAKE_INSTALLATION_TOKEN}`,
        });
        return new Response(new Uint8Array(tarGz), { status: 200, statusText: "OK" });
      }
      return new Response(null, {
        status: 302,
        statusText: "Found",
        headers: { location: redirectTarget },
      });
    });

    const result = await fetchRepoSourceSnapshot({
      acquireTokenFn: async () => FAKE_INSTALLATION_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.snapshot.files.get("src/foo.ts")).toBe(SAMPLE_TS_CONTENT);
    }
    expect(fetchImpl.mock.calls.length).toBe(2);
  });

  test("unavailable: a redirect with no Location header is unavailable, never zero", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 302, statusText: "Found" }));

    const result = await fetchRepoSourceSnapshot({
      acquireTokenFn: async () => FAKE_INSTALLATION_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toMatch(/no Location header/);
    }
  });

  test("unavailable: a non-ok response (simulated rate limit) is unavailable, never zero", async () => {
    const fetchImpl = mock(
      async () =>
        new Response("rate limit exceeded", {
          status: 403,
          statusText: "Forbidden",
        })
    );

    const result = await fetchRepoSourceSnapshot({
      acquireTokenFn: async () => FAKE_INSTALLATION_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toMatch(/403/);
    }
  });

  test("unavailable: a thrown network error is unavailable, never zero", async () => {
    const fetchImpl = mock(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    });

    const result = await fetchRepoSourceSnapshot({
      acquireTokenFn: async () => FAKE_INSTALLATION_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toMatch(/ENOTFOUND/);
    }
  });

  test("unavailable: a token-acquisition failure is unavailable, never zero", async () => {
    const result = await fetchRepoSourceSnapshot({
      acquireTokenFn: async () => {
        throw new Error("GitHub App private key is not configured");
      },
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toMatch(/private key is not configured/);
    }
  });
});

// ---------------------------------------------------------------------------
// mt#3351 — adoptionSweeperTick routed through the container (no local .git) path
// ---------------------------------------------------------------------------

describe("adoptionSweeperTick — container path (mt#3351, no local .git)", () => {
  test("API-path unavailable (simulated 403 rate-limit) hard-skips: no task filed, tick rejects", async () => {
    const createTaskSpy = mock(() => ({ id: "mt#unused", title: "unused", status: "TODO" }));
    const taskService = {
      getWorkspacePath: () => REPO_ROOT,
      listTasks: mock(() => []),
      getTaskSpecContent: mock(() => ({ content: "" })),
      createTaskFromTitleAndSpec: createTaskSpy,
    };
    const container = makeFakeContainer(taskService);

    const events: Array<{
      level: "info" | "error";
      event: string;
      payload: Record<string, unknown>;
    }> = [];
    const emitEvent = collectingEmitEvent(events);

    await expect(
      adoptionSweeperTick(container, {
        hasLocalRepoOverride: false, // force the container (API) path
        fetchRepoSourceSnapshotFn: async () => ({
          status: "unavailable",
          reason: "GitHub tarball fetch failed: 403 Forbidden (rate limit exceeded)",
        }),
        emitEvent,
      })
    ).rejects.toThrow(/callsite check unavailable/);

    const unavailableCalls = events.filter((e) => e.event === CALLSITE_CHECK_UNAVAILABLE_EVENT);
    expect(unavailableCalls.length).toBeGreaterThan(0);
    expect(unavailableCalls[0]?.payload).toMatchObject({ source: POSITIVE_CONTROL_SOURCE });

    // Never files a task when the check could not run.
    expect(createTaskSpy.mock.calls.length).toBe(0);
  });

  test("API-path snapshot containing the canary + a zero-callsite signal completes normally (dry-run)", async () => {
    const runSuffix = Date.now();
    const signalName = `mt3351TestOnlyContainerPathCanarySymbol_${runSuffix}`;
    const specText = ["## Summary", "", `export function ${signalName}() {}`, ""].join("\n");

    const createTaskSpy = mock(() => ({ id: "mt#unused", title: "unused", status: "TODO" }));
    const taskService = {
      getWorkspacePath: () => REPO_ROOT,
      listTasks: mock((opts?: { status?: string }) =>
        opts && opts.status === "DONE"
          ? [{ id: "mt#67890", title: "Fake done task 3", status: "DONE" }]
          : []
      ),
      getTaskSpecContent: mock(() => ({ content: specText })),
      createTaskFromTitleAndSpec: createTaskSpy,
    };
    const container = makeFakeContainer(taskService);

    const events: Array<{
      level: "info" | "error";
      event: string;
      payload: Record<string, unknown>;
    }> = [];
    const emitEvent = collectingEmitEvent(events);

    // The snapshot's own source contains the positive-control canary's name
    // — via the EXPORTED `ADOPTION_SWEEPER_POSITIVE_CONTROL_SIGNAL_NAME`
    // constant, not a hardcoded literal (mt#3351 review R1 BLOCKING: a
    // hardcoded copy would silently go stale if the canary were renamed) —
    // so the positive control passes; the per-task signal is absent from
    // every file, so it resolves "zero".
    const fakeSnapshot: RepoSourceSnapshot = {
      files: new Map([
        ["src/canary.ts", `function ${ADOPTION_SWEEPER_POSITIVE_CONTROL_SIGNAL_NAME}() {}`],
        ["src/unrelated.ts", "export function totallyUnrelated() {}"],
      ]),
    };

    await adoptionSweeperTick(container, {
      hasLocalRepoOverride: false,
      fetchRepoSourceSnapshotFn: async () => ({ status: "ok", snapshot: fakeSnapshot }),
      emitEvent,
    });

    const unavailableCalls = events.filter((e) => e.event === CALLSITE_CHECK_UNAVAILABLE_EVENT);
    expect(unavailableCalls.length).toBe(0);

    const proposedCalls = events.filter((e) => e.event === DRY_RUN_PROPOSED_FILING_EVENT);
    expect(proposedCalls.length).toBe(1);
    expect(proposedCalls[0]?.payload).toMatchObject({
      parentTaskId: "mt#67890",
      signalName,
    });
  });
});

// ---------------------------------------------------------------------------
// Pure-core tests: structured-event payload classification (mt#3629)
// ---------------------------------------------------------------------------

describe("classifyCallsiteCheckUnavailable (pure core)", () => {
  test("positive_control source carries the mechanism-broken explanatory message", () => {
    const result: CallsiteCheckResult = { status: "unavailable", reason: "boom" };
    const event = classifyCallsiteCheckUnavailable(POSITIVE_CONTROL_SOURCE, result);
    expect(event).toMatchObject({
      event: CALLSITE_CHECK_UNAVAILABLE_EVENT,
      source: POSITIVE_CONTROL_SOURCE,
      result,
    });
    expect(event.message).toMatch(/Positive control failed/);
    expect(event.taskId).toBeUndefined();
  });

  test("per_task_signal source carries the context fields, no mechanism message", () => {
    const result: CallsiteCheckResult = { status: "unavailable", reason: "boom" };
    const event = classifyCallsiteCheckUnavailable("per_task_signal", result, {
      taskId: "mt#1",
      signalKind: "export",
      signalName: "foo",
    });
    expect(event).toEqual({
      event: CALLSITE_CHECK_UNAVAILABLE_EVENT,
      source: "per_task_signal",
      result,
      taskId: "mt#1",
      signalKind: "export",
      signalName: "foo",
    });
    expect(event.message).toBeUndefined();
  });
});

describe("classifyDryRunProposedFiling (pure core)", () => {
  test("builds the proposed-filing event payload", () => {
    const event = classifyDryRunProposedFiling(
      "mt#123",
      { kind: "export", name: "foo" },
      "mt#123 adoption: foo"
    );
    expect(event).toEqual({
      event: DRY_RUN_PROPOSED_FILING_EVENT,
      parentTaskId: "mt#123",
      signalKind: "export",
      signalName: "foo",
      proposedTitle: "mt#123 adoption: foo",
    });
  });
});
