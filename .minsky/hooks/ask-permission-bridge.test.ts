import { describe, test, expect } from "bun:test";
import {
  extractCommand,
  buildAllowReason,
  buildDenyReason,
  decideAskPermission,
} from "./ask-permission-bridge";
import type { ToolHookInput } from "./types";
import type { AskGrant } from "./ask-grant-store";

const grant: AskGrant = {
  askId: "38b1c0de-1234-4abc-8def-000000000001",
  tool: "Bash",
  commandPattern: "^minsky tasks bulk-edit .*$",
  issuedAt: "2026-07-17T10:00:00.000Z",
  ttlMs: 900000,
  reason: "approved via ask 38b1c0de",
};

describe("extractCommand", () => {
  test("extracts the command for the bridged tools", () => {
    expect(extractCommand("Bash", { command: "echo hi" })).toBe("echo hi");
    expect(extractCommand("mcp__minsky__session_exec", { command: "bun test" })).toBe("bun test");
  });

  test("returns null for other tools and missing/empty commands", () => {
    expect(extractCommand("Edit", { command: "echo hi" })).toBeNull();
    expect(extractCommand("Bash", {})).toBeNull();
    expect(extractCommand("Bash", { command: "" })).toBeNull();
    expect(extractCommand("Bash", { command: 42 as unknown as string })).toBeNull();
  });
});

describe("decision reasons", () => {
  test("allow reason names the askId and one-shot consumption", () => {
    const reason = buildAllowReason(grant);
    expect(reason).toContain(grant.askId);
    expect(reason).toMatch(/one-shot/);
  });

  test("deny reason names the askId and the fabrication signal", () => {
    const reason = buildDenyReason(grant, {
      verdict: "not-approved",
      detail: "ask not found",
    });
    expect(reason).toContain(grant.askId);
    expect(reason).toMatch(/FAILED server-side verification/);
    expect(reason).toMatch(/fabricated or stale/);
  });
});

// mt#5080 — the composed decision, extracted so the entry point and the canary
// share one function. The verifier is injected; nothing here touches the store.
describe("decideAskPermission", () => {
  const NOW = Date.parse("2026-07-17T10:05:00.000Z");
  const approved = () => ({ verdict: "approved" as const, detail: "approved by operator" });
  const notApproved = () => ({ verdict: "not-approved" as const, detail: "state is cancelled" });
  const unavailable = () => ({ verdict: "unavailable" as const, detail: "daemon down" });
  function input(overrides: Partial<ToolHookInput> = {}): ToolHookInput {
    return {
      session_id: "s",
      cwd: "/some/repo",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "minsky tasks bulk-edit --execute" },
      ...overrides,
    };
  }

  test("DENIES a matched grant whose ask fails server-side verification", () => {
    const d = decideAskPermission(input(), [grant], notApproved, NOW);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toMatch(/FAILED server-side verification/);
  });

  test("GRANTS a matched grant whose ask verifies as approved", () => {
    const d = decideAskPermission(input(), [grant], approved, NOW);
    expect(d.decision).toBe("grant");
  });

  test("passes through for a subagent, a non-command tool, no matching grant, and an unverifiable ask", () => {
    expect(decideAskPermission(input({ agent_id: "sub" }), [grant], approved, NOW)).toEqual({
      decision: "pass-through",
      why: "subagent",
    });
    expect(decideAskPermission(input({ tool_name: "Edit" }), [grant], approved, NOW)).toEqual({
      decision: "pass-through",
      why: "no-command",
    });
    expect(
      decideAskPermission(input({ tool_input: { command: "rm -rf /" } }), [grant], approved, NOW)
    ).toEqual({ decision: "pass-through", why: "no-grant" });
    const u = decideAskPermission(input(), [grant], unavailable, NOW);
    expect(u.decision).toBe("pass-through");
    if (u.decision === "pass-through") expect(u.why).toBe("unverifiable");
  });
});
