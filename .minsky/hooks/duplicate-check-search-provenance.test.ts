/**
 * mt#4004 — a duplicate-check record claiming a search that never ran.
 *
 * The discriminating assertions are the pair at the end: the SAME spec produces
 * a warning in a session with no search call and none in a session that has one.
 * Everything before them exists to bound the trigger, because this guard's whole
 * value rests on not crying wolf at the one moment an author is filing work.
 */
import { describe, test, expect } from "bun:test";
import type { DispatchContext } from "./registry";
import type { ToolHookInput } from "./types";
import type { TranscriptLine } from "./transcript";
import {
  NO_CANDIDATES_LINE,
  claimsASearch,
  extractDuplicateCheckRecord,
  run,
  sessionRanASearch,
} from "./duplicate-check-search-provenance";

const CLAIMING_SPEC = `## Summary

Something.

## Context

**Duplicate check:** searched \`tasks_search\` for "widget frobnication" across all
statuses. Candidates: mt#1 (confirm-orthogonal, different subsystem).
`;

/** The MCP-prefixed spelling, named once so the two call sites cannot drift. */
const SEARCH_TOOL = "mcp__minsky__tasks_search";

/** A transcript line carrying one assistant tool_use block. */
function toolCallLine(name: string): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] },
  } as unknown as TranscriptLine;
}

function ctxWith(lines: TranscriptLine[]): DispatchContext {
  return { transcriptLines: lines } as unknown as DispatchContext;
}

function inputWith(spec: string): ToolHookInput {
  return {
    session_id: "sess-mt4004",
    tool_input: { title: "a task", spec },
  } as unknown as ToolHookInput;
}

describe("extractDuplicateCheckRecord", () => {
  test("reads only the record's own paragraph, not the whole spec", () => {
    const record = extractDuplicateCheckRecord(CLAIMING_SPEC);
    expect(record).toContain("searched");
    expect(record).not.toContain("## Summary");
  });

  test("returns null when no record is present — that case belongs to the deny gate", () => {
    expect(extractDuplicateCheckRecord("## Summary\n\nNo record here.\n")).toBeNull();
  });

  test("tolerates the bulleted and bolded forms specs are actually written in", () => {
    expect(extractDuplicateCheckRecord("- **Duplicate check:** searched X\n")).not.toBeNull();
  });
});

describe("claimsASearch", () => {
  test("past-tense provenance is a claim", () => {
    expect(claimsASearch("Duplicate check: searched tasks_search for foo.")).toBe(true);
    expect(claimsASearch("Duplicate check: queried the task graph for foo.")).toBe(true);
    expect(claimsASearch("Duplicate check: cross-referenced mt#1 and mt#2.")).toBe(true);
  });

  test("the sanctioned no-candidates line is NOT a claim", () => {
    // It reports an outcome rather than asserting an action. Firing here would
    // punish the one form the corpus explicitly prescribes.
    expect(claimsASearch(NO_CANDIDATES_LINE)).toBe(false);
  });

  test("an instruction to search is not a claim to have searched", () => {
    // Tense is the discriminator and has to carry weight: specs quote the
    // requirement as often as they satisfy it.
    expect(claimsASearch("Duplicate check: run tasks_search before filing this.")).toBe(false);
  });
});

describe("sessionRanASearch", () => {
  test("matches the MCP-prefixed, bare, and underscore-alias spellings", () => {
    expect(sessionRanASearch(["mcp__minsky__tasks_search"])).toBe(true);
    expect(sessionRanASearch(["tasks_similar"])).toBe(true);
    expect(sessionRanASearch(["tasks.search"])).toBe(true);
  });

  test("refs_status counts — cross-referencing ids is a search of the task graph", () => {
    expect(sessionRanASearch(["mcp__minsky__refs_status"])).toBe(true);
  });

  test("an unrelated tool does not", () => {
    expect(sessionRanASearch(["mcp__minsky__tasks_create", "Bash"])).toBe(false);
  });
});

describe("run", () => {
  test("AT1: a claimed search with no call in the session produces a calibration record", () => {
    const outcome = run(inputWith(CLAIMING_SPEC), ctxWith([toolCallLine("Bash")]));
    expect(outcome?.calibration?.outcome).toBe("matched");
    expect(outcome?.additionalContext).toContain("no `tasks_search`");
  });

  test("AT2: the SAME spec is clean when the session did call tasks_search", () => {
    // The pair that matters. Identical input, different session state, opposite
    // outcome — which is the only way to show the guard reads the session at all
    // rather than pattern-matching the prose twice.
    const outcome = run(
      inputWith(CLAIMING_SPEC),
      ctxWith([toolCallLine(SEARCH_TOOL), toolCallLine("Bash")])
    );
    expect(outcome?.calibration?.outcome).toBe("clean");
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("AT3: the sanctioned no-candidates form is clean in either session state", () => {
    const spec = `## Context\n\n${NO_CANDIDATES_LINE}\n`;
    for (const lines of [[toolCallLine("Bash")], [toolCallLine(SEARCH_TOOL)]]) {
      const outcome = run(inputWith(spec), ctxWith(lines));
      expect(outcome?.calibration?.outcome).toBe("clean");
      expect(outcome?.additionalContext).toBeUndefined();
    }
  });

  test("AT4: it never denies, on any input", () => {
    // Asserted rather than intended. ADR-024 rung-1 posture is a property of the
    // shipped code, and a guard that could deny would be a different rung.
    const outcome = run(inputWith(CLAIMING_SPEC), ctxWith([toolCallLine("Bash")]));
    expect(outcome?.deny).toBeUndefined();
  });

  test("an unavailable transcript records SKIPPED, never clean", () => {
    // A claim that cannot be adjudicated must not read as a pass — otherwise a
    // sustained outage looks like a run of correct behavior.
    const outcome = run(inputWith(CLAIMING_SPEC), ctxWith([]));
    expect(outcome?.calibration?.outcome).toBe("skipped");
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("a spec with no duplicate-check record at all is left to the deny gate", () => {
    const outcome = run(inputWith("## Summary\n\nNothing.\n"), ctxWith([toolCallLine("Bash")]));
    expect(outcome?.calibration?.outcome).toBe("clean");
  });
});
