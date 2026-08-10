// Dispatcher-level tests for guard-denial recording (mt#3802).
//
// Split out of `dispatcher.test.ts` rather than appended to it: that file is at
// ~1750 lines and the repo's `max-lines` ceiling is 1500, so adding here keeps
// both files inside the rule.

import { describe, test, expect } from "bun:test";

import { runDispatcher } from "./dispatcher";
import type { GuardRegistration } from "./registry";
import type { HookOutput } from "./types";
import { DISPATCH_HOOK_FILENAME, baseInput, stubContext } from "./test-support/dispatcher-harness";

/** The denial text these tests assert on, in one place. */
const DENY_REASON = "use the MCP tool";

describe("runDispatcher guard-denial recording", () => {
  const denyingGuard: GuardRegistration = {
    name: "denier",
    event: "PreToolUse",
    matcher: "Bash",
    module: () => Promise.resolve({ run: () => ({ deny: { reason: DENY_REASON } }) }),
    timeoutMs: 1000,
    denyCapable: true,
  };

  test("a deny hands the recorder the guard, tool, reason and input", async () => {
    const recorded: unknown[] = [];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations: [denyingGuard],
      readInputFn: () =>
        Promise.resolve(baseInput({ tool_name: "Bash", tool_input: { command: "git status" } })),
      writeOutputFn: () => {},
      stderrWrite: () => {},
      resolveDispatchContextFn: () => stubContext(),
      recordGuardDenialFn: (d) => recorded.push(d),
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      toolName: "Bash",
      guardName: "denier",
      reason: DENY_REASON,
      toolInput: { command: "git status" },
    });
  });

  test("an allow records nothing", async () => {
    const recorded: unknown[] = [];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations: [{ ...denyingGuard, module: () => Promise.resolve({ run: () => null }) }],
      readInputFn: () => Promise.resolve(baseInput({ tool_name: "Bash" })),
      writeOutputFn: () => {},
      stderrWrite: () => {},
      resolveDispatchContextFn: () => stubContext(),
      recordGuardDenialFn: (d) => recorded.push(d),
    });

    expect(recorded).toEqual([]);
  });

  test("a THROWING recorder still lets the deny through (SC4, PR #2770 R1)", async () => {
    // The production recorder swallows its own failures, but the seam accepts
    // an arbitrary callback — so the guarantee has to hold at the call site,
    // which is what the reviewer's blocking finding was about.
    const written: HookOutput[] = [];
    const stderr: string[] = [];

    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations: [denyingGuard],
      readInputFn: () => Promise.resolve(baseInput({ tool_name: "Bash" })),
      writeOutputFn: (o) => written.push(o),
      stderrWrite: (s) => stderr.push(s),
      resolveDispatchContextFn: () => stubContext(),
      recordGuardDenialFn: () => {
        throw new Error("tracker exploded");
      },
    });

    expect(written).toHaveLength(1);
    expect(written[0]?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(written[0]?.hookSpecificOutput?.permissionDecisionReason).toBe(DENY_REASON);
    expect(stderr.join("")).toContain("two-strikes denial recording failed");
  });
});
