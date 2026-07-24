/**
 * Tests for the bare-prohibition PreToolUse hook on the raw `Agent` tool (mt#3162).
 *
 * Path B is the path the originating incident actually used — the mt#3120 dispatch never crossed
 * `tasks_dispatch` (verified against `subagent_invocations`; see the hook's module header), so
 * these tests cover the surface that would have caught it.
 *
 * The `enforcementEnabled` parameter of `decideBareProhibitionGate` is injected here rather than
 * mutating the shared module constant, so both the shipped calibration behavior (allow) and the
 * post-graduation behavior (deny) are exercised without a global flip.
 */

import { describe, expect, test } from "bun:test";
import {
  decideBareProhibitionGate,
  extractPrompt,
  isOverrideActive,
  buildCalibrationRecord,
  OVERRIDE_ENV_VAR,
} from "./warn-bare-prohibition-dispatch";
import { analyzeNegativeConstraints } from "../../packages/domain/src/validation/negative-constraint";
import type { ToolHookInput } from "./types";

/** Minimal Agent-tool PreToolUse input carrying a dispatch prompt. */
function agentCall(prompt: string | undefined): ToolHookInput {
  return {
    session_id: "test-session",
    // Mock path — no test in this file exercises the filesystem-writing path
    // (`appendCalibrationRecord`), so this never needs to be a real directory.
    cwd: "/mock/repo",
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: prompt === undefined ? {} : { prompt, subagent_type: "implementer" },
  } as ToolHookInput;
}

/** The mt#3120 shape: wrong prohibition, but shipped WITH basis and licence (mem#702). */
const MT3120_RECOVERABLE_PROMPT = [
  "The creation-time approach is blocked: the MCP caller-identity chain cannot distinguish a",
  "parent conversation from its subagents (Layer 1 is a per-process hash; Layer 3 is unbuilt),",
  "so do not attempt it in this task.",
  "",
  "If planning concludes the retitle/rescope is warranted, amend the spec — that is expected.",
].join("\n");

/** The same instruction stripped to a bare prohibition. */
const MT3120_BARE_PROMPT = "The creation-time approach is blocked; do not attempt it in this task.";

describe("decideBareProhibitionGate — mt#3120 (the path the incident used)", () => {
  test("the real recoverable prompt is allowed, with no bare findings", () => {
    const decision = decideBareProhibitionGate(agentCall(MT3120_RECOVERABLE_PROMPT), {}, true);

    expect(decision.decision).toBe("allow");
    expect(decision.report?.bare ?? []).toEqual([]);
  });

  test("the bare version is DENIED once enforcement is on", () => {
    const decision = decideBareProhibitionGate(agentCall(MT3120_BARE_PROMPT), {}, true);

    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("do not attempt");
    expect(decision.reason).toContain("BECAUSE");
  });

  test("the bare version is ALLOWED but reported under calibration mode (shipped default)", () => {
    const decision = decideBareProhibitionGate(agentCall(MT3120_BARE_PROMPT), {}, false);

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain("calibration mode");
    // Still reported — the calibration record is the v1 product.
    expect(decision.report?.bare.length ?? 0).toBeGreaterThan(0);
  });
});

describe("decideBareProhibitionGate — pass-through cases", () => {
  test("an ordinary prompt with no prohibition is allowed", () => {
    const decision = decideBareProhibitionGate(
      agentCall("Implement the retry path per the spec, then open a PR."),
      {},
      true
    );

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain("no bare prohibition");
  });

  test("a call with no prompt field is allowed", () => {
    const decision = decideBareProhibitionGate(agentCall(undefined), {}, true);

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain("no prompt");
  });

  test("the override env var suppresses detection even with enforcement on", () => {
    const decision = decideBareProhibitionGate(
      agentCall(MT3120_BARE_PROMPT),
      { [OVERRIDE_ENV_VAR]: "1" },
      true
    );

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain(OVERRIDE_ENV_VAR);
  });
});

describe("extractPrompt / isOverrideActive", () => {
  test("extractPrompt returns null for absent, empty, and non-string values", () => {
    expect(extractPrompt(agentCall(undefined))).toBeNull();
    expect(extractPrompt(agentCall(""))).toBeNull();
    expect(extractPrompt(agentCall("   \n "))).toBeNull();
    expect(extractPrompt({ tool_input: { prompt: 42 } } as unknown as ToolHookInput)).toBeNull();
  });

  test("isOverrideActive accepts the documented truthy spellings only", () => {
    expect(isOverrideActive({ [OVERRIDE_ENV_VAR]: "1" })).toBe(true);
    expect(isOverrideActive({ [OVERRIDE_ENV_VAR]: "true" })).toBe(true);
    expect(isOverrideActive({ [OVERRIDE_ENV_VAR]: "YES" })).toBe(true);
    expect(isOverrideActive({ [OVERRIDE_ENV_VAR]: "0" })).toBe(false);
    expect(isOverrideActive({})).toBe(false);
  });
});

describe("buildCalibrationRecord", () => {
  test("labels each match by which property was missing", () => {
    const report = analyzeNegativeConstraints(MT3120_BARE_PROMPT);
    const record = buildCalibrationRecord(agentCall(MT3120_BARE_PROMPT), report);
    const matches = record["matches"] as Array<Record<string, unknown>>;

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.["category"]).toBe("no-basis");
    expect(record["has_licence_to_falsify"]).toBe(false);
  });

  test("a basis-carrying but licence-less prompt is categorized no-licence", () => {
    const text = "Do not build the polling path because the webhook already covers it.";
    const report = analyzeNegativeConstraints(text);
    const record = buildCalibrationRecord(agentCall(text), report);
    const matches = record["matches"] as Array<Record<string, unknown>>;

    expect(matches[0]?.["category"]).toBe("no-licence");
  });
});

describe("both dispatch paths share one detector (mt#3162 SC: single implementation)", () => {
  // The same fixtures drive the hook's decision and a direct call to the shared analyzer; if the
  // hook ever grew its own copy of the patterns, these would diverge.
  const fixtures = [
    MT3120_RECOVERABLE_PROMPT,
    MT3120_BARE_PROMPT,
    "Do not build the polling path because the webhook already covers it.",
    "Implement the retry path per the spec, then open a PR.",
  ];

  test("hook verdicts agree with the shared analyzer on every fixture", () => {
    for (const text of fixtures) {
      const shared = analyzeNegativeConstraints(text);
      const decision = decideBareProhibitionGate(agentCall(text), {}, true);
      const hookSaysBare = decision.decision === "deny";

      expect(hookSaysBare).toBe(shared.bare.length > 0);
    }
  });
});
