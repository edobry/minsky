// Tests for the bind/advance spec-read guard (mt#2515, Seam 1 of mt#2511).
//
// The load-bearing regression is the "earlier-turn" case: a spec read that
// happened in a turn BEFORE the current one must still be detected. A
// last-turn-only scan (the role=user tool_result hazard, mt#2255 / memory
// a3e60471) would miss it; the full-transcript scan must not.

import { describe, expect, test } from "bun:test";
import { findToolUseInputs, type TranscriptLine } from "./transcript";
import {
  normalizeTaskId,
  resolveTargetTaskId,
  specWasSurfaced,
  buildDenialReason,
  OVERRIDE_ENV_VAR,
  SPEC_GET_TOOL,
  TASKS_GET_TOOL,
  STATUS_SET_TOOL,
  SESSION_START_TOOL,
} from "./check-task-spec-read";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** Assistant line carrying a tool_use block inside message.content (the common shape). */
function assistantToolUse(name: string, input: Record<string, unknown>): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
  };
}

/** Top-level tool_use line (the alternate shape). */
function topLevelToolUse(name: string, input: Record<string, unknown>): TranscriptLine {
  return { type: "tool_use", name, input };
}

/** A user-role tool_result line — the hazard a turn-slice would treat as a boundary. */
function toolResult(): TranscriptLine {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  };
}

/** A real human prompt. */
function userPrompt(text: string): TranscriptLine {
  return { type: "user", message: { role: "user", content: text } };
}

// ---------------------------------------------------------------------------
// normalizeTaskId
// ---------------------------------------------------------------------------

