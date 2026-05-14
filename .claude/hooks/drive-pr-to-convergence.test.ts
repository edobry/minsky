import { describe, test, expect } from "bun:test";
import { decideReminder, DRIVE_TO_CONVERGENCE_REMINDER } from "./drive-pr-to-convergence";
import type { ToolHookInput } from "./types";

/**
 * Build a minimal `ToolHookInput` for tests.
 */
function makeInput(overrides: Partial<ToolHookInput> = {}): ToolHookInput {
  return {
    session_id: "test-session",
    cwd: "/test",
    hook_event_name: "PostToolUse",
    tool_name: "mcp__minsky__session_pr_create",
    tool_input: { task: "mt#1234" },
    ...overrides,
  };
}

describe("drive-pr-to-convergence hook (mt#1793)", () => {
  describe("decideReminder", () => {
    test("emits reminder on successful session_pr_create", () => {
      const input = makeInput({
        tool_result: {
          success: true,
          url: "https://github.com/edobry/minsky/pull/9999",
        },
      });
      expect(decideReminder(input)).toBe(DRIVE_TO_CONVERGENCE_REMINDER);
    });

    test("silent on failed session_pr_create (success=false)", () => {
      const input = makeInput({
        tool_result: {
          success: false,
          error: "merge conflict",
        },
      });
      expect(decideReminder(input)).toBeNull();
    });

    test("silent when tool_result is missing", () => {
      const input = makeInput({ tool_result: undefined });
      expect(decideReminder(input)).toBeNull();
    });

    test("silent when tool_result.success is not strictly true", () => {
      // Truthy but not === true should not fire — guards against malformed
      // result envelopes that happen to be truthy.
      const input = makeInput({
        tool_result: {
          success: "true" as unknown as boolean, // string, not boolean
        },
      });
      expect(decideReminder(input)).toBeNull();
    });

    test("silent on non-matching tool name", () => {
      const input = makeInput({
        tool_name: "mcp__minsky__session_commit",
        tool_result: { success: true },
      });
      expect(decideReminder(input)).toBeNull();
    });

    test("silent on Bash tool (covers wildcard PostToolUse matchers that might union)", () => {
      const input = makeInput({
        tool_name: "Bash",
        tool_result: { success: true },
      });
      expect(decideReminder(input)).toBeNull();
    });

    test("silent on session_pr_merge (sibling tool, not in scope)", () => {
      const input = makeInput({
        tool_name: "mcp__minsky__session_pr_merge",
        tool_result: { success: true },
      });
      expect(decideReminder(input)).toBeNull();
    });
  });

  describe("DRIVE_TO_CONVERGENCE_REMINDER content", () => {
    test("references the corpus rule for traceability", () => {
      expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("User does not review PRs in the loop");
    });

    test("names the required next action explicitly", () => {
      expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("session_pr_wait-for-review");
    });

    test("names the webhook-miss fallback (/review-pr / Chinese-wall reviewer)", () => {
      expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("/review-pr");
      expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("Chinese-wall");
    });

    test("forbids the originating deferral phrases", () => {
      // Originating-incident phrase from PR #1076.
      expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("Ping me when done");
      // Slow-ask variants.
      expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("Let me know when merged");
      expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("Ready for your review");
    });

    test("includes the slow-ask framing reference", () => {
      expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("slow-ask variant");
    });

    test("encodes the success branches (APPROVE / CHANGES_REQUESTED)", () => {
      expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("APPROVE");
      expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("CHANGES_REQUESTED");
    });
  });
});
