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
import {
  findToolUseInputs,
  findCreatedResourceIds,
  resolveTranscriptCandidates,
  type TranscriptLine,
} from "./transcript";
import {
  normalizeTaskId,
  resolveTargetTaskId,
  specWasSurfaced,
  specWasAuthored,
  specWasSurfacedInAnyTranscript,
  buildDenialReason,
  OVERRIDE_ENV_VAR,
  SPEC_GET_TOOL,
  TASKS_GET_TOOL,
  TASKS_CREATE_TOOL,
  SPEC_PATCH_TOOL,
  SPEC_SEARCH_REPLACE_TOOL,
  TASKS_EDIT_TOOL,
  STATUS_SET_TOOL,
  SESSION_START_TOOL,
  DISPATCH_TOOL,
  ASKS_CREATE_TOOL,
  ASKS_EDIT_TOOL,
  MAX_ASK_TASK_REFS,
  extractAskTaskIds,
  unreadAskTaskIds,
  buildAskAdvisoryReason,
  cliSpecEngagements,
  FALSIFIED_BANNER_TOKEN,
  extractSpecBody,
  specCarriesFalsifiedBanner,
  falsifiedAskTaskIds,
  buildFalsifiedAdvisoryReason,
} from "./check-task-spec-read";
import { readManifest, resolveCommandNode } from "./detect-cli-mcp-substitution";

/**
 * A transcript path that is present but does not resolve — the "nothing was
 * surfaced" case, distinct from an ABSENT `transcript_path` (the only fail-open).
 * Shared by both ask-seam legs so the two cannot drift apart.
 */
const MISSING_TRANSCRIPT_PATH = "/nonexistent/path.jsonl";

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

/** Assistant tool_use block carrying an explicit correlation id, for tool_result pairing. */
function assistantToolUseWithId(
  id: string,
  name: string,
  input: Record<string, unknown>
): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  };
}

/**
 * A user-role tool_result line whose text content is a JSON-serialized
 * payload — mirrors the real shape an MCP tool call's result takes in a
 * Claude Code transcript (`{ tool_use_id, type: "tool_result", content: [{
 * type: "text", text: "<json>" }] }`).
 */
function toolResultJson(toolUseId: string, payload: Record<string, unknown>): TranscriptLine {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: toolUseId,
          type: "tool_result",
          content: [{ type: "text", text: JSON.stringify(payload) }],
        },
      ],
    },
  };
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
});

/**
 * New-task-mode pass-through (PR #1837 review 4651474893, finding #2): broadening the
 * PreToolUse matcher to ALL `tasks_dispatch` calls could in principle increase denial risk for
 * new-task-mode dispatches (which have no pre-existing spec to have read). The fix is that
 * `resolveTargetTaskId` returns "" for every new-task-mode shape, and the hook's entrypoint
 * treats an empty target id as an unconditional, unscanned ALLOW:
 *
 *   const targetId = resolveTargetTaskId(toolName, toolInput);
 *   if (!targetId) process.exit(0); // not guarded / non-READY transition / no resolvable id
 *
 * — i.e. new-task-mode dispatches exit 0 (allow) BEFORE any transcript read happens, so there is
 * no denial risk to eliminate: the guard never even attempts to resolve a transcript for them.
 * These tests lock in every new-task-mode input shape that must resolve to "".
 */