describe("normalizeTaskId", () => {
  test("collapses #, case, and whitespace", () => {
    expect(normalizeTaskId("mt#2515")).toBe("mt2515");
    expect(normalizeTaskId("MT#2515")).toBe("mt2515");
    expect(normalizeTaskId("  mt#2515 ")).toBe("mt2515");
    expect(normalizeTaskId("mt2515")).toBe("mt2515");
  });

  test("distinct backends do not collide", () => {
    expect(normalizeTaskId("md#2515")).not.toBe(normalizeTaskId("mt#2515"));
  });

  test("non-string / empty -> empty string", () => {
    expect(normalizeTaskId(undefined)).toBe("");
    expect(normalizeTaskId(null)).toBe("");
    expect(normalizeTaskId(2515)).toBe("");
    expect(normalizeTaskId("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// resolveTargetTaskId
// ---------------------------------------------------------------------------

describe("resolveTargetTaskId", () => {
  test("tasks_status_set fires only on READY", () => {
    expect(resolveTargetTaskId(STATUS_SET_TOOL, { taskId: "mt#2515", status: "READY" })).toBe(
      "mt2515"
    );
    expect(resolveTargetTaskId(STATUS_SET_TOOL, { taskId: "mt#2515", status: "IN-PROGRESS" })).toBe(
      ""
    );
    expect(resolveTargetTaskId(STATUS_SET_TOOL, { taskId: "mt#2515", status: "DONE" })).toBe("");
  });

  test("status match is case-insensitive", () => {
    expect(resolveTargetTaskId(STATUS_SET_TOOL, { taskId: "mt#2515", status: "ready" })).toBe(
      "mt2515"
    );
  });

  test("session_start resolves task, falling back to taskId", () => {
    expect(resolveTargetTaskId(SESSION_START_TOOL, { task: "mt#2515" })).toBe("mt2515");
    expect(resolveTargetTaskId(SESSION_START_TOOL, { taskId: "mt#2515" })).toBe("mt2515");
  });

  test("unguarded tools return empty", () => {
    expect(resolveTargetTaskId("mcp__minsky__tasks_get", { taskId: "mt#2515" })).toBe("");
    expect(resolveTargetTaskId(SPEC_GET_TOOL, { taskId: "mt#2515" })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findToolUseInputs (the new transcript helper)
// ---------------------------------------------------------------------------

describe("findToolUseInputs", () => {
  test("finds inputs in both shapes; ignores other tools", () => {
    const lines: TranscriptLine[] = [
      assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#1" }),
      topLevelToolUse(SPEC_GET_TOOL, { taskId: "mt#2" }),
      assistantToolUse("mcp__minsky__memory_search", { query: "x" }),
    ];
    const inputs = findToolUseInputs(lines, SPEC_GET_TOOL);
    expect(inputs.map((i) => i["taskId"])).toEqual(["mt#1", "mt#2"]);
  });

  test("tool_use with no object input contributes {}", () => {
    const inputs = findToolUseInputs([{ type: "tool_use", name: SPEC_GET_TOOL }], SPEC_GET_TOOL);
    expect(inputs).toEqual([{}]);
  });
});

// ---------------------------------------------------------------------------
// specWasSurfaced
// ---------------------------------------------------------------------------

describe("specWasSurfaced", () => {
  test("tasks_spec_get (assistant-content shape) for the target -> true", () => {
    const lines = [assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#2515" })];
    expect(specWasSurfaced(lines, "mt2515")).toBe(true);
  });

  test("tasks_spec_get (top-level shape) for the target -> true", () => {
    const lines = [topLevelToolUse(SPEC_GET_TOOL, { taskId: "mt#2515" })];
    expect(specWasSurfaced(lines, "mt2515")).toBe(true);
  });

  test("tasks_get with includeSpec:true for the target -> true", () => {
    const lines = [assistantToolUse(TASKS_GET_TOOL, { taskId: "mt#2515", includeSpec: true })];
    expect(specWasSurfaced(lines, "mt2515")).toBe(true);
  });

  test("tasks_get WITHOUT includeSpec -> false (metadata read is not spec engagement)", () => {
    const lines = [assistantToolUse(TASKS_GET_TOOL, { taskId: "mt#2515" })];
    expect(specWasSurfaced(lines, "mt2515")).toBe(false);
  });

  test("spec read for a DIFFERENT task -> false", () => {
    const lines = [assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#9999" })];
    expect(specWasSurfaced(lines, "mt2515")).toBe(false);
  });

  test("empty target -> false", () => {
    const lines = [assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#2515" })];
    expect(specWasSurfaced(lines, "")).toBe(false);
  });

  // The regression that motivates the FULL-history scan (memory a3e60471):
  // the spec was read in an earlier turn, then tool round-trips + a later real
  // user prompt followed. A last-turn-only scan would miss the read; the
  // full-transcript scan must find it.
  test("spec read in an EARLIER turn is still detected (full-history, not last-turn)", () => {
    const lines: TranscriptLine[] = [
      userPrompt("investigate mt#2515"),
      assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#2515" }), // earlier turn
      toolResult(),
      userPrompt("ok, bring it to READY"), // a later real user prompt — turn boundary
      assistantToolUse("mcp__minsky__memory_search", { query: "hooks" }),
      toolResult(),
      // current tool call (tasks_status_set READY) fires now; not yet in transcript
    ];
    expect(specWasSurfaced(lines, "mt2515")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildDenialReason
// ---------------------------------------------------------------------------

describe("buildDenialReason", () => {
  test("names the advance action, the task, and the override", () => {
    const msg = buildDenialReason(STATUS_SET_TOOL, "mt#2515");
    expect(msg).toContain("advancing mt#2515 to READY");
    expect(msg).toContain("tasks_spec_get");
    expect(msg).toContain(OVERRIDE_ENV_VAR);
  });

  test("names the bind action for session_start", () => {
    const msg = buildDenialReason(SESSION_START_TOOL, "mt#2515");
    expect(msg).toContain("binding a session to mt#2515");
  });

  test("tolerates a missing id", () => {
    const msg = buildDenialReason(STATUS_SET_TOOL, undefined);
    expect(msg).toContain("<unknown>");
  });
});
