/**
 * Handoff-at-work-boundary (mt#5042).
 *
 * The rule under test: at a work boundary — a merge, a PR landing, a task
 * closeout — record the session's context fill, and mark whether a trigger at
 * the pre-registered threshold WOULD have fired.
 *
 * Three properties carry the design and are pinned here rather than left to
 * review:
 *
 *   1. LOG-ONLY. `run` returns a reading and the module's `main` writes an empty
 *      output; nothing here may inject, deny, or act. Asserted on the absence of
 *      an injection channel in the outcome.
 *   2. An ESTIMATED reading NEVER drives (SC3). A `fallback-default` window
 *      produces a plausible number over an assumed denominator (mt#4968), so it
 *      is recorded and can never fire — even at a fill far above the threshold.
 *   3. The absolute threshold's failure direction on a small window is SILENT
 *      NO-FIRE, not a nonsense ratio. The module's docblock promises this test
 *      exists so that adding a smaller known window is a deliberate revisit.
 */
import { describe, test, expect } from "bun:test";
import {
  BOUNDARY_FILL_TOKENS_ENV_VAR,
  DEFAULT_BOUNDARY_FILL_TOKENS,
  GUARD_NAME,
  classifyBoundary,
  decideBoundaryReading,
  isOverridden,
  readBoundaryThreshold,
  readToolSucceeded,
  resolveRequestedStatus,
  run,
} from "./handoff-at-work-boundary";
import { KNOWN_MODEL_WINDOWS } from "./context-fill-gauge";
import type { ToolHookInput } from "./types";
import type { TranscriptLine } from "./transcript";

const MERGE_TOOL = "mcp__minsky__session_pr_merge";
const GH_MERGE_TOOL = "mcp__github__merge_pull_request";
const PR_CREATE_TOOL = "mcp__minsky__session_pr_create";
const STATUS_SET_TOOL = "mcp__minsky__tasks_status_set";
const NON_BOUNDARY_TOOL = "mcp__minsky__session_commit";