describe("tasks_dispatch new-task-mode pass-through (mt#2657 / PR #1837 review finding #2)", () => {
  test("title only, no taskId at all -> not guarded", () => {
    expect(
      resolveTargetTaskId(DISPATCH_TOOL, { title: "New subtask", instructions: "do it" })
    ).toBe("");
  });

  test("title + explicit empty-string taskId -> not guarded (falsy, not a real id)", () => {
    expect(
      resolveTargetTaskId(DISPATCH_TOOL, {
        title: "New subtask",
        taskId: "",
        instructions: "do it",
      })
    ).toBe("");
  });

  test("title + parentTaskId (root/subtask creation), no taskId -> not guarded", () => {
    expect(
      resolveTargetTaskId(DISPATCH_TOOL, {
        title: "New subtask",
        parentTaskId: "mt#1",
        instructions: "do it",
      })
    ).toBe("");
  });

  test("neither title nor taskId (malformed call the command layer will reject) -> still not guarded", () => {
    // The guard's job is spec-read detection, not param-shape validation — a malformed call
    // with no taskId is not this guard's concern (tasks.dispatch's own validateDispatchMode
    // rejects it at the command layer). Confirms the guard never denies on absence alone.
    expect(resolveTargetTaskId(DISPATCH_TOOL, { instructions: "do it" })).toBe("");
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
// findCreatedResourceIds (mt#2814 — correlates a tool_use with no id in its
// OWN input, e.g. tasks_create, against the server-assigned id in its result)
// ---------------------------------------------------------------------------

describe("findCreatedResourceIds", () => {
  test("correlates a tool_use to the taskId reported in its tool_result", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, {
        title: "New task",
        spec: "## Summary",
      }),
      toolResultJson("toolu_1", { success: true, taskId: "mt#2814", message: "created" }),
    ];
    const results = findCreatedResourceIds(lines, TASKS_CREATE_TOOL, "taskId");
    expect(results).toHaveLength(1);
    expect(results[0]?.createdId).toBe("mt#2814");
    expect(results[0]?.input["spec"]).toBe("## Summary");
    expect(results[0]?.result).toEqual({ success: true, taskId: "mt#2814", message: "created" });
  });

  test("no correlated tool_result -> createdId AND result undefined, never throws", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, { title: "New task", spec: "x" }),
    ];
    const results = findCreatedResourceIds(lines, TASKS_CREATE_TOOL, "taskId");
    expect(results).toHaveLength(1);
    expect(results[0]?.createdId).toBeUndefined();
    expect(results[0]?.result).toBeUndefined();
  });

  // PR #1982 review: extractToolResultText is not pinned to `{ type: "text" }`
  // exactly — any block carrying a string `text` field is accepted, so an
  // alternately-tagged text block is not silently dropped.
  test("tool_result block WITHOUT an explicit type field, but with a text property -> still parsed", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, { title: "New task", spec: "x" }),
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: "toolu_1",
              type: "tool_result",
              content: [{ text: JSON.stringify({ success: true, taskId: "mt#2814" }) }],
            },
          ],
        },
      },
    ];
    const results = findCreatedResourceIds(lines, TASKS_CREATE_TOOL, "taskId");
    expect(results[0]?.createdId).toBe("mt#2814");
  });

  // A block whose text is nested one level deeper (an embedded-resource-style
  // `{ content: [...] }` wrapper) is recursed into once rather than dropped.
  test("tool_result text nested inside a wrapper block's own content array -> still parsed", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, { title: "New task", spec: "x" }),
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: "toolu_1",
              type: "tool_result",
              content: [
                {
                  type: "resource",
                  content: [
                    { type: "text", text: JSON.stringify({ success: true, taskId: "mt#2814" }) },
                  ],
                },
              ],
            },
          ],
        },
      },
    ];
    const results = findCreatedResourceIds(lines, TASKS_CREATE_TOOL, "taskId");
    expect(results[0]?.createdId).toBe("mt#2814");
  });

  test("tool_result is non-JSON (error path) -> createdId undefined, never throws", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, { title: "New task", spec: "x" }),
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: "toolu_1",
              type: "tool_result",
              content: [{ type: "text", text: "Error: --spec must be provided" }],
            },
          ],
        },
      },
    ];
    const results = findCreatedResourceIds(lines, TASKS_CREATE_TOOL, "taskId");
    expect(results[0]?.createdId).toBeUndefined();
  });

  test("result lacking the id field -> createdId undefined", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, { title: "New task", spec: "x" }),
      toolResultJson("toolu_1", { success: true, message: "created" }),
    ];
    const results = findCreatedResourceIds(lines, TASKS_CREATE_TOOL, "taskId");
    expect(results[0]?.createdId).toBeUndefined();
  });

  test("ignores tool_use blocks for a different tool name", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", MEMORY_SEARCH_TOOL, { query: "x" }),
      toolResultJson("toolu_1", { taskId: "mt#9999" }),
    ];
    expect(findCreatedResourceIds(lines, TASKS_CREATE_TOOL, "taskId")).toEqual([]);
  });

  test("multiple tasks_create calls in one transcript each correlate independently", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, { title: "First", spec: "a" }),
      toolResultJson("toolu_1", { taskId: "mt#1" }),
      assistantToolUseWithId("toolu_2", TASKS_CREATE_TOOL, { title: "Second", spec: "b" }),
      toolResultJson("toolu_2", { taskId: "mt#2" }),
    ];
    const results = findCreatedResourceIds(lines, TASKS_CREATE_TOOL, "taskId");
    expect(results.map((r) => r.createdId)).toEqual(["mt#1", "mt#2"]);
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
// specWasAuthored (mt#2814 — same-transcript spec-authorship credit)
// ---------------------------------------------------------------------------

