/**
 * Tests for the two-strikes PostToolUse hook (mt#1484).
 *
 * Drives `runHook` with synthetic ToolHookInput and an in-memory HookFs so
 * the test is hermetic — no real filesystem, no real env, no real stdin.
 *
 * Spec acceptance scenario:
 *   - Two identical tool errors → tracker fires; in observation mode,
 *     observation appears in the JSONL log.
 *   - error → success → same error → tracker does NOT fire.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import {
  runHook,
  detectOutcome,
  sanitizeSessionId,
  type HookFs,
  type HookDeps,
} from "./two-strikes-record";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// In-memory fs
// ---------------------------------------------------------------------------

class FakeFs implements HookFs {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();

  exists(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path);
  }

  mkdirP(path: string): void {
    this.dirs.add(path);
  }

  readText(path: string): string {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }

  writeText(path: string, contents: string): void {
    this.files.set(path, contents);
  }

  appendText(path: string, contents: string): void {
    const prev = this.files.get(path) ?? "";
    this.files.set(path, prev + contents);
  }

  // Test introspection.
  read(path: string): string | undefined {
    return this.files.get(path);
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const STATE_DIR = "/tmp/test-two-strikes";
const SESSION_ID = "test-session";
const STATE_FILE = `${STATE_DIR}/${SESSION_ID}.json`;
const OBS_FILE = `${STATE_DIR}/observations.jsonl`;
const TOOL_BASH = "Bash";
const TOOL_EDIT = "Edit";
const PERM_DENIED = "permission denied";

function buildInput(opts: {
  toolName: string;
  toolResult: Record<string, unknown> | undefined;
  sessionId?: string;
}): ToolHookInput {
  return {
    session_id: opts.sessionId ?? SESSION_ID,
    cwd: "/fake/cwd",
    hook_event_name: "PostToolUse",
    tool_name: opts.toolName,
    tool_input: {},
    tool_result: opts.toolResult,
  };
}

function buildDeps(fs: FakeFs, mode: "observation" | "live" = "observation"): HookDeps {
  return { stateDir: STATE_DIR, mode, fs };
}

// ---------------------------------------------------------------------------
// detectOutcome
// ---------------------------------------------------------------------------

describe("detectOutcome", () => {
  it("returns unknown for missing result (PR #926 R1 BLOCKING fix: no implicit success)", () => {
    expect(detectOutcome(TOOL_BASH, undefined)).toEqual({ kind: "unknown" });
  });

  it("Bash: non-zero exit_code returns error with the stderr", () => {
    expect(detectOutcome(TOOL_BASH, { exit_code: 1, stderr: PERM_DENIED })).toEqual({
      kind: "error",
      error: PERM_DENIED,
    });
  });

  it("Bash: exit_code 0 returns explicit success", () => {
    expect(detectOutcome(TOOL_BASH, { exit_code: 0, stdout: "ok" })).toEqual({ kind: "success" });
  });

  it("Bash: non-zero exit with empty stderr falls back to exit-code message", () => {
    expect(detectOutcome(TOOL_BASH, { exit_code: 7 })).toEqual({
      kind: "error",
      error: "exit code 7",
    });
  });

  it("Bash: missing exit_code returns unknown (no implicit success)", () => {
    expect(detectOutcome(TOOL_BASH, { stdout: "x" })).toEqual({ kind: "unknown" });
  });

  // Regression: PR #926 R4 BLOCKING. Lowercase "bash" should still be
  // recognised as the Bash branch — case-insensitive comparison.
  it("Bash: lowercase tool name still hits the Bash branch (case-insensitive)", () => {
    expect(detectOutcome("bash", { exit_code: 0 })).toEqual({ kind: "success" });
    expect(detectOutcome("BASH", { exit_code: 1, stderr: "x" })).toEqual({
      kind: "error",
      error: "x",
    });
  });

  it("generic is_error=true returns error", () => {
    expect(detectOutcome(TOOL_EDIT, { is_error: true, error: "file not found" })).toEqual({
      kind: "error",
      error: "file not found",
    });
  });

  it("generic is_error=true with no error/content falls back to placeholder", () => {
    expect(detectOutcome(TOOL_EDIT, { is_error: true })).toEqual({
      kind: "error",
      error: "tool error",
    });
  });

  it("generic is_error=false returns explicit success", () => {
    expect(detectOutcome(TOOL_EDIT, { is_error: false })).toEqual({ kind: "success" });
  });

  it("generic error field returns error", () => {
    expect(detectOutcome(TOOL_EDIT, { error: "something broke" })).toEqual({
      kind: "error",
      error: "something broke",
    });
  });

  it("returns unknown for results with no recognised signals", () => {
    expect(detectOutcome(TOOL_EDIT, { content: "hello" })).toEqual({ kind: "unknown" });
  });
});

// ---------------------------------------------------------------------------
// sanitizeSessionId
// ---------------------------------------------------------------------------

describe("sanitizeSessionId", () => {
  it("preserves alphanumeric, dash, and underscore", () => {
    expect(sanitizeSessionId("abc-123_xyz")).toBe("abc-123_xyz");
  });

  it("replaces forward slashes (directory traversal defence)", () => {
    expect(sanitizeSessionId("../etc/passwd")).toBe("___etc_passwd");
  });

  it("replaces backslashes and other path separators", () => {
    expect(sanitizeSessionId("a\\b/c")).toBe("a_b_c");
  });

  it("replaces dots (no traversal via .)", () => {
    expect(sanitizeSessionId("a.b.c")).toBe("a_b_c");
  });

  it("replaces special characters", () => {
    expect(sanitizeSessionId("uuid:1234@host")).toBe("uuid_1234_host");
  });
});

// ---------------------------------------------------------------------------
// runHook end-to-end
// ---------------------------------------------------------------------------

describe("runHook — observation mode", () => {
  let fs: FakeFs;

  beforeEach(() => {
    fs = new FakeFs();
  });

  // Acceptance scenario #1.
  it("two identical tool errors append a would-have-fired observation", () => {
    const deps = buildDeps(fs);

    runHook(
      buildInput({
        toolName: TOOL_BASH,
        toolResult: { exit_code: 1, stderr: PERM_DENIED },
      }),
      deps
    );
    runHook(
      buildInput({
        toolName: TOOL_BASH,
        toolResult: { exit_code: 1, stderr: PERM_DENIED },
      }),
      deps
    );

    const observationsContent = fs.read(OBS_FILE);
    expect(observationsContent).toBeDefined();
    if (!observationsContent) return;

    const lines = observationsContent.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const event = JSON.parse(lines[0] ?? "{}");
    expect(event.sessionId).toBe(SESSION_ID);
    expect(event.mode).toBe("observation");
    expect(event.toolName).toBe(TOOL_BASH);
    expect(event.normalizedMessage).toBe(PERM_DENIED);
  });

  // Acceptance scenario #2.
  it("error → success → same error does NOT fire", () => {
    const deps = buildDeps(fs);

    runHook(
      buildInput({ toolName: TOOL_BASH, toolResult: { exit_code: 1, stderr: "perm" } }),
      deps
    );
    runHook(buildInput({ toolName: TOOL_BASH, toolResult: { exit_code: 0, stdout: "ok" } }), deps);
    runHook(
      buildInput({ toolName: TOOL_BASH, toolResult: { exit_code: 1, stderr: "perm" } }),
      deps
    );

    const observationsContent = fs.read(OBS_FILE);
    // Either the file doesn't exist or it's empty — both are valid "no observation" states.
    if (observationsContent) {
      expect(observationsContent.trim()).toBe("");
    }
  });

  it("cross-tool errors don't accumulate", () => {
    const deps = buildDeps(fs);

    runHook(buildInput({ toolName: TOOL_BASH, toolResult: { exit_code: 1, stderr: "x" } }), deps);
    runHook(buildInput({ toolName: TOOL_EDIT, toolResult: { is_error: true, error: "x" } }), deps);

    expect(fs.read(OBS_FILE)).toBeUndefined();
  });

  it("persists tracker state across hook invocations", () => {
    const deps = buildDeps(fs);

    runHook(buildInput({ toolName: TOOL_BASH, toolResult: { exit_code: 1, stderr: "y" } }), deps);

    // After the first call, the state file holds an active streak.
    const stateContent = fs.read(STATE_FILE);
    expect(stateContent).toBeDefined();
    if (!stateContent) return;
    const snapshot = JSON.parse(stateContent);
    expect(snapshot.streaks).toHaveLength(1);
    expect(snapshot.streaks[0].toolName).toBe(TOOL_BASH);
  });

  it("missing tool_name is a no-op", () => {
    const deps = buildDeps(fs);
    runHook(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
      { tool_name: undefined, session_id: SESSION_ID } as any,
      deps
    );
    expect(fs.read(STATE_FILE)).toBeUndefined();
  });

  it("corrupt state file is recovered to a fresh tracker", () => {
    fs.writeText(STATE_FILE, "{ not valid json");
    const deps = buildDeps(fs);

    runHook(buildInput({ toolName: TOOL_BASH, toolResult: { exit_code: 1, stderr: "z" } }), deps);

    // No throw, and the corrupt file is replaced with a fresh snapshot.
    const stateContent = fs.read(STATE_FILE);
    expect(stateContent).toBeDefined();
    if (!stateContent) return;
    const snapshot = JSON.parse(stateContent);
    expect(snapshot.streaks).toHaveLength(1);
  });

  // Regression: PR #926 R1 BLOCKING.
  // Before the fix, an undefined tool_result was treated as success and
  // reset the streak — so error → undefined-event → same-error did NOT fire.
  // After the fix, undefined tool_result is "unknown" and the streak survives,
  // so the second error correctly fires 2-strikes.
  it("error → undefined-result event → same error STILL fires (R1 fix)", () => {
    const deps = buildDeps(fs);

    runHook(
      buildInput({ toolName: TOOL_BASH, toolResult: { exit_code: 1, stderr: PERM_DENIED } }),
      deps
    );

    // Intermediate hook invocation with no tool_result — must NOT reset.
    runHook(buildInput({ toolName: TOOL_BASH, toolResult: undefined }), deps);

    runHook(
      buildInput({ toolName: TOOL_BASH, toolResult: { exit_code: 1, stderr: PERM_DENIED } }),
      deps
    );

    const observationsContent = fs.read(OBS_FILE);
    expect(observationsContent).toBeDefined();
    if (!observationsContent) return;
    const lines = observationsContent.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  // Regression: PR #926 R4 BLOCKING.
  // Empty/whitespace session_id must fall back to "default" rather than
  // collapsing to a `.json` state file shared across all empty-id sessions.
  it("empty session_id falls back to 'default' (no .json collision)", () => {
    const deps = buildDeps(fs);
    runHook(
      buildInput({
        toolName: TOOL_BASH,
        toolResult: { exit_code: 1, stderr: "x" },
        sessionId: "",
      }),
      deps
    );

    // The sanitized "default" filename is used, not ".json".
    expect(fs.read(`${STATE_DIR}/default.json`)).toBeDefined();
    expect(fs.read(`${STATE_DIR}/.json`)).toBeUndefined();
  });

  it("whitespace-only session_id falls back to 'default'", () => {
    const deps = buildDeps(fs);
    runHook(
      buildInput({
        toolName: TOOL_BASH,
        toolResult: { exit_code: 1, stderr: "x" },
        sessionId: "   ",
      }),
      deps
    );

    expect(fs.read(`${STATE_DIR}/default.json`)).toBeDefined();
  });

  // Regression: PR #926 R1 BLOCKING.
  // Session ids with path separators must not blow up the state-file write
  // and must not allow directory traversal.
  it("session_id with path separators is sanitized to a safe filename", () => {
    const deps = buildDeps(fs);

    runHook(
      buildInput({
        toolName: TOOL_BASH,
        toolResult: { exit_code: 1, stderr: "x" },
        sessionId: "../etc/passwd",
      }),
      deps
    );

    // The original "../etc/passwd" path is NOT used.
    expect(fs.read(`${STATE_DIR}/../etc/passwd.json`)).toBeUndefined();
    // The sanitized form IS used.
    expect(fs.read(`${STATE_DIR}/___etc_passwd.json`)).toBeDefined();
  });
});

describe("runHook — live mode", () => {
  it("uses live mode in the persisted snapshot when configured", () => {
    const fs = new FakeFs();
    const deps = buildDeps(fs, "live");

    runHook(buildInput({ toolName: TOOL_BASH, toolResult: { exit_code: 1, stderr: "x" } }), deps);

    const stateContent = fs.read(STATE_FILE);
    expect(stateContent).toBeDefined();
    if (!stateContent) return;
    const snapshot = JSON.parse(stateContent);
    expect(snapshot.mode).toBe("live");
  });
});
