/**
 * BINDING-level tests for the drive-pr-to-convergence hook.
 *
 * The DECISION tests — which tool the rule is about, and the reminder's own
 * content — moved to `packages/domain/src/detectors/pr-convergence-reminder.test.ts`
 * with the decision itself (mt#4374 SC4).
 *
 * What is left here is precisely what the binding owns: reading a result
 * envelope out of a hook payload. Every case below is a payload SHAPE the
 * decision must never have to know about.
 */
import { describe, expect, test } from "bun:test";
import { decideReminderFromPayload } from "./drive-pr-to-convergence";
import type { ToolHookInput } from "./types";
import { DRIVE_TO_CONVERGENCE_REMINDER } from "@minsky/domain/detectors/pr-convergence-reminder";

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

describe("decideReminderFromPayload (mt#1793 binding)", () => {
  test("relays the reminder when the envelope reports success", () => {
    const input = makeInput({
      tool_result: {
        success: true,
        url: "https://github.com/edobry/minsky/pull/9999",
      },
    });
    expect(decideReminderFromPayload(input)).toBe(DRIVE_TO_CONVERGENCE_REMINDER);
  });

  test("silent when the envelope reports failure", () => {
    const input = makeInput({
      tool_result: {
        success: false,
        error: "merge conflict",
      },
    });
    expect(decideReminderFromPayload(input)).toBeNull();
  });

  test("silent when tool_result is missing entirely", () => {
    const input = makeInput({ tool_result: undefined });
    expect(decideReminderFromPayload(input)).toBeNull();
  });

  test("silent when tool_result.success is truthy but not strictly true", () => {
    // Guards against malformed result envelopes that happen to be truthy —
    // the reason the binding compares with `=== true` rather than coercing.
    const input = makeInput({
      tool_result: {
        success: "true" as unknown as boolean, // string, not boolean
      },
    });
    expect(decideReminderFromPayload(input)).toBeNull();
  });

  test("silent when tool_result is a non-object", () => {
    const input = makeInput({
      tool_result: "ok" as unknown as Record<string, unknown>,
    });
    expect(decideReminderFromPayload(input)).toBeNull();
  });

  test("passes the payload's tool_name through to the decision", () => {
    const input = makeInput({
      tool_name: "mcp__minsky__session_commit",
      tool_result: { success: true },
    });
    expect(decideReminderFromPayload(input)).toBeNull();
  });
});
