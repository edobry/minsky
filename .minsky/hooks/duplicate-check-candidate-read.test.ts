/**
 * mt#4167 — a duplicate-check record distinguishing candidates never opened.
 *
 * The discriminating pair is AT1/AT2: the SAME record fires in a session with no
 * spec-surfacing call for the candidate and stays silent in one that has it.
 * Everything else bounds the trigger, because this guard fires at the moment an
 * author is filing work and a false positive there is expensive.
 *
 * Fixtures are built from the ORIGINATING INCIDENT rather than from a shape
 * invented here: mt#4158's record naming mt#3053, quoted. mem#819 R4 records why
 * that matters — a fix designed against the artifact the incident produced, and
 * replayed against it, passed while still missing the incident.
 */
import { describe, test, expect } from "bun:test";
import type { DispatchContext } from "./registry";
import type { ToolHookInput } from "./types";
import type { TranscriptLine } from "./transcript";
import {
  extractCandidateIds,
  buildCandidateReadWarning,
  run,
} from "./duplicate-check-candidate-read";

const SPEC_GET = "mcp__minsky__tasks_spec_get";
const TASKS_GET = "mcp__minsky__tasks_get";
const TASKS_SEARCH = "mcp__minsky__tasks_search";

/**
 * mt#4158's actual duplicate-check record, quoted. The distinguishing clause is
 * the one mt#3053's own spec contradicts.
 */
const INCIDENT_SPEC = `## Summary

Something is slow.

## Context

Duplicate check: \`tasks_search\` returned 8 candidates. Nearest is **mt#3053** —
"Flaky: OAuth Discovery times out under full-suite CI parallelism". Same test
family, different phenomenon: mt#3053 is flakiness under CI parallelism, whereas
this is deterministic (12/12, twice, standalone, idle machine). No duplicate.
`;

function toolCallLine(name: string, input: Record<string, unknown>): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
  } as unknown as TranscriptLine;
}

function ctxWith(lines: TranscriptLine[]): DispatchContext {
  return { transcriptLines: lines } as unknown as DispatchContext;
}

function inputWith(spec: string): ToolHookInput {
  return {
    session_id: "sess-mt4167",
    tool_input: { title: "a task", spec },
  } as unknown as ToolHookInput;
}

/** An unrelated call, so the transcript is non-empty without surfacing a spec. */
const UNRELATED = toolCallLine(TASKS_SEARCH, { query: "anything" });

describe("extractCandidateIds", () => {
  test("pulls the qualified ids the record names", () => {
    const ids = extractCandidateIds("Duplicate check: reviewed mt#3053 and md#12; orthogonal.");
    expect(ids.map((c) => c.written)).toEqual(["mt#3053", "md#12"]);
  });

  test("normalises separator variants to one comparison form", () => {
    const ids = extractCandidateIds("Duplicate check: mt-4158 is the nearest.");
    expect(ids).toHaveLength(1);
    expect(ids[0]?.normalized).toBe("mt4158");
  });

  test("de-duplicates a candidate named more than once", () => {
    const ids = extractCandidateIds("Duplicate check: mt#3053 … see mt#3053 again.");
    expect(ids).toHaveLength(1);
  });

  test("does NOT read a PR reference as a task", () => {
    // `PR #3034` fails on the space; `PR#3034` is what the prefix guard is for.
    // A PR read back as a task is a candidate nobody could ever have opened, so
    // it would fire forever.
    expect(extractCandidateIds("Duplicate check: superseded by PR#3034.")).toEqual([]);
    expect(extractCandidateIds("Duplicate check: superseded by PR #3034.")).toEqual([]);
  });

  test("does NOT read a bare number or bare prefix as a task", () => {
    expect(extractCandidateIds("Duplicate check: see #4158.")).toEqual([]);
    expect(extractCandidateIds("Duplicate check: see mt4158.")).toEqual([]);
  });

  test("returns nothing for the sanctioned no-candidates form", () => {
    expect(extractCandidateIds("Duplicate check: no candidates found.")).toEqual([]);
  });
});