/** An assistant transcript line carrying a usage record the gauge can read. */
function assistantLine(fillTokens: number, model: string): TranscriptLine {
  return {
    type: "assistant",
    message: {
      model,
      usage: {
        input_tokens: fillTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as TranscriptLine;
}

function toolInput(
  tool_name: string,
  extra: { tool_input?: Record<string, unknown>; tool_result?: Record<string, unknown> } = {}
): ToolHookInput {
  return {
    session_id: "s1",
    transcript_path: "/tmp/does-not-matter.jsonl",
    cwd: "/repo",
    tool_name,
    tool_input: extra.tool_input ?? {},
    tool_result: extra.tool_result ?? { success: true },
  } as unknown as ToolHookInput;
}

describe("classifyBoundary", () => {
  test("a successful merge is a merge boundary", () => {
    expect(classifyBoundary(toolInput(MERGE_TOOL))).toBe("merge");
  });

  test("a GitHub merge is the same boundary kind", () => {
    expect(classifyBoundary(toolInput(GH_MERGE_TOOL))).toBe("merge");
  });

  test("a PR creation is a pr-landing boundary", () => {
    expect(classifyBoundary(toolInput(PR_CREATE_TOOL))).toBe("pr-landing");
  });

  test("a status_set to DONE is a closeout", () => {
    const input = toolInput(STATUS_SET_TOOL, { tool_input: { status: "DONE" } });
    expect(classifyBoundary(input)).toBe("closeout");
  });

  test("a status_set to anything else is NOT a boundary", () => {
    for (const status of ["READY", "IN-PROGRESS", "IN-REVIEW", "PLANNING", "BLOCKED"]) {
      const input = toolInput(STATUS_SET_TOOL, { tool_input: { status } });
      expect(classifyBoundary(input)).toBeNull();
    }
  });

  test("an unrelated tool is not a boundary", () => {
    expect(classifyBoundary(toolInput(NON_BOUNDARY_TOOL))).toBeNull();
  });

  test("an explicitly failed call is not a boundary", () => {
    const input = toolInput(MERGE_TOOL, { tool_result: { success: false } });
    expect(classifyBoundary(input)).toBeNull();
  });

  test("an ABSENT success field still counts — recorded, not assumed", () => {
    // `mcp__github__merge_pull_request` returns GitHub's shape, not this repo's
    // envelope. Reading an absent field as failure would drop a whole tool's
    // boundaries out of the distribution with nothing to notice.
    const input = toolInput(GH_MERGE_TOOL, { tool_result: { sha: "abc" } });
    expect(readToolSucceeded(input)).toBeNull();
    expect(classifyBoundary(input)).toBe("merge");
  });
});

describe("resolveRequestedStatus", () => {
  test("prefers the requested status and upper-cases it", () => {
    const input = toolInput(STATUS_SET_TOOL, { tool_input: { status: "done" } });
    expect(resolveRequestedStatus(input)).toBe("DONE");
  });

  test("falls back to the applied status on the result", () => {
    const input = toolInput(STATUS_SET_TOOL, {
      tool_input: {},
      tool_result: { success: true, newStatus: "DONE" },
    });
    expect(resolveRequestedStatus(input)).toBe("DONE");
  });
});

describe("decideBoundaryReading", () => {
  const KNOWN_MODEL = "claude-opus-5";

  test("fires when a MEASURED fill reaches the threshold", () => {
    const reading = decideBoundaryReading(
      toolInput(MERGE_TOOL),
      [assistantLine(700_000, KNOWN_MODEL)],
      DEFAULT_BOUNDARY_FILL_TOKENS
    );
    expect(reading?.boundary).toBe("merge");
    expect(reading?.driveable).toBe(true);
    expect(reading?.wouldTrigger).toBe(true);
    expect(reading?.fill.fillTokens).toBe(700_000);
  });

  test("records but does not fire below the threshold", () => {
    const reading = decideBoundaryReading(
      toolInput(MERGE_TOOL),
      [assistantLine(400_000, KNOWN_MODEL)],
      DEFAULT_BOUNDARY_FILL_TOKENS
    );
    expect(reading?.wouldTrigger).toBe(false);
    expect(reading?.driveable).toBe(true);
  });

  test("fires exactly AT the threshold, not only above it", () => {
    const reading = decideBoundaryReading(
      toolInput(MERGE_TOOL),
      [assistantLine(DEFAULT_BOUNDARY_FILL_TOKENS, KNOWN_MODEL)],
      DEFAULT_BOUNDARY_FILL_TOKENS
    );
    expect(reading?.wouldTrigger).toBe(true);
  });

  test("SC3: an ESTIMATED reading never drives, however large the fill", () => {
    // An unknown model takes the 200K fallback window. 900K over that assumed
    // denominator is a 450% reading — plausible-looking, and measured against a
    // window the session was never near (mt#4968).
    const reading = decideBoundaryReading(
      toolInput(MERGE_TOOL),
      [assistantLine(900_000, "some-unmeasured-model")],
      DEFAULT_BOUNDARY_FILL_TOKENS
    );
    expect(reading?.fill.windowSource).toBe("fallback-default");
    expect(reading?.driveable).toBe(false);
    expect(reading?.wouldTrigger).toBe(false);
    // ...and it is still RECORDED, so the distribution keeps its shape.
    expect(reading?.fill.fillTokens).toBe(900_000);
  });

  test("a non-boundary yields no reading at all", () => {
    const reading = decideBoundaryReading(
      toolInput(NON_BOUNDARY_TOOL),
      [assistantLine(900_000, KNOWN_MODEL)],
      DEFAULT_BOUNDARY_FILL_TOKENS
    );
    expect(reading).toBeNull();
  });

  test("no usage record yields no reading — fail open on a cold start", () => {
    const reading = decideBoundaryReading(toolInput(MERGE_TOOL), [], DEFAULT_BOUNDARY_FILL_TOKENS);
    expect(reading).toBeNull();
  });
});

describe("the absolute threshold's window assumption", () => {
  test("every known window today is large enough for the threshold to be reachable", () => {
    // The docblock justifies an ABSOLUTE threshold on the fact that every entry
    // in KNOWN_MODEL_WINDOWS is a 1M window, so 650K is a reachable 65%. This
    // asserts that premise rather than trusting it: if a smaller window is added,
    // this fails and the choice gets revisited deliberately.
    for (const [model, window] of Object.entries(KNOWN_MODEL_WINDOWS)) {
      expect(`${model}:${window >= DEFAULT_BOUNDARY_FILL_TOKENS}`).toBe(`${model}:true`);
    }
  });

  test("the failure direction on a hypothetical small window is silent NO-FIRE", () => {
    // Not a nonsense ratio: a fill that large is unreachable on a small window
    // because the harness compacts long before, so the guard simply never fires
    // for that model. Demonstrated with a fill BELOW a small window's ceiling.
    const reading = decideBoundaryReading(
      toolInput(MERGE_TOOL),
      [assistantLine(190_000, "claude-sonnet-5")],
      DEFAULT_BOUNDARY_FILL_TOKENS
    );
    expect(reading?.wouldTrigger).toBe(false);
  });
});

describe("readBoundaryThreshold", () => {
  test("defaults to the pre-registered hypothesis", () => {
    expect(readBoundaryThreshold({})).toBe(DEFAULT_BOUNDARY_FILL_TOKENS);
    expect(DEFAULT_BOUNDARY_FILL_TOKENS).toBe(650_000);
  });

  test("an env override is honored", () => {
    expect(readBoundaryThreshold({ [BOUNDARY_FILL_TOKENS_ENV_VAR]: "800000" })).toBe(800_000);
  });
});

describe("isOverridden", () => {
  test("the shared channel names this guard", () => {
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: GUARD_NAME })).toBe(true);
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: `other,${GUARD_NAME}` })).toBe(true);
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: "all" })).toBe(true);
  });

  test("an unrelated guard name does not override this one", () => {
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: "block-git-gh-cli" })).toBe(false);
    expect(isOverridden({})).toBe(false);
  });

  test("no bespoke MINSKY_SKIP_* name is minted (ADR-028 D3)", () => {
    expect(isOverridden({ MINSKY_SKIP_HANDOFF_AT_WORK_BOUNDARY: "1" })).toBe(false);
  });
});

