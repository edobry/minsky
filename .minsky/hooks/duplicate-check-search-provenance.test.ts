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
import {
  extractNamedQueries,
  queryTokenCoverage,
  sessionSearchQueries,
} from "./evidence-provenance-table";

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

  test("an instruction naming the tool WITH a target is still an instruction (R1)", () => {
    // The hole PR #2886 R1 found: an earlier pattern matched a bare tool name
    // followed by for/over/across, so this imperative read as provenance —
    // inverting the module's own stated discriminator.
    expect(claimsASearch("Duplicate check: run `tasks_search` for duplicates before filing.")).toBe(
      false
    );
    expect(claimsASearch("Duplicate check: search tasks_similar across all statuses.")).toBe(false);
  });

  test("instruction beats claim when a record contains both", () => {
    // A spec that quotes the requirement AND satisfies it should not fire; the
    // asymmetry is deliberate, since a false positive lands on an author who
    // did the work.
    expect(
      claimsASearch("Duplicate check: run tasks_search first. I searched and found mt#1.")
    ).toBe(false);
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

// ---------------------------------------------------------------------------
// mt#4975 — the discharge compares the NAMED query, not merely that a search ran
// ---------------------------------------------------------------------------

/** A tool_use line carrying an `input`, so a query can be asserted on. */
function searchCallLine(name: string, query: string): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input: { query } }] },
  } as unknown as TranscriptLine;
}

/** A record naming `query` as the search the author claims to have run. */
function specNaming(query: string): string {
  return (
    "## Summary\n\nSomething.\n\n## Context\n\n" +
    `Duplicate check: searched \`tasks_search\` for "${query}". Candidates: mt#1 (orthogonal).\n`
  );
}

/** A claimed query and a strict subset of it, for the coverage-asymmetry checks. */
const FOUR_TERMS = "alpha beta gamma delta";
const TWO_TERMS = "alpha beta";

describe("mt#4975 — named-query discharge", () => {
  test("AT1: a named query with no matching call FLAGS, even though a search ran", () => {
    // The whole defect: the session searched, so the old presence check cleared
    // this. The named query has nothing behind it.
    const outcome = run(
      inputWith(specNaming("foo bar baz")),
      ctxWith([searchCallLine(SEARCH_TOOL, "completely unrelated subject matter")])
    );
    expect(outcome?.calibration?.outcome).toBe("matched");
    expect(outcome?.calibration?.reason).toBe(
      "named query not found among this session's searches"
    );
    expect(outcome?.additionalContext).toContain("foo bar baz");
    expect(outcome?.deny).toBeUndefined();
  });

  test("AT2: a refined query still DISCHARGES — the direction of error that matters", () => {
    // The author quoted the query they started from; the call added a term.
    // Flagging this would fire at someone who did the work.
    const outcome = run(
      inputWith(specNaming("foo bar baz")),
      ctxWith([searchCallLine(SEARCH_TOOL, "foo bar baz qux")])
    );
    expect(outcome?.calibration?.outcome).toBe("clean");
    expect(outcome?.calibration?.reason).toBe("named query matched a call");
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("AT6 (negative control): queries are read through the MCP-PREFIXED name", () => {
    // The trap this guards: `findToolUseInputs(lines, "tasks_search")` matches
    // names EXACTLY, while live transcripts carry `mcp__minsky__tasks_search`.
    // An implementation using it returns zero queries and flags every record —
    // and every synthetic fixture written with bare names still passes. So this
    // asserts the prefixed spelling specifically; it is the only test here that
    // fails on that mistake.
    expect(sessionSearchQueries([searchCallLine(SEARCH_TOOL, "prefixed name query")])).toEqual([
      "prefixed name query",
    ]);
    expect(sessionSearchQueries([searchCallLine("tasks_search", "bare name query")])).toEqual([
      "bare name query",
    ]);
  });

  test("a quoted span that no search verb introduces is not read as a query", () => {
    // Records quote task titles and verdict prose. Treating every quoted span as
    // a claimed query manufactured a false positive on exactly this shape in the
    // live log (a quoted description of a guarantee trade, 2026-09-04).
    const spec =
      `## Summary\n\nSomething.\n\n## Context\n\n` +
      `Duplicate check: candidates considered. mt#1 is "a Class B guarantee trade owned by ` +
      `mt#2718, needing a measured before/after and principal sign-off" — orthogonal.\n`;
    expect(extractNamedQueries(extractDuplicateCheckRecord(spec) ?? "")).toEqual([]);
  });

  test("a record claiming a search but quoting none falls back to presence, unchanged", () => {
    // "Searched for calibration coverage." — a legitimate form with nothing to
    // compare. This is also the branch a `refs_status` cross-reference takes.
    const spec =
      `## Summary\n\nSomething.\n\n## Context\n\n` +
      `Duplicate check: searched for calibration telemetry migration coverage.\n`;
    expect(extractNamedQueries(extractDuplicateCheckRecord(spec) ?? "")).toEqual([]);
    const outcome = run(inputWith(spec), ctxWith([toolCallLine("mcp__minsky__refs_status")]));
    expect(outcome?.calibration?.outcome).toBe("clean");
    expect(outcome?.calibration?.reason).toBe("search claim matched a call");
  });

  test("the tool name inside the claim is not mistaken for the query", () => {
    // `tasks_search` is backticked right before the real query; a 1-2 word span
    // is never a query.
    expect(extractNamedQueries(`searched \`tasks_search\` for "${FOUR_TERMS}"`)).toEqual([
      FOUR_TERMS,
    ]);
  });

  test("coverage is asymmetric: extra terms in the ACTUAL query do not penalize", () => {
    expect(queryTokenCoverage(TWO_TERMS, FOUR_TERMS)).toBe(1);
    expect(queryTokenCoverage(FOUR_TERMS, TWO_TERMS)).toBeLessThan(1);
  });

  test("a named query with NO search at all in the session still flags", () => {
    const outcome = run(inputWith(specNaming("foo bar baz")), ctxWith([toolCallLine("Bash")]));
    expect(outcome?.calibration?.outcome).toBe("matched");
  });
});