describe("run — the discriminating pair", () => {
  test("AT1: fires on the mt#4158 record when no candidate spec was surfaced", () => {
    const outcome = run(inputWith(INCIDENT_SPEC), ctxWith([UNRELATED]));

    // Liveness first: the fixture must actually reach the extractor, or the
    // assertions below would pass on a record that named nothing.
    expect(outcome?.calibration?.["candidateCount"]).toBe(1);

    expect(outcome?.calibration?.["outcome"]).toBe("matched");
    expect(outcome?.calibration?.["unreadIds"]).toEqual(["mt#3053"]);
    expect(outcome?.additionalContext).toContain("mt#3053");
    expect(outcome?.additionalContext).toContain("[duplicate-check-candidate-read]");
  });

  test("AT2: silent once the candidate's spec WAS surfaced", () => {
    const outcome = run(
      inputWith(INCIDENT_SPEC),
      ctxWith([UNRELATED, toolCallLine(SPEC_GET, { taskId: "mt#3053" })])
    );

    expect(outcome?.calibration?.["outcome"]).toBe("clean");
    expect(outcome?.additionalContext).toBeUndefined();
  });
});

describe("run — what does NOT count as having read the candidate", () => {
  test("AT3: a bare tasks_get (no includeSpec) does not surface the spec", () => {
    const outcome = run(
      inputWith(INCIDENT_SPEC),
      ctxWith([toolCallLine(TASKS_GET, { taskId: "mt#3053" })])
    );

    // The incident's distinguishing claim was about mt#3053's ROOT CAUSE FOUND
    // section. A bare `tasks_get` returns title and status; crediting it would
    // silence the guard on the exact case it exists for.
    expect(outcome?.calibration?.["outcome"]).toBe("matched");
  });

  test("AT3b: the same call WITH includeSpec does surface it", () => {
    const outcome = run(
      inputWith(INCIDENT_SPEC),
      ctxWith([toolCallLine(TASKS_GET, { taskId: "mt#3053", includeSpec: true })])
    );

    expect(outcome?.calibration?.["outcome"]).toBe("clean");
  });

  test("AT4: a tasks_search does not surface any candidate's spec", () => {
    // Measured 2026-08-16: `tasks_search` with `details: true` returns
    // id/score/title/status and no spec text, so it cannot discharge a
    // candidate read at any setting.
    const outcome = run(
      inputWith(INCIDENT_SPEC),
      ctxWith([toolCallLine(TASKS_SEARCH, { query: "flaky start-command", details: true })])
    );

    expect(outcome?.calibration?.["outcome"]).toBe("matched");
  });

  test("a spec_get for a DIFFERENT task does not discharge this candidate", () => {
    const outcome = run(
      inputWith(INCIDENT_SPEC),
      ctxWith([toolCallLine(SPEC_GET, { taskId: "mt#9999" })])
    );

    expect(outcome?.calibration?.["outcome"]).toBe("matched");
  });
});

describe("run — silence where silence is correct", () => {
  test("AT5: the sanctioned no-candidates form is clean", () => {
    const spec = "## Context\n\nDuplicate check: no candidates found.\n";
    const outcome = run(inputWith(spec), ctxWith([UNRELATED]));

    expect(outcome?.calibration?.["outcome"]).toBe("clean");
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("AT6: a separator variant matches a read of the canonical id", () => {
    const spec = "## Context\n\nDuplicate check: nearest is mt-3053; orthogonal.\n";
    const outcome = run(inputWith(spec), ctxWith([toolCallLine(SPEC_GET, { taskId: "mt#3053" })]));

    expect(outcome?.calibration?.["outcome"]).toBe("clean");
  });

  test("no record at all is clean — that case belongs to the deny tier", () => {
    const outcome = run(inputWith("## Summary\n\nNo record here.\n"), ctxWith([UNRELATED]));

    expect(outcome?.calibration?.["outcome"]).toBe("clean");
  });
});

describe("run — a claim it cannot adjudicate is skipped, never clean", () => {
  test("an empty transcript records skipped", () => {
    // A guard whose no-transcript path returned `clean` would report an outage
    // as a run of correct behavior.
    const outcome = run(inputWith(INCIDENT_SPEC), ctxWith([]));

    expect(outcome?.calibration?.["outcome"]).toBe("skipped");
    expect(outcome?.additionalContext).toBeUndefined();
  });
});

describe("buildCandidateReadWarning", () => {
  test("caps the id list and names the overflow rather than dropping it", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `mt#${4000 + i}`);
    const text = buildCandidateReadWarning(ids);

    expect(text).toContain("mt#4004");
    expect(text).not.toContain("mt#4007");
    expect(text).toContain("... and 3 more");
  });

  test("carries no override string and no task ids of its own", () => {
    // Per guard-feedback-authoring: the agent cannot look an incident id up from
    // inside an injection, and the override's reader is the operator.
    const text = buildCandidateReadWarning(["mt#3053"]);

    expect(text).not.toContain("MINSKY_SKIP");
    expect(text).not.toContain("mem#");
    expect(text).not.toContain("mt#4167");
  });
});
