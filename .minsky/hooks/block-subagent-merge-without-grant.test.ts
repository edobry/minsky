import { describe, expect, it } from "bun:test";
import {
  isSubagentContext,
  resolveTaskIdFromInput,
  decideMergeGrant,
  buildDenialMessage,
  MERGE_GRANT_OVERRIDE_ENV,
} from "./block-subagent-merge-without-grant";
import type { MergeGrant } from "./merge-grant-store";
import type { ToolHookInput } from "./types";

const NOW = Date.parse("2026-07-07T20:00:00.000Z");

function makeInput(overrides: Partial<ToolHookInput> = {}): ToolHookInput {
  return {
    session_id: "test-session",
    cwd: "/some/repo",
    hook_event_name: "PreToolUse",
    tool_name: "mcp__minsky__session_pr_merge",
    tool_input: {},
    ...overrides,
  };
}

function makeGrant(overrides: Partial<MergeGrant> = {}): MergeGrant {
  return {
    taskId: "mt#2651",
    agentScope: "any",
    issuedAt: new Date(NOW).toISOString(),
    ttlMs: 30 * 60 * 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isSubagentContext
// ---------------------------------------------------------------------------

describe("isSubagentContext", () => {
  it("returns true when agent_id is a non-empty string", () => {
    expect(isSubagentContext(makeInput({ agent_id: "agent-abc-123" }))).toBe(true);
  });

  it("returns false when agent_id is undefined (main agent / main-thread)", () => {
    expect(isSubagentContext(makeInput({ agent_id: undefined }))).toBe(false);
  });

  it("returns false when agent_id is empty string", () => {
    expect(isSubagentContext(makeInput({ agent_id: "" }))).toBe(false);
  });

  it("returns false when agent_id is absent from the input object entirely", () => {
    const input = makeInput();
    delete (input as Partial<ToolHookInput>).agent_id;
    expect(isSubagentContext(input)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveTaskIdFromInput
// ---------------------------------------------------------------------------

describe("resolveTaskIdFromInput", () => {
  it("prefers tool_input.task when present", () => {
    const input = makeInput({ tool_input: { task: "mt#2651" } });
    expect(resolveTaskIdFromInput(input)).toBe("mt#2651");
  });

  it("trims whitespace from tool_input.task", () => {
    const input = makeInput({ tool_input: { task: "  mt#2651  " } });
    expect(resolveTaskIdFromInput(input)).toBe("mt#2651");
  });

  it("ignores a non-string tool_input.task and falls through to cwd resolution", () => {
    const input = makeInput({ tool_input: { task: 2651 }, cwd: "" });
    expect(resolveTaskIdFromInput(input)).toBeNull();
  });

  it("returns null when tool_input.task is absent and cwd is empty", () => {
    const input = makeInput({ tool_input: {}, cwd: "" });
    expect(resolveTaskIdFromInput(input)).toBeNull();
  });

  it("returns null when cwd is not a git repo / branch pattern doesn't match", () => {
    // A guaranteed-nonexistent directory: `git rev-parse` fails with a
    // non-zero exit code (no such directory to chdir into), so
    // resolveTaskIdFromInput must return null rather than throw.
    const input = makeInput({ tool_input: {}, cwd: "/nonexistent-dir-for-merge-grant-test-xyz" });
    expect(resolveTaskIdFromInput(input)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decideMergeGrant — the deny / allow / expired matrix (acceptance tests)
// ---------------------------------------------------------------------------

describe("decideMergeGrant — acceptance matrix", () => {
  it("DENY: agent_id set, no grant in store", () => {
    const decision = decideMergeGrant("mt#2651", "agent-123", [], NOW);
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toMatch(/no valid capability grant/);
  });

  it("ALLOW: agent_id set, fresh valid grant covers the task", () => {
    const grants = [makeGrant()];
    const decision = decideMergeGrant("mt#2651", "agent-123", grants, NOW);
    expect(decision.decision).toBe("allow");
  });

  it("DENY: agent_id set, grant exists but is expired", () => {
    const grants = [makeGrant({ ttlMs: 60_000 })];
    const later = NOW + 61_000; // past the 60s TTL
    const decision = decideMergeGrant("mt#2651", "agent-123", grants, later);
    expect(decision.decision).toBe("deny");
  });

  it("DENY: grant exists for a different task", () => {
    const grants = [makeGrant({ taskId: "mt#9999" })];
    const decision = decideMergeGrant("mt#2651", "agent-123", grants, NOW);
    expect(decision.decision).toBe("deny");
  });

  it("DENY: grant exists but scoped to a different specific agent_id", () => {
    const grants = [makeGrant({ agentScope: "agent-999" })];
    const decision = decideMergeGrant("mt#2651", "agent-123", grants, NOW);
    expect(decision.decision).toBe("deny");
  });

  it("ALLOW: grant scoped to the exact matching agent_id", () => {
    const grants = [makeGrant({ agentScope: "agent-123" })];
    const decision = decideMergeGrant("mt#2651", "agent-123", grants, NOW);
    expect(decision.decision).toBe("allow");
  });

  it("DENY: task id unresolvable (null) even with an otherwise-valid grant present", () => {
    const grants = [makeGrant()];
    const decision = decideMergeGrant(null, "agent-123", grants, NOW);
    expect(decision.decision).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// buildDenialMessage
// ---------------------------------------------------------------------------

describe("buildDenialMessage", () => {
  it("includes the resolved task id", () => {
    expect(buildDenialMessage("mt#2651")).toMatch(/mt#2651/);
  });

  it("names the orchestrator issuance script", () => {
    expect(buildDenialMessage("mt#2651")).toMatch(/scripts\/grant-subagent-merge\.ts/);
  });

  it("names the override env var", () => {
    expect(buildDenialMessage("mt#2651")).toMatch(new RegExp(MERGE_GRANT_OVERRIDE_ENV));
  });

  it("handles a null (unresolvable) task id gracefully", () => {
    expect(buildDenialMessage(null)).toMatch(/could not be resolved/);
  });
});

// ---------------------------------------------------------------------------
// Override env var constant
// ---------------------------------------------------------------------------

describe("MERGE_GRANT_OVERRIDE_ENV", () => {
  it("exports the correct env var name", () => {
    expect(MERGE_GRANT_OVERRIDE_ENV).toBe("MINSKY_SKIP_MERGE_GRANT_CHECK");
  });
});
