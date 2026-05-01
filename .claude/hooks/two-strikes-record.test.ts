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
import { runHook, detectError, type HookFs, type HookDeps } from "./two-strikes-record";
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
// detectError
// ---------------------------------------------------------------------------

describe("detectError", () => {
  it("returns null for missing result", () => {
    expect(detectError(TOOL_BASH, undefined)).toBeNull();
  });

  it("Bash: non-zero exit_code returns the stderr", () => {
    expect(detectError(TOOL_BASH, { exit_code: 1, stderr: PERM_DENIED })).toBe(PERM_DENIED);
  });

  it("Bash: exit_code 0 returns null", () => {
    expect(detectError(TOOL_BASH, { exit_code: 0, stdout: "ok" })).toBeNull();
  });

  it("Bash: non-zero exit with empty stderr falls back to exit-code message", () => {
    expect(detectError(TOOL_BASH, { exit_code: 7 })).toBe("exit code 7");
  });

  it("generic is_error=true returns the error string", () => {
    expect(detectError(TOOL_EDIT, { is_error: true, error: "file not found" })).toBe(
      "file not found"
    );
  });

  it("generic is_error=true with no error/content falls back to placeholder", () => {
    expect(detectError(TOOL_EDIT, { is_error: true })).toBe("tool error");
  });

  it("generic error field returns the error", () => {
    expect(detectError(TOOL_EDIT, { error: "something broke" })).toBe("something broke");
  });

  it("returns null for clean results", () => {
    expect(detectError(TOOL_EDIT, { content: "hello" })).toBeNull();
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
