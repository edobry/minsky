import { describe, expect, it } from "bun:test";
import {
  isSubagentContext,
  isGhApiPutMerge,
  findGhApiPutMergeSegment,
} from "./block-subagent-bypass-merge";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// Helper: build a minimal ToolHookInput for testing
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<ToolHookInput> = {}): ToolHookInput {
  return {
    session_id: "test-session",
    cwd: "/some/repo",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isSubagentContext
// ---------------------------------------------------------------------------

describe("isSubagentContext", () => {
  it("returns true when agent_id is a non-empty string", () => {
    expect(isSubagentContext(makeInput({ agent_id: "abc-123" }))).toBe(true);
  });

  it("returns false when agent_id is undefined (main agent)", () => {
    expect(isSubagentContext(makeInput({ agent_id: undefined }))).toBe(false);
  });

  it("returns false when agent_id is empty string", () => {
    expect(isSubagentContext(makeInput({ agent_id: "" }))).toBe(false);
  });

  it("returns false when agent_id is not present in the input object", () => {
    const input = makeInput();
    // Remove the key entirely (not the same as undefined in some environments)
    delete (input as Partial<ToolHookInput>).agent_id;
    expect(isSubagentContext(input)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isGhApiPutMerge — literal invocations
// ---------------------------------------------------------------------------

describe("isGhApiPutMerge — literal invocations", () => {
  it("detects basic gh api -X PUT /repos/.../pulls/N/merge", () => {
    expect(isGhApiPutMerge("gh api -X PUT /repos/edobry/minsky/pulls/123/merge")).toBe(true);
  });

  it("detects --method PUT form", () => {
    expect(isGhApiPutMerge("gh api --method PUT /repos/edobry/minsky/pulls/123/merge")).toBe(true);
  });

  it("detects combined -XPUT form", () => {
    expect(isGhApiPutMerge("gh api -XPUT /repos/edobry/minsky/pulls/123/merge")).toBe(true);
  });

  it("detects --method=PUT form", () => {
    expect(isGhApiPutMerge("gh api --method=PUT /repos/edobry/minsky/pulls/123/merge")).toBe(true);
  });

  it("detects invocation with extra flags (-f merge_method=merge)", () => {
    expect(
      isGhApiPutMerge("gh api -X PUT /repos/edobry/minsky/pulls/123/merge -f merge_method=merge")
    ).toBe(true);
  });

  it("detects invocation with extra flags (-f commit_title=...)", () => {
    expect(
      isGhApiPutMerge(
        'gh api -X PUT /repos/owner/repo/pulls/456/merge -f merge_method=merge -f commit_title="My PR"'
      )
    ).toBe(true);
  });

  it("detects relative endpoint path (no leading slash)", () => {
    expect(isGhApiPutMerge("gh api -X PUT repos/edobry/minsky/pulls/123/merge")).toBe(true);
  });

  it("is case-insensitive for method (-X put)", () => {
    expect(isGhApiPutMerge("gh api -X put /repos/edobry/minsky/pulls/123/merge")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isGhApiPutMerge — false positives (should NOT block)
// ---------------------------------------------------------------------------

describe("isGhApiPutMerge — false positives", () => {
  it("does NOT match a GET request to the merge endpoint", () => {
    expect(isGhApiPutMerge("gh api /repos/edobry/minsky/pulls/123/merge")).toBe(false);
  });

  it("does NOT match gh api PATCH (e.g., branch update)", () => {
    expect(isGhApiPutMerge("gh api -X PATCH /repos/edobry/minsky/git/refs/heads/main")).toBe(false);
  });

  it("does NOT match gh pr list", () => {
    expect(isGhApiPutMerge("gh pr list")).toBe(false);
  });

  it("does NOT match gh api GET with pulls in path", () => {
    expect(isGhApiPutMerge("gh api /repos/edobry/minsky/pulls/123")).toBe(false);
  });

  it("does NOT match gh api PUT to /merges (wrong endpoint)", () => {
    expect(isGhApiPutMerge("gh api -X PUT /repos/edobry/minsky/merges")).toBe(false);
  });

  it("does NOT match gh api PUT to /merge-upstream (wrong endpoint)", () => {
    expect(isGhApiPutMerge("gh api -X PUT /repos/edobry/minsky/merge-upstream")).toBe(false);
  });

  it("does NOT match plain `git merge`", () => {
    expect(isGhApiPutMerge("git merge origin/main")).toBe(false);
  });

  it("does NOT match other REST API operations", () => {
    expect(isGhApiPutMerge("gh api -X PUT /repos/edobry/minsky/labels/enhancement")).toBe(false);
  });

  it("does NOT match gh api GET pulls list", () => {
    expect(isGhApiPutMerge("gh api -X GET /repos/edobry/minsky/pulls")).toBe(false);
  });

  it("does NOT match empty command", () => {
    expect(isGhApiPutMerge("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findGhApiPutMergeSegment — chained commands
// ---------------------------------------------------------------------------

describe("findGhApiPutMergeSegment — chained commands", () => {
  it("detects merge command in a chained &&  sequence", () => {
    const cmd =
      "git log --oneline -5 && gh api -X PUT /repos/edobry/minsky/pulls/123/merge -f merge_method=merge";
    expect(findGhApiPutMergeSegment(cmd)).not.toBeNull();
  });

  it("detects merge command in a piped sequence", () => {
    const cmd = "echo start | gh api -X PUT /repos/edobry/minsky/pulls/123/merge";
    expect(findGhApiPutMergeSegment(cmd)).not.toBeNull();
  });

  it("detects merge command in a semicolon sequence", () => {
    const cmd =
      "echo pre; gh api -X PUT /repos/edobry/minsky/pulls/123/merge -f merge_method=merge; echo done";
    expect(findGhApiPutMergeSegment(cmd)).not.toBeNull();
  });

  it("returns null when no merge command is present", () => {
    const cmd = "gh api /repos/edobry/minsky/pulls/123 && echo done";
    expect(findGhApiPutMergeSegment(cmd)).toBeNull();
  });

  it("returns null for completely unrelated commands", () => {
    expect(findGhApiPutMergeSegment("bun test")).toBeNull();
    expect(findGhApiPutMergeSegment("ls -la")).toBeNull();
    expect(findGhApiPutMergeSegment("echo hello")).toBeNull();
  });

  it("returns null for an empty command", () => {
    expect(findGhApiPutMergeSegment("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// session_exec path — same logic, different tool_name (indirect coverage)
// ---------------------------------------------------------------------------

describe("session_exec — same command detection logic", () => {
  // The hook entry point checks tool_name for 'mcp__minsky__session_exec';
  // the command parsing logic is identical regardless of tool. These tests
  // verify that the underlying detection functions work for session_exec-
  // style command strings (they do, since the detection is tool-agnostic).

  it("detects gh api PUT merge in session_exec command string", () => {
    const sessionExecCommand =
      "gh api -X PUT /repos/edobry/minsky/pulls/456/merge -f merge_method=merge";
    expect(findGhApiPutMergeSegment(sessionExecCommand)).not.toBeNull();
  });

  it("does NOT flag a legitimate session_exec command", () => {
    const sessionExecCommand = "bun test --preload ./tests/setup.ts --timeout=15000 src";
    expect(findGhApiPutMergeSegment(sessionExecCommand)).toBeNull();
  });

  it("does NOT flag a gh api GET in session_exec context", () => {
    const sessionExecCommand = "gh api /repos/edobry/minsky/pulls/123/reviews";
    expect(findGhApiPutMergeSegment(sessionExecCommand)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Env-var URL substitution (partial detection)
// ---------------------------------------------------------------------------

describe("env-var URL substitution detection", () => {
  it("detects when pulls/N/merge literal appears despite env-var prefix", () => {
    // When the shell hasn't expanded the var yet, the literal tail is still visible
    const cmd = "gh api -X PUT $REPO_BASE/pulls/123/merge -f merge_method=merge";
    expect(findGhApiPutMergeSegment(cmd)).not.toBeNull();
  });

  it("detects when full path is in a variable-containing token", () => {
    // /repos/owner/repo/pulls/123/merge with var-based prefix
    const cmd = 'gh api -X PUT "${API_URL}/repos/owner/repo/pulls/123/merge"';
    // The endpoint pattern matches after unquoting
    expect(findGhApiPutMergeSegment(cmd)).not.toBeNull();
  });
});
