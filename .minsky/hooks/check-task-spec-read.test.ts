/* eslint-disable custom/no-real-fs-in-tests -- resolveTranscriptCandidates walks the real on-disk <session>/subagents/ layout via readdirSync, so these tests must create real nested transcript fixtures (same pattern as substrate-bypass-detector.test.ts) */
// Tests for the bind/advance spec-read guard (mt#2515, Seam 1 of mt#2511).
//
// The load-bearing regression is the "earlier-turn" case: a spec read that
// happened in a turn BEFORE the current one must still be detected. A
// last-turn-only scan (the role=user tool_result hazard, mt#2255 / memory
// a3e60471) would miss it; the full-transcript scan must not.

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findToolUseInputs, resolveTranscriptCandidates, type TranscriptLine } from "./transcript";
import {
  normalizeTaskId,
  resolveTargetTaskId,
  specWasSurfaced,
  specWasSurfacedInAnyTranscript,
  buildDenialReason,
  OVERRIDE_ENV_VAR,
  SPEC_GET_TOOL,
  TASKS_GET_TOOL,
  STATUS_SET_TOOL,
  SESSION_START_TOOL,
  DISPATCH_TOOL,
} from "./check-task-spec-read";

/** A non-spec tool name reused across fixtures. */
const MEMORY_SEARCH_TOOL = "mcp__minsky__memory_search";
/** The per-agent transcript filename for fixture agent id "abc123". */
const AGENT_ABC_FILE = "agent-abc123.jsonl";

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

  test("collapses separator forms (mt-2515 / mt_2515) to the hash form", () => {
    expect(normalizeTaskId("mt-2515")).toBe("mt2515");
    expect(normalizeTaskId("mt_2515")).toBe("mt2515");
    expect(normalizeTaskId("task/mt-2515".replace("task/", ""))).toBe("mt2515");
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

  // mt#2657: tasks_dispatch existing-task mode composes this guard rather than bypassing it.
  test("tasks_dispatch fires only when taskId is present (existing-task mode)", () => {
    expect(resolveTargetTaskId(DISPATCH_TOOL, { taskId: "mt#2515", instructions: "do it" })).toBe(
      "mt2515"
    );
  });

  test("tasks_dispatch new-task mode (title, no taskId) is not guarded", () => {
    expect(
      resolveTargetTaskId(DISPATCH_TOOL, { title: "New subtask", instructions: "do it" })
    ).toBe("");
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
      assistantToolUse(MEMORY_SEARCH_TOOL, { query: "x" }),
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
      assistantToolUse(MEMORY_SEARCH_TOOL, { query: "hooks" }),
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

  test("names the dispatch action for tasks_dispatch (mt#2657)", () => {
    const msg = buildDenialReason(DISPATCH_TOOL, "mt#2515");
    expect(msg).toContain("one-call-dispatching mt#2515");
  });
});

// ---------------------------------------------------------------------------
// Subagent-aware transcript resolution (mt#2637)
//
// The load-bearing regression: a background-Agent-dispatched subagent receives
// `transcript_path` pointing at the PARENT session's top-level transcript,
// while its own tool_use lines live at
// `<dir>/<session-id>/subagents/agent-<agentId>.jsonl`. The guard must find a
// spec read recorded ONLY in the subagent's own file (the mt#2614/mt#2612
// false-positive), while a tree with NO read anywhere must still deny.
// ---------------------------------------------------------------------------

/** Serialize transcript lines to a JSONL string. */
function toJsonl(lines: TranscriptLine[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

const fixtureRoots: string[] = [];

/**
 * Build an on-disk fixture mirroring the harness layout:
 *   <root>/<session-id>.jsonl                       (parent transcript)
 *   <root>/<session-id>/subagents/agent-<id>.jsonl  (per-agent transcripts)
 * Returns the parent transcript path.
 */
function buildTranscriptTree(
  parentLines: TranscriptLine[],
  subagents: Record<string, TranscriptLine[]>
): string {
  const root = mkdtempSync(join(tmpdir(), "spec-read-guard-"));
  fixtureRoots.push(root);
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const parentPath = join(root, `${sessionId}.jsonl`);
  writeFileSync(parentPath, toJsonl(parentLines));
  const entries = Object.entries(subagents);
  if (entries.length > 0) {
    const subagentsDir = join(root, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    for (const [agentId, lines] of entries) {
      writeFileSync(join(subagentsDir, `agent-${agentId}.jsonl`), toJsonl(lines));
    }
  }
  return parentPath;
}

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveTranscriptCandidates", () => {
  test("no subagents dir -> just the given path", () => {
    const parentPath = buildTranscriptTree([userPrompt("hi")], {});
    expect(resolveTranscriptCandidates(parentPath)).toEqual([parentPath]);
  });

  test("agentId yields the precise per-agent file, deduped against the sibling sweep", () => {
    const parentPath = buildTranscriptTree([userPrompt("hi")], {
      abc123: [],
      def456: [],
    });
    const candidates = resolveTranscriptCandidates(parentPath, "abc123");
    const sessionDir = parentPath.slice(0, -".jsonl".length);
    expect(candidates[0]).toBe(parentPath);
    expect(candidates[1]).toBe(join(sessionDir, "subagents", AGENT_ABC_FILE));
    expect(candidates).toContain(join(sessionDir, "subagents", "agent-def456.jsonl"));
    // precise path appears exactly once despite also matching the sibling sweep
    expect(candidates.filter((c) => c.endsWith(AGENT_ABC_FILE))).toHaveLength(1);
  });

  test("sibling agent files are found even without an agentId", () => {
    const parentPath = buildTranscriptTree([userPrompt("hi")], { abc123: [] });
    const candidates = resolveTranscriptCandidates(parentPath);
    expect(candidates).toHaveLength(2);
    expect(candidates[1]).toContain(AGENT_ABC_FILE);
  });

  test("non-.jsonl path -> no derivation, never throws", () => {
    expect(resolveTranscriptCandidates("/nonexistent/thing.txt")).toEqual([
      "/nonexistent/thing.txt",
    ]);
  });

  test("transcript_path already a per-agent file -> parent + siblings, no bogus nested derivation", () => {
    const parentPath = buildTranscriptTree([userPrompt("hi")], {
      abc123: [],
      def456: [],
    });
    const sessionDir = parentPath.slice(0, -".jsonl".length);
    const agentPath = join(sessionDir, "subagents", AGENT_ABC_FILE);
    const candidates = resolveTranscriptCandidates(agentPath, "abc123");
    expect(candidates[0]).toBe(agentPath);
    expect(candidates[1]).toBe(parentPath); // parent session transcript (tree semantics)
    expect(candidates).toContain(join(sessionDir, "subagents", "agent-def456.jsonl"));
    // the given per-agent path is deduped against both the precise push and the sweep
    expect(candidates.filter((c) => c.endsWith(AGENT_ABC_FILE))).toHaveLength(1);
    // nothing derives a nested .../agent-abc123/subagents/... path
    expect(candidates.some((c) => c.includes(join("agent-abc123", "subagents")))).toBe(false);
  });
});

describe("specWasSurfacedInAnyTranscript (mt#2637 regression)", () => {
  const specRead = assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#2614" });
  const unrelated = assistantToolUse(MEMORY_SEARCH_TOOL, { query: "x" });

  test("read ONLY in the subagent's own file, precise agent_id -> allowed", () => {
    const parentPath = buildTranscriptTree([userPrompt("dispatch it"), unrelated], {
      abc123: [specRead],
    });
    expect(specWasSurfacedInAnyTranscript(parentPath, "abc123", "mt2614")).toBe(true);
  });

  test("read only in a sibling agent file, hook agent_id UNKNOWN -> allowed via fallback sweep", () => {
    const parentPath = buildTranscriptTree([userPrompt("dispatch it")], {
      abc123: [specRead],
    });
    // agent_id doesn't match any on-disk filename — the sibling sweep still finds it
    expect(specWasSurfacedInAnyTranscript(parentPath, "zzz999", "mt2614")).toBe(true);
  });

  test("read only in the PARENT transcript (orchestrator pre-read) -> allowed", () => {
    const parentPath = buildTranscriptTree([userPrompt("planning"), specRead], {
      abc123: [unrelated],
    });
    expect(specWasSurfacedInAnyTranscript(parentPath, "abc123", "mt2614")).toBe(true);
  });

  test("parent read found even when the hook receives the subagent's OWN path -> allowed", () => {
    const parentPath = buildTranscriptTree([userPrompt("planning"), specRead], {
      abc123: [unrelated],
    });
    const sessionDir = parentPath.slice(0, -".jsonl".length);
    const agentPath = join(sessionDir, "subagents", AGENT_ABC_FILE);
    expect(specWasSurfacedInAnyTranscript(agentPath, "abc123", "mt2614")).toBe(true);
  });

  test("NO read anywhere in the tree -> still denied (true-positive preserved)", () => {
    const parentPath = buildTranscriptTree([userPrompt("ship the deck"), unrelated], {
      abc123: [unrelated],
      def456: [],
    });
    expect(specWasSurfacedInAnyTranscript(parentPath, "abc123", "mt2614")).toBe(false);
  });

  test("read for a DIFFERENT task in the subagent file -> denied", () => {
    const parentPath = buildTranscriptTree([userPrompt("go")], {
      abc123: [assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#9999" })],
    });
    expect(specWasSurfacedInAnyTranscript(parentPath, "abc123", "mt2614")).toBe(false);
  });

  test("missing transcript file -> false, never throws (fail-open handled by caller)", () => {
    expect(specWasSurfacedInAnyTranscript("/nonexistent/session.jsonl", "abc", "mt2614")).toBe(
      false
    );
  });
});