describe("run", () => {
  const KNOWN_MODEL = "claude-opus-5";

  function depsRecording(lines: TranscriptLine[]) {
    const evaluations: Record<string, unknown>[] = [];
    const calibrations: Record<string, unknown>[] = [];
    return {
      evaluations,
      calibrations,
      deps: {
        parseTranscriptFn: () => lines,
        logEvaluationRecordFn: (_name: string, row: Record<string, unknown>) => {
          evaluations.push(row);
        },
        logCalibrationRecordFn: (_name: string, row: Record<string, unknown>) => {
          calibrations.push(row);
        },
        env: {} as Record<string, string | undefined>,
      },
    };
  }

  test("records EVERY boundary on the evaluation stream, firing or not", () => {
    const below = depsRecording([assistantLine(400_000, KNOWN_MODEL)]);
    run(toolInput(MERGE_TOOL), below.deps);
    expect(below.evaluations).toHaveLength(1);
    expect(below.evaluations[0]?.["fired"]).toBe(false);
    // The non-firing rows ARE the distribution the threshold is re-derived from,
    // so a fire-only stream would defeat the calibration purpose (mt#3583).
    expect(below.calibrations).toHaveLength(0);
  });

  test("a firing boundary reaches the calibration stream too", () => {
    const above = depsRecording([assistantLine(700_000, KNOWN_MODEL)]);
    run(toolInput(MERGE_TOOL), above.deps);
    expect(above.evaluations).toHaveLength(1);
    expect(above.calibrations).toHaveLength(1);
    expect(above.calibrations[0]?.["fired"]).toBe(true);
    expect(above.calibrations[0]?.["boundary"]).toBe("merge");
    expect(above.calibrations[0]?.["thresholdTokens"]).toBe(DEFAULT_BOUNDARY_FILL_TOKENS);
  });

  test("an override records nothing at all", () => {
    const overridden = depsRecording([assistantLine(900_000, KNOWN_MODEL)]);
    overridden.deps.env = { MINSKY_HOOK_OVERRIDE: GUARD_NAME };
    expect(run(toolInput(MERGE_TOOL), overridden.deps)).toBeNull();
    expect(overridden.evaluations).toHaveLength(0);
    expect(overridden.calibrations).toHaveLength(0);
  });

  test("a non-boundary tool never parses the transcript", () => {
    let parsed = 0;
    run(toolInput(NON_BOUNDARY_TOOL), {
      parseTranscriptFn: () => {
        parsed++;
        return [];
      },
      logEvaluationRecordFn: () => {},
      logCalibrationRecordFn: () => {},
      env: {},
    });
    expect(parsed).toBe(0);
  });

  test("LOG-ONLY: the reading carries no injection or denial channel", () => {
    const above = depsRecording([assistantLine(900_000, KNOWN_MODEL)]);
    const reading = run(toolInput(MERGE_TOOL), above.deps);
    expect(reading).not.toBeNull();
    // v1 acts on nothing. If a later change adds an injection, this fails and
    // the authorization question (mt#2531 §Authorization) has to be answered
    // rather than slipped in.
    expect(Object.keys(reading as object).sort()).toEqual([
      "boundary",
      "driveable",
      "fill",
      "thresholdTokens",
      "toolSucceeded",
      "wouldTrigger",
    ]);
  });
});