describe("specWasAuthored", () => {
  test("tasks_create with a spec, correlated result taskId matches -> true", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, {
        title: "New task",
        spec: "## Summary\n\nFull spec body.",
      }),
      toolResultJson("toolu_1", { success: true, taskId: "mt#2814" }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(true);
  });

  test("tasks_create with a spec, correlated result taskId is a DIFFERENT task -> false", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, { title: "Other task", spec: "x" }),
      toolResultJson("toolu_1", { success: true, taskId: "mt#9999" }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(false);
  });

  test("tasks_create call with NO spec (e.g. a malformed call caught elsewhere) -> false even if a result correlates", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, { title: "New task" }),
      toolResultJson("toolu_1", { success: true, taskId: "mt#2814" }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(false);
  });

  test("tasks_create failure (no taskId in result) -> false", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, { title: "New task", spec: "x" }),
      toolResultJson("toolu_1", { success: false, message: "--spec must be provided" }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(false);
  });

  // Server-side confirmation (PR #1982 review): a matching taskId alone is
  // not sufficient — the correlated result must also explicitly report
  // success:true. Guards against crediting authorship from a result that
  // merely echoes an id-shaped field without confirming the create actually
  // succeeded.
  test("tasks_create result reports a matching taskId but NOT success:true -> false", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, { title: "New task", spec: "x" }),
      toolResultJson("toolu_1", { taskId: "mt#2814", message: "created" }), // no `success` field
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(false);
  });

  test("tasks_create result has success:false but a (spurious) matching taskId -> false", () => {
    const lines: TranscriptLine[] = [
      assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, { title: "New task", spec: "x" }),
      toolResultJson("toolu_1", { success: false, taskId: "mt#2814" }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(false);
  });

  // Partial-edit decision (mt#2814): a small spec_patch counts in full, no
  // size/count threshold — see the function's docstring and
  // docs/architecture/hooks/bind-advance-spec-read-guard.md for rationale.
  test("a 2-line tasks_spec_patch targeting the task -> true (partial-edit decision)", () => {
    const lines: TranscriptLine[] = [
      assistantToolUse(SPEC_PATCH_TOOL, {
        taskId: "mt#2814",
        content: "// ... existing code ...\nfixed typo\n// ... existing code ...",
      }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(true);
  });

  test("tasks_spec_patch for a DIFFERENT task -> false", () => {
    const lines: TranscriptLine[] = [
      assistantToolUse(SPEC_PATCH_TOOL, { taskId: "mt#9999", content: "x" }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(false);
  });

  test("tasks_spec_search_replace targeting the task -> true", () => {
    const lines: TranscriptLine[] = [
      assistantToolUse(SPEC_SEARCH_REPLACE_TOOL, {
        taskId: "mt#2814",
        search: "old",
        replace: "new",
      }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(true);
  });

  test("tasks_spec_search_replace for a DIFFERENT task -> false", () => {
    const lines: TranscriptLine[] = [
      assistantToolUse(SPEC_SEARCH_REPLACE_TOOL, {
        taskId: "mt#9999",
        search: "old",
        replace: "new",
      }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(false);
  });

  // mt#2558: a same-transcript tasks_edit that rewrites the spec is authorship.
  test("tasks_edit with specContent targeting the task -> true (mt#2558)", () => {
    const lines: TranscriptLine[] = [
      assistantToolUse(TASKS_EDIT_TOOL, {
        taskId: "mt#2814",
        specContent: "## Summary\n\nFull rewritten spec body.",
      }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(true);
  });

  test("tasks_edit with the spec / specFile aliases also counts (mt#2558)", () => {
    const viaSpec: TranscriptLine[] = [
      assistantToolUse(TASKS_EDIT_TOOL, { taskId: "mt#2814", spec: "## Summary\n\nbody" }),
    ];
    const viaSpecFile: TranscriptLine[] = [
      assistantToolUse(TASKS_EDIT_TOOL, { taskId: "mt#2814", specFile: "specs/mt-2814.md" }),
    ];
    expect(specWasAuthored(viaSpec, "mt2814")).toBe(true);
    expect(specWasAuthored(viaSpecFile, "mt2814")).toBe(true);
  });

  test("tasks_edit WITHOUT a spec-writing field (metadata-only) -> false (mt#2558)", () => {
    const lines: TranscriptLine[] = [
      assistantToolUse(TASKS_EDIT_TOOL, { taskId: "mt#2814", status: "READY" }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(false);
  });

  test("tasks_edit with an EMPTY-string specContent -> false (mt#2558)", () => {
    const lines: TranscriptLine[] = [
      assistantToolUse(TASKS_EDIT_TOOL, { taskId: "mt#2814", specContent: "   " }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(false);
  });

  test("tasks_edit with specContent for a DIFFERENT task -> false (mt#2558)", () => {
    const lines: TranscriptLine[] = [
      assistantToolUse(TASKS_EDIT_TOOL, { taskId: "mt#9999", specContent: "## Summary" }),
    ];
    expect(specWasAuthored(lines, "mt2814")).toBe(false);
  });

  test("no authorship action anywhere -> false (regression: reads are NOT authorship)", () => {
    const lines: TranscriptLine[] = [assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#2814" })];
    expect(specWasAuthored(lines, "mt2814")).toBe(false);
  });

  test("empty target -> false", () => {
    const lines: TranscriptLine[] = [
      assistantToolUse(SPEC_PATCH_TOOL, { taskId: "mt#2814", content: "x" }),
    ];
    expect(specWasAuthored(lines, "")).toBe(false);
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

// ---------------------------------------------------------------------------
// specWasSurfacedInAnyTranscript — same-transcript authorship credit (mt#2814)
//
// These mirror the mt#2814 spec's Acceptance Tests verbatim:
//   1. tasks_create with full spec for mt#X, then tasks_status_set(mt#X,
//      READY) in the SAME transcript -> allowed.
//   2. A 2-line tasks_spec_patch to mt#X, authored in THIS transcript ->
//      allowed (the partial-edit decision: any same-transcript patch counts).
//   3. No spec interaction for mt#X anywhere -> still blocked (regression,
//      already covered above; re-asserted here through the combined check).
//   4. Authorship recorded in a DIFFERENT session's transcript tree (never a
//      candidate for THIS session's scan) does NOT satisfy the check — the
//      spec's explicit carve-out: "fires where the agent authored the spec
//      in a DIFFERENT session ... and never re-read it should STILL block."
// ---------------------------------------------------------------------------

describe("specWasSurfacedInAnyTranscript — same-transcript authorship credit (mt#2814)", () => {
  test("acceptance test 1: tasks_create with full spec, then advance in the same transcript -> allowed", () => {
    const parentPath = buildTranscriptTree(
      [
        userPrompt("file the gap-analysis subtasks"),
        assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, {
          title: "Gap-analysis subtask",
          spec: "## Summary\n\nFull spec body for the new task.",
        }),
        toolResultJson("toolu_1", { success: true, taskId: "mt#2814" }),
        userPrompt("bring it to READY"),
        // current tool call (tasks_status_set READY) fires now; not yet in transcript
      ],
      {}
    );
    expect(specWasSurfacedInAnyTranscript(parentPath, undefined, "mt2814")).toBe(true);
  });

  test("acceptance test 2: a 2-line tasks_spec_patch authored in this transcript -> allowed (partial-edit decision)", () => {
    const parentPath = buildTranscriptTree(
      [
        userPrompt("fix the typo in mt#2814's spec"),
        assistantToolUse(SPEC_PATCH_TOOL, {
          taskId: "mt#2814",
          content: "// ... existing code ...\nfixed typo\n// ... existing code ...",
        }),
        userPrompt("now advance it"),
      ],
      {}
    );
    expect(specWasSurfacedInAnyTranscript(parentPath, undefined, "mt2814")).toBe(true);
  });

  test("mt#2558: tasks_edit rewriting the spec (specContent) in this transcript, then advance -> allowed", () => {
    const parentPath = buildTranscriptTree(
      [
        userPrompt("rewrite mt#2814's spec"),
        assistantToolUse(TASKS_EDIT_TOOL, {
          taskId: "mt#2814",
          specContent: "## Summary\n\nFull rewritten spec body.",
        }),
        userPrompt("now bring it to READY"),
      ],
      {}
    );
    expect(specWasSurfacedInAnyTranscript(parentPath, undefined, "mt2814")).toBe(true);
  });

  test("acceptance test 3 (regression): no spec interaction anywhere -> still blocked", () => {
    const parentPath = buildTranscriptTree(
      [userPrompt("ship it"), assistantToolUse(MEMORY_SEARCH_TOOL, { query: "unrelated" })],
      {}
    );
    expect(specWasSurfacedInAnyTranscript(parentPath, undefined, "mt2814")).toBe(false);
  });

  test("acceptance test 4: authorship in a DIFFERENT session's transcript tree does NOT satisfy this session's check", () => {
    // A prior session authored mt#2814's spec via tasks_create — but that
    // transcript tree is never a candidate for a LATER, separate session's
    // scan (resolveTranscriptCandidates only walks the given transcript's own
    // tree). The spec's explicit carve-out (bdf8f782's mt#2738 fire): cross-
    // session authorship must NOT be credited.
    buildTranscriptTree(
      [
        assistantToolUseWithId("toolu_1", TASKS_CREATE_TOOL, {
          title: "mt#2814's original author session",
          spec: "## Summary\n\nAuthored in a prior, unrelated session.",
        }),
        toolResultJson("toolu_1", { success: true, taskId: "mt#2814" }),
      ],
      {}
    );
    // The CURRENT session's own transcript tree never engaged mt#2814 at all.
    const currentSessionPath = buildTranscriptTree(
      [userPrompt("bind to mt#2814"), assistantToolUse(MEMORY_SEARCH_TOOL, { query: "unrelated" })],
      {}
    );
    expect(specWasSurfacedInAnyTranscript(currentSessionPath, undefined, "mt2814")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The ask seam (mt#4551) — advisory
// ---------------------------------------------------------------------------

/**
 * `ask#10163`'s pre-edit payload, reconstructed from the ask record's
 * `metadata.originalContent`. The option label naming mt#3473 is verbatim; the
 * question and the other options are trimmed to what the extractor reads.
 */
function ask10163Payload(): Record<string, unknown> {
  return {
    title: "Reviewer bot is ~98% of the OpenAI bill — pick which quality tradeoff to make",
    question:
      "Pick which review-quality tradeoff to make to cut reviewer spend — or decide not to.\n\n" +
      "My recommendation, derived this turn and not carried from any prior ask: the triage pilot.",
    options: [
      {
        label: "Build the cheap-model triage pilot (mt#3473)",
        description:
          "You approved this log-only at ask#6603 and it was never built. No quality risk now.",
      },
      {
        label: "Accept ~$660/mo and stop optimizing here",
        description: "Per-review cost is flat.",
      },
    ],
    contextRefs: [
      { ref: "mt#2718", kind: "task", description: "Reviewer cost umbrella" },
      { ref: "mt#3473", kind: "task", description: "The cheap-model triage pilot, still unbuilt" },
    ],
  };
}

describe("extractAskTaskIds", () => {
  test("reads the question, option label/description, and contextRefs — deduped, first spelling wins", () => {
    const ids = extractAskTaskIds(ask10163Payload());
    // mt#3473 appears in an option label AND a contextRef; mt#2718 only in a contextRef.
    expect(ids).toEqual(["mt#3473", "mt#2718"]);
  });

  test("reads an id from the question alone", () => {
    expect(extractAskTaskIds({ question: "Should we still do mt#3473?" })).toEqual(["mt#3473"]);
  });

  test("reads an id from an option DESCRIPTION, not only its label", () => {
    const ids = extractAskTaskIds({
      options: [{ label: "Ship it", description: "This is the work md#42 describes." }],
    });
    expect(ids).toEqual(["md#42"]);
  });

  test("accepts a bare-string contextRefs entry as well as an object", () => {
    expect(extractAskTaskIds({ contextRefs: ["mt#900", { ref: "mt#901" }] })).toEqual([
      "mt#900",
      "mt#901",
    ]);
  });

  test("AT5: an ask naming no task yields no ids, so no transcript work is done", () => {
    expect(
      extractAskTaskIds({
        question: "Should the cockpit use a chart library?",
        options: [{ label: "Yes", description: "Adds a dependency." }],
        contextRefs: [
          { ref: "ask#6603", kind: "ask" },
          { ref: "mem#1255", kind: "memory" },
        ],
      })
    ).toEqual([]);
  });

  test("parentTaskId is deliberately NOT read — it names where the ask was filed FROM", () => {
    expect(extractAskTaskIds({ parentTaskId: "mt#2718", question: "Which way?" })).toEqual([]);
  });

  test("malformed payload shapes never throw", () => {
    expect(extractAskTaskIds({})).toEqual([]);
    expect(extractAskTaskIds({ question: 42, options: "nope", contextRefs: null })).toEqual([]);
    expect(extractAskTaskIds({ options: [null, 7, { label: null }] })).toEqual([]);
    expect(extractAskTaskIds({ contextRefs: [null, 7, { ref: {} }] })).toEqual([]);
  });

  test("PR #3327 R1: extracts the hyphen and underscore spellings, not just the hash form", () => {
    expect(extractAskTaskIds({ question: "Should we resume mt-3473?" })).toEqual(["mt-3473"]);
    expect(extractAskTaskIds({ question: "branch task/mt_3473 is stale" })).toEqual(["mt_3473"]);
    expect(extractAskTaskIds({ options: [{ label: "Rebase MT-3473", description: "" }] })).toEqual([
      "MT-3473",
    ]);
  });

  test("PR #3327 R1: extracts the bare spelling at three digits or more", () => {
    expect(extractAskTaskIds({ question: "resume mt3473 now" })).toEqual(["mt3473"]);
    expect(extractAskTaskIds({ question: "resume mt390 now" })).toEqual(["mt390"]);
  });

  test("PR #3327 R1: the bare form's three-digit floor keeps md5 out", () => {
    // MEASURED, not chosen: all four `md`+1-digit bare matches across the
    // 10,201-ask corpus are literally `md5` / `MD5`, the hash algorithm. Real
    // task ids run 1-4 digits with exactly ONE at or below 2, so the floor
    // drops the whole observed false-positive class for one task's bare
    // spelling. The SEPARATED forms carry no such ambiguity and have no floor.
    expect(extractAskTaskIds({ question: "hash the payload with md5 first" })).toEqual([]);
    expect(extractAskTaskIds({ question: "MD5 is not a task" })).toEqual([]);
    expect(extractAskTaskIds({ question: "mt5 is ambiguous bare" })).toEqual([]);
    // ...but the same id WITH a delimiter is unambiguous and does match.
    expect(extractAskTaskIds({ question: "md#5 is a task" })).toEqual(["md#5"]);
    expect(extractAskTaskIds({ question: "mt-5 is a task" })).toEqual(["mt-5"]);
  });

  test("PR #3327 R1: spellings of the SAME id dedupe to one entry", () => {
    // normalizeTaskId collapses all four, so an ask naming a task in prose and
    // again as a branch must not advise about it twice.
    expect(
      extractAskTaskIds({
        question: "mt#3473 — see branch task/mt-3473",
        options: [{ label: "resume mt3473", description: "mt_3473" }],
      })
    ).toEqual(["mt#3473"]);
  });

  test("caps extraction at MAX_ASK_TASK_REFS distinct ids", () => {
    const many = Array.from({ length: MAX_ASK_TASK_REFS + 10 }, (_, i) => `mt#${9000 + i}`).join(
      " "
    );
    expect(extractAskTaskIds({ question: many })).toHaveLength(MAX_ASK_TASK_REFS);
  });
});

describe("the ask tools never reach the deny path", () => {
  test("resolveTargetTaskId returns '' for asks_create / asks_edit", () => {
    // Guarantees the advisory branch is the ONLY way an ask is handled: if the
    // branch were ever removed, these would fall through to a silent allow
    // rather than to a deny.
    expect(resolveTargetTaskId(ASKS_CREATE_TOOL, ask10163Payload())).toBe("");
    expect(resolveTargetTaskId(ASKS_EDIT_TOOL, ask10163Payload())).toBe("");
  });
});

describe("unreadAskTaskIds", () => {
  test("AT1: the ask#10163 replay — mt#3473 is named, and the 14 tasks the session DID read are not", () => {
    // The real filing conversation made 20 spec-surfacing reads across 14
    // distinct task ids; mt#3473 was not among them. mt#2718 WAS read, which
    // is where the stale "approved … never built" prose came from.
    const readIds = [
      "mt#2290",
      "mt#2447",
      "mt#2544",
      "mt#2718",
      "mt#3526",
      "mt#3654",
      "mt#3659",
      "mt#4178",
      "mt#4386",
      "mt#4439",
      "mt#4443",
      "mt#4449",
      "mt#4454",
      "mt#4485",
    ];
    const parentPath = buildTranscriptTree(
      [
        userPrompt("re-derive the reviewer cost numbers"),
        ...readIds.map((id) => assistantToolUse(SPEC_GET_TOOL, { taskId: id })),
        toolResult(),
        userPrompt("file the ask"),
      ],
      {}
    );

    const ids = extractAskTaskIds(ask10163Payload());
    expect(unreadAskTaskIds(parentPath, undefined, ids)).toEqual(["mt#3473"]);
  });

  test("AT2 (negative control, READ): the same ask with mt#3473's spec read does not fire", () => {
    const parentPath = buildTranscriptTree(
      [
        assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#2718" }),
        assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#3473" }),
      ],
      {}
    );
    expect(unreadAskTaskIds(parentPath, undefined, extractAskTaskIds(ask10163Payload()))).toEqual(
      []
    );
  });

  test("AT3 (negative control, AUTHORED): a same-transcript tasks_spec_patch counts as engagement", () => {
    const parentPath = buildTranscriptTree(
      [
        assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#2718" }),
        assistantToolUse(SPEC_PATCH_TOOL, {
          taskId: "mt#3473",
          content: "// ... existing code ...\n\nBanner added.",
        }),
      ],
      {}
    );
    expect(unreadAskTaskIds(parentPath, undefined, extractAskTaskIds(ask10163Payload()))).toEqual(
      []
    );
  });

  test("AT4: a multi-id ask names EVERY unread id, not just the first", () => {
    const parentPath = buildTranscriptTree(
      [assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#2718" })],
      {}
    );
    const unread = unreadAskTaskIds(parentPath, undefined, ["mt#3473", "mt#2718", "mt#3548"]);
    expect(unread).toEqual(["mt#3473", "mt#3548"]);
  });

  test("credits a read recorded in a dispatched subagent's transcript", () => {
    const parentPath = buildTranscriptTree([userPrompt("file the ask")], {
      [AGENT_ABC_FILE]: [assistantToolUse(SPEC_GET_TOOL, { taskId: "mt#3473" })],
    });
    expect(unreadAskTaskIds(parentPath, "abc123", ["mt#3473"])).toEqual([]);
  });

  test("a differently-spelled id still matches the read (mt-3473 vs mt#3473)", () => {
    const parentPath = buildTranscriptTree(
      [assistantToolUse(SPEC_GET_TOOL, { taskId: "mt-3473" })],
      {}
    );
    expect(unreadAskTaskIds(parentPath, undefined, ["mt#3473"])).toEqual([]);
  });

  test("an empty id list does no transcript work and returns nothing", () => {
    expect(unreadAskTaskIds("/nonexistent/path.jsonl", undefined, [])).toEqual([]);
  });

  test("a PRESENT but unreadable transcript path reports every id unread — matching the deny leg", () => {
    // Measured against the shipped guard, not assumed: an ABSENT
    // `transcript_path` is the only fail-open (both legs return before the
    // scan). A path that is present and does not resolve reads as "nothing was
    // surfaced", so the deny leg DENIES and this leg advises. Pinned here
    // because the criterion this test discharges originally claimed the
    // unreadable case failed open, and it does not.
    expect(unreadAskTaskIds(MISSING_TRANSCRIPT_PATH, undefined, ["mt#3473"])).toEqual(["mt#3473"]);
  });
});

describe("buildAskAdvisoryReason", () => {
  test("names every unread id and states plainly that the call is not blocked", () => {
    const message = buildAskAdvisoryReason(ASKS_CREATE_TOOL, ["mt#3473", "mt#3548"]);
    expect(message).toContain("mt#3473");
    expect(message).toContain("mt#3548");
    expect(message).toContain("filing an ask");
    expect(message).toContain("NOT blocked");
    expect(message).toContain(OVERRIDE_ENV_VAR);
    // The advisory must NOT read as a denial — that is the whole posture choice.
    expect(message).not.toContain("permissionDecision");
  });

  test("agrees in number for a single unread id", () => {
    const message = buildAskAdvisoryReason(ASKS_CREATE_TOOL, ["mt#3473"]);
    expect(message).toContain("that task's spec");
    expect(message).not.toContain("those tasks' specs");
  });

  test("asks_edit is described as editing, not filing", () => {
    const message = buildAskAdvisoryReason(ASKS_EDIT_TOOL, ["mt#3473"]);
    expect(message).toContain("editing an ask");
    expect(message).not.toContain("filing an ask");
  });
});

// ---------------------------------------------------------------------------
// The CLI evidence channel (mt#4380)
// ---------------------------------------------------------------------------
//
// Tested against the REAL generated manifest rather than a synthetic one: the whole point of
// resolving through `src/generated/completion-manifest.json` is that the accepted spellings track
// the shipped CLI, so a fixture manifest would assert only that the parser works on a fixture. If
// `tasks spec get` is ever renamed, these fail — which is the coupling we want.

const MANIFEST = readManifest();
// Fail loudly at import rather than letting every case below pass vacuously against a null: the
// CLI channel is inert without the manifest, so a missing one would make these tests agree with a
// guard that credits nothing at all (mem#1237 — a check that cannot tell the broken state from the
// healthy one is not evidence of coverage).
if (!MANIFEST) {
  throw new Error(
    "src/generated/completion-manifest.json is unreadable — the mt#4380 CLI-channel tests cannot run"
  );
}

/** The canonical CLI spec read for the target task, reused across cases. */
const CLI_SPEC_GET_TARGET = "minsky tasks spec get mt#4311";

/** A `Bash` tool_use carrying a shell command — the shape the harness records. */
function bashCommand(command: string): TranscriptLine {
  return assistantToolUse("Bash", { command });
}

/** The same, on the in-session shell surface. */
function sessionExecCommand(command: string): TranscriptLine {
  return assistantToolUse("mcp__minsky__session_exec", { command });
}

const TARGET = normalizeTaskId("mt#4311");
const OTHER = normalizeTaskId("mt#9999");

describe("cliSpecEngagements (mt#4380)", () => {
  // PR #3393 R1 (non-blocking findings 1 and 2): the command IDs resolve through the generated
  // manifest, but which flags mean "spec read" / "spec authorship" is a policy set this module
  // holds by hand — the manifest lists a command's options without marking any of them as
  // spec-writing, and the semantic is not derivable from it. What IS derivable, and what these
  // assertions pin, is that each flag we name still EXISTS on its command. That converts the
  // drift the reviewer identified from a silent regression of this very fix — a renamed
  // `--include-spec` would just stop crediting that channel, with every test still green — into
  // a failing test naming the flag. The MCP side carries the same policy set in
  // `editHasSpecContent`; the two are meant to move together.
  test("every flag this module names still exists on its command in the manifest", () => {
    const flagsOf = (commandId: string): string[] => {
      const argv = commandId.split(".");
      const { node } = resolveCommandNode(MANIFEST, argv);
      expect(node.commandId, `manifest has no leaf for ${commandId}`).toBe(commandId);
      return (node.options ?? []).flatMap((o) => o.flags ?? []);
    };

    expect(flagsOf("tasks.get")).toContain("--include-spec");
    for (const flag of ["--spec", "--spec-file", "--spec-content"]) {
      expect(flagsOf("tasks.edit")).toContain(flag);
    }
    // `tasks.spec.get` is credited unconditionally, so it needs no flag — only the leaf itself.
    expect(resolveCommandNode(MANIFEST, ["tasks", "spec", "get"]).node.commandId).toBe(
      "tasks.spec.get"
    );
  });

  test("resolves a spec read to its command id and task id", () => {
    expect(cliSpecEngagements(CLI_SPEC_GET_TARGET, MANIFEST)).toEqual([
      { kind: "read", taskId: TARGET },
    ]);
  });

  test("recovers the task id when a boolean flag PRECEDES it", () => {
    // The manifest walk consumes a token after an unrecognised flag; parsing `rest` against the
    // LEAF's option table is what keeps `--json` from swallowing the id.
    expect(cliSpecEngagements("minsky tasks spec get --json mt#4311", MANIFEST)).toEqual([
      { kind: "read", taskId: TARGET },
    ]);
  });

  test("recovers the task id when a value-taking flag follows it", () => {
    expect(cliSpecEngagements("minsky tasks spec get mt#4311 --section Summary", MANIFEST)).toEqual(
      [{ kind: "read", taskId: TARGET }]
    );
  });

  test("a global flag before the subcommand does not break the walk", () => {
    expect(cliSpecEngagements("minsky --json tasks spec get mt#4311", MANIFEST)).toEqual([
      { kind: "read", taskId: TARGET },
    ]);
  });

  test("finds an invocation inside a chained, piped command", () => {
    expect(
      cliSpecEngagements("cd /tmp && minsky tasks spec get mt#4311 | head -5", MANIFEST)
    ).toEqual([{ kind: "read", taskId: TARGET }]);
  });

  test("all three tasks-edit spec flags are authorship, in both spellings", () => {
    for (const command of [
      "minsky tasks edit mt#4311 --spec-file /tmp/s.md",
      "minsky tasks edit mt#4311 --spec-file=/tmp/s.md",
      "minsky tasks edit mt#4311 --spec-content 'body'",
      "minsky tasks edit mt#4311 --spec",
    ]) {
      expect(cliSpecEngagements(command, MANIFEST)).toEqual([{ kind: "authored", taskId: TARGET }]);
    }
  });

  test("a metadata-only tasks edit is NOT authorship", () => {
    // Mirrors editHasSpecContent: --kind / --title / --tag carry no spec body.
    expect(cliSpecEngagements("minsky tasks edit mt#4311 --kind implementation", MANIFEST)).toEqual(
      []
    );
    expect(cliSpecEngagements("minsky tasks edit mt#4311 --title Renamed", MANIFEST)).toEqual([]);
  });

  test("tasks get counts only with --include-spec", () => {
    expect(cliSpecEngagements("minsky tasks get mt#4311 --include-spec", MANIFEST)).toEqual([
      { kind: "read", taskId: TARGET },
    ]);
    expect(cliSpecEngagements("minsky tasks get mt#4311", MANIFEST)).toEqual([]);
  });

  test("a non-Minsky command that merely looks like one yields nothing", () => {
    expect(cliSpecEngagements("othertool tasks spec get mt#4311", MANIFEST)).toEqual([]);
    expect(cliSpecEngagements("ls -la /tmp", MANIFEST)).toEqual([]);
  });

  test("an invocation with no task id yields nothing rather than a fabricated one", () => {
    expect(cliSpecEngagements("minsky tasks spec get", MANIFEST)).toEqual([]);
    expect(cliSpecEngagements("minsky tasks spec get --json", MANIFEST)).toEqual([]);
  });
});

describe("specWasSurfaced / specWasAuthored — CLI channel (mt#4380)", () => {
  test("AT1 — a transcript whose only engagement is a CLI spec read counts as read", () => {
    for (const command of [
      CLI_SPEC_GET_TARGET,
      "bun run src/cli.ts tasks spec get mt#4311",
      "/Users/someone/.bun/bin/minsky tasks spec get mt#4311",
    ]) {
      expect(specWasSurfaced([bashCommand(command)], TARGET)).toBe(true);
    }
  });

  test("AT2 — a transcript whose only engagement is a CLI spec edit counts as authored", () => {
    const lines = [bashCommand("minsky tasks edit mt#4311 --spec-file /tmp/s.md")];
    expect(specWasAuthored(lines, TARGET)).toBe(true);
    // It is authorship, not a read — the same split the MCP predicates draw.
    expect(specWasSurfaced(lines, TARGET)).toBe(false);
  });

  test("the in-session shell surface counts too, not just Bash", () => {
    expect(specWasSurfaced([sessionExecCommand(CLI_SPEC_GET_TARGET)], TARGET)).toBe(true);
  });

  test("AT3 — a transcript with no spec engagement through ANY channel still fails both", () => {
    const lines = [
      userPrompt("let's start on something"),
      bashCommand("ls -la"),
      assistantToolUse(MEMORY_SEARCH_TOOL, { query: "anything" }),
    ];
    expect(specWasSurfaced(lines, TARGET)).toBe(false);
    expect(specWasAuthored(lines, TARGET)).toBe(false);
  });

  test("AT5 — a CLI spec read of a DIFFERENT task does not discharge the target", () => {
    // The negative control against widening into a pass-through. Its inverse is asserted in the
    // same test so the `false` cannot be satisfied by a channel that credits nothing at all
    // (mem#812: a widened relation's inverse is where the old behaviour survives).
    const lines = [bashCommand("minsky tasks spec get mt#9999")];
    expect(specWasSurfaced(lines, TARGET)).toBe(false);
    expect(specWasSurfaced(lines, OTHER)).toBe(true);
  });

  test("AT5 — a CLI spec EDIT of a different task does not discharge the target either", () => {
    const lines = [bashCommand("minsky tasks edit mt#9999 --spec-file /tmp/s.md")];
    expect(specWasAuthored(lines, TARGET)).toBe(false);
    expect(specWasAuthored(lines, OTHER)).toBe(true);
  });

  test("id spellings collapse the same way they do on the MCP side", () => {
    for (const spelling of ["mt#4311", "mt-4311", "MT#4311"]) {
      expect(specWasSurfaced([bashCommand(`minsky tasks spec get ${spelling}`)], TARGET)).toBe(
        true
      );
    }
  });

  test("a Bash record with no command string is skipped, not crashed on", () => {
    const lines = [assistantToolUse("Bash", { description: "no command key" })];
    expect(specWasSurfaced(lines, TARGET)).toBe(false);
  });

  test("an empty target id is never discharged by a CLI read", () => {
    expect(specWasSurfaced([bashCommand(CLI_SPEC_GET_TARGET)], "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The falsified-premise leg (mt#4561)
// ---------------------------------------------------------------------------
//
// AT1 ("a /plan-task run recording a gate-(o) failure produces the marker") is
// not represented here: the emitter is skill PROSE the agent follows, so there
// is no function to call. What IS mechanised is the READ, and that is what the
// tests below cover — the asymmetry the task's own Summary argues for.

const BANNER_LINE =
  `> **${FALSIFIED_BANNER_TOKEN} — 2026-08-27.** Gate (o) did not reproduce the cause this\n` +
  "> spec asserts. Evidence: `## Gap Report (PLANNING — not yet READY)`.\n";

describe("specCarriesFalsifiedBanner (mt#4561)", () => {
  test("fires on a banner in the spec's top block", () => {
    const spec = `${BANNER_LINE}\n## Summary\n\nSomething.\n`;
    expect(specCarriesFalsifiedBanner(spec)).toBe(true);
  });

  test("AT3: does NOT fire when the token sits BELOW the first heading — another task's verdict", () => {
    // 32 of the 94 measured phrase-set fires sat on a line naming a DIFFERENT
    // task. Position, not a matcher, is what excludes them.
    const spec = [
      "## Summary",
      "",
      "This task is fine.",
      "",
      "## Context",
      "",
      `mt#2718 carries a ${FALSIFIED_BANNER_TOKEN} banner, which is why we are not building on it.`,
      "",
      `mt#3659 does too.`,
      "",
    ].join("\n");
    expect(specCarriesFalsifiedBanner(spec)).toBe(false);
  });

  test("AT4 (negative control): a banner quoted inside a fence at the top does not fire", () => {
    const fence = "```";
    const spec = [
      "Some preamble describing the convention:",
      "",
      fence,
      `> **${FALSIFIED_BANNER_TOKEN} — 2026-08-27.** ...`,
      fence,
      "",
      "## Summary",
      "",
    ].join("\n");
    expect(specCarriesFalsifiedBanner(spec)).toBe(false);
  });

  test("AT2: does NOT fire on the four measured prose false positives", () => {
    // Each is a live directive about PART of a task, which the rejected phrase
    // set could not separate from a verdict on the whole task.
    const proseFalsePositives = [
      "## Scope\n\nOut of scope … do not implement the sibling's half here.",
      "## Scope\n\ndo not build independently of the sibling embeddings tasks",
      "## Summary\n\nDo NOT build a second symbol-matching layer.",
      "## Context\n\n(already decided, do not re-open)",
    ];
    for (const spec of proseFalsePositives) {
      expect(specCarriesFalsifiedBanner(spec)).toBe(false);
    }
  });

  test("an empty or absent body never fires", () => {
    expect(specCarriesFalsifiedBanner("")).toBe(false);
    expect(specCarriesFalsifiedBanner("## Summary\n\nnothing here\n")).toBe(false);
  });

  test("a spec that is ONLY a banner, with no headings at all, still fires", () => {
    expect(specCarriesFalsifiedBanner(BANNER_LINE)).toBe(true);
  });
});

describe("extractSpecBody (mt#4561)", () => {
  test("unwraps the MCP JSON envelope's content field", () => {
    const body = `${BANNER_LINE}\n## Summary\n`;
    expect(extractSpecBody(JSON.stringify({ success: true, content: body }))).toBe(body);
  });

  test("falls through to the raw text for the CLI spelling", () => {
    const body = "## Summary\n\nplain markdown, not JSON\n";
    expect(extractSpecBody(body)).toBe(body);
  });

  test("a malformed body does not throw", () => {
    expect(extractSpecBody("{ not json")).toBe("{ not json");
    expect(extractSpecBody("")).toBe("");
  });

  test("JSON without a string content field falls through rather than yielding undefined", () => {
    const raw = JSON.stringify({ success: true, content: 42 });
    expect(extractSpecBody(raw)).toBe(raw);
  });
});

describe("falsifiedAskTaskIds (mt#4561)", () => {
  test("flags an id whose spec THIS SESSION READ carries the banner", () => {
    const parentPath = buildTranscriptTree(
      [
        assistantToolUseWithId("call-1", SPEC_GET_TOOL, { taskId: "mt#3473" }),
        toolResultJson("call-1", {
          success: true,
          content: `${BANNER_LINE}\n## Summary\n\nThe killed pilot.\n`,
        }),
      ],
      {}
    );
    expect(falsifiedAskTaskIds(parentPath, undefined, ["mt#3473"])).toEqual(["mt#3473"]);
  });

  test("does NOT flag an id whose read spec carries no banner", () => {
    const parentPath = buildTranscriptTree(
      [
        assistantToolUseWithId("call-1", SPEC_GET_TOOL, { taskId: "mt#2718" }),
        toolResultJson("call-1", { success: true, content: "## Summary\n\nAlive and well.\n" }),
      ],
      {}
    );
    expect(falsifiedAskTaskIds(parentPath, undefined, ["mt#2718"])).toEqual([]);
  });

  test("a read with no correlated result is not read as a clean spec", () => {
    // hasResult false must not be treated as \"no banner\" — that is the
    // empty-vs-never-returned distinction findToolCallsWithResults carries.
    const parentPath = buildTranscriptTree(
      [assistantToolUseWithId("call-1", SPEC_GET_TOOL, { taskId: "mt#3473" })],
      {}
    );
    expect(falsifiedAskTaskIds(parentPath, undefined, ["mt#3473"])).toEqual([]);
  });

  test("an id the session never read is not flagged — that is the sibling leg's case", () => {
    const parentPath = buildTranscriptTree(
      [
        assistantToolUseWithId("call-1", SPEC_GET_TOOL, { taskId: "mt#2718" }),
        toolResultJson("call-1", { success: true, content: "## Summary\n\nfine\n" }),
      ],
      {}
    );
    expect(falsifiedAskTaskIds(parentPath, undefined, ["mt#3473"])).toEqual([]);
  });

  test("no ids means no transcript work", () => {
    expect(falsifiedAskTaskIds(MISSING_TRANSCRIPT_PATH, undefined, [])).toEqual([]);
  });
});

describe("buildFalsifiedAdvisoryReason (mt#4561)", () => {
  test("names the task, says it is advisory, and names the override", () => {
    const reason = buildFalsifiedAdvisoryReason(ASKS_CREATE_TOOL, ["mt#3473"]);
    expect(reason).toContain("mt#3473");
    expect(reason).toContain("filing an ask that names");
    expect(reason).toContain("FALSIFIED PROBLEM STATEMENT");
    expect(reason).toContain("NOT blocked");
    expect(reason).toContain(OVERRIDE_ENV_VAR);
  });

  test("the edit spelling names editing rather than filing", () => {
    expect(buildFalsifiedAdvisoryReason(ASKS_EDIT_TOOL, ["mt#3473"])).toContain(
      "editing an ask that names"
    );
  });

  test("pluralises for several ids", () => {
    const reason = buildFalsifiedAdvisoryReason(ASKS_CREATE_TOOL, ["mt#3473", "mt#4072"]);
    expect(reason).toContain("their specs carry");
    expect(reason).toContain("mt#3473, mt#4072");
  });
});
