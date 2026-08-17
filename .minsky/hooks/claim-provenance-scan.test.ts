/**
 * mt#4168 — a spec asserting a file-level collision or a negative ownership
 * claim with nothing in the session that could have established it.
 *
 * The discriminating assertions are the PAIRS: the same spec fires in a session
 * without the discharging call and is silent in one with it. Everything else
 * bounds the trigger, because this guard fires at the moment an author is
 * recording a finding and crying wolf there is expensive.
 *
 * Ordering (SC3) is tested structurally rather than by timestamp: the guard sees
 * only `ctx.transcriptLines`, which at PreToolUse is exactly the calls that
 * PRECEDE the write. A search that happens two minutes later — the mt#3682
 * incident — is simply not in that prefix.
 */
import { describe, test, expect } from "bun:test";
import type { DispatchContext } from "./registry";
import type { ToolHookInput } from "./types";
import type { TranscriptLine } from "./transcript";
import {
  citedPrNumbers,
  claimsFileCollision,
  claimsNoOwner,
  extractAuthoredSpecText,
  run,
  SPEC_TEXT_FIELD_BY_TOOL,
} from "./claim-provenance-scan";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The mem#892 shape: a file-level collision asserted against a named PR. */
const COLLISION_SPEC = `## Summary

Rework the stage.

## Context

This collides with PR #2692 on \`src/cockpit/web/SessionFilmStage.tsx\` — both
rewrite the camera transform.
`;

/** The mt#3682 shape: a negative ownership claim in a \`## Does NOT cover\` list. */
const OWNERSHIP_SPEC = `## Summary

Fix the thing.

## Does NOT cover

- The upstream parse failure — unowned, no task covers this today.
`;

let nextId = 0;

/** A transcript line carrying one assistant tool_use block with real input. */
function toolCallLine(name: string, input: Record<string, unknown> = {}): TranscriptLine {
  nextId += 1;
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${nextId}`, name, input }],
    },
  } as unknown as TranscriptLine;
}

function ctxWith(lines: TranscriptLine[]): DispatchContext {
  return { transcriptLines: lines } as unknown as DispatchContext;
}

/** A spec-patch call — the seam both originating incidents actually wrote at. */
function patchInput(content: string): ToolHookInput {
  return {
    session_id: "sess-mt4168",
    tool_name: "mcp__minsky__tasks_spec_patch",
    tool_input: { taskId: "mt#1", content },
  } as unknown as ToolHookInput;
}

const PR_FILES_CALL = (pullNumber: number) =>
  toolCallLine("mcp__github__pull_request_read", { method: "get_files", pullNumber });
const SEARCH_CALL = toolCallLine("mcp__minsky__tasks_search", { query: "camera transform" });
const GIT_LOG_PATH_CALL = toolCallLine("mcp__minsky__git_log", {
  path: "src/cockpit/web/SessionFilmStage.tsx",
});
/** Enough calls that "the session did things" is never why a case passes. */
const NOISE = [
  toolCallLine("Read", { file_path: "a.ts" }),
  toolCallLine("Bash", { command: "ls" }),
];

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

describe("extractAuthoredSpecText", () => {
  test("reads the authored field for each write tool, not its instructions", () => {
    expect(
      extractAuthoredSpecText("mcp__minsky__tasks_spec_patch", {
        content: "body",
        instructions: "do a thing",
      })
    ).toBe("body");
    expect(extractAuthoredSpecText("mcp__minsky__tasks_create", { spec: "body" })).toBe("body");
    expect(extractAuthoredSpecText("mcp__minsky__tasks_edit", { specContent: "body" })).toBe(
      "body"
    );
    expect(
      extractAuthoredSpecText("mcp__minsky__tasks_spec_search_replace", {
        search: "old",
        replace: "body",
      })
    ).toBe("body");
  });

  test("covers the three spec-WRITE tools that had no PreToolUse guard at all", () => {
    // The seam finding this task turns on: binding only to tasks_create would
    // miss the surface both originating incidents wrote at.
    for (const tool of ["tasks_spec_patch", "tasks_edit", "tasks_spec_search_replace"]) {
      expect(SPEC_TEXT_FIELD_BY_TOOL[tool]).toBeTruthy();
    }
  });

  test("an unlisted tool yields null, so the guard records skipped rather than clean", () => {
    expect(extractAuthoredSpecText("mcp__minsky__session_commit", { message: "x" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Claim recognition
// ---------------------------------------------------------------------------

describe("claimsFileCollision", () => {
  test("an overlap verb PLUS a file token is a file-level claim", () => {
    expect(claimsFileCollision(COLLISION_SPEC)).toBe(true);
  });

  test("task-level adjacency with no file named is NOT this claim", () => {
    // Gate (g) explicitly permits recording "task-level adjacency, files
    // unknown" when the other work has no PR. Firing on it would punish the
    // weaker, more honest finding.
    expect(claimsFileCollision("This overlaps with mt#123, files unknown.")).toBe(false);
  });

  test("a file named with no overlap claim is ordinary spec prose", () => {
    expect(claimsFileCollision("Edit `src/thing.ts` to add the flag.")).toBe(false);
  });
});

describe("claimsNoOwner", () => {
  test("an absence assertion is a claim", () => {
    expect(claimsNoOwner(OWNERSHIP_SPEC)).toBe(true);
    expect(claimsNoOwner("Nothing covers this today.")).toBe(true);
  });

  test("a question or an instruction asserts nothing", () => {
    expect(claimsNoOwner("Check whether any task covers this before filing.")).toBe(false);
  });

  test("the duplicate-check record is mt#4004's turf, not this guard's", () => {
    // Both guards would otherwise fire on one claim.
    expect(claimsNoOwner("Duplicate check: no candidates found.\n")).toBe(false);
  });
});

describe("citedPrNumbers", () => {
  test("reads the PR the claim names, so the join can require THAT PR's files", () => {
    expect(citedPrNumbers(COLLISION_SPEC)).toEqual([2692]);
  });
});

// ---------------------------------------------------------------------------
// The discriminating pairs
// ---------------------------------------------------------------------------

describe("run — file-collision claims (AT1)", () => {
  test("fires when no changed-file list was read for the cited PR", () => {
    const out = run(patchInput(COLLISION_SPEC), ctxWith([...NOISE]));
    expect(out?.calibration?.["outcome"]).toBe("matched");
    expect(out?.calibration?.["kinds"]).toEqual(["a file-level collision"]);
  });

  test("silent when THAT PR's file list was read", () => {
    const out = run(patchInput(COLLISION_SPEC), ctxWith([...NOISE, PR_FILES_CALL(2692)]));
    expect(out?.calibration?.["outcome"]).toBe("clean");
  });

  test("reading a DIFFERENT PR's files does not discharge the claim", () => {
    // The join is specific on purpose: mem#892's claim was about a PR whose
    // files were never read, and accepting any file-read would rebuild it.
    const out = run(patchInput(COLLISION_SPEC), ctxWith([...NOISE, PR_FILES_CALL(9999)]));
    expect(out?.calibration?.["outcome"]).toBe("matched");
  });
});

describe("run — collision with a MERGE (AT2)", () => {
  const MERGE_SPEC = `## Context\n\nThis conflicts with a merge that landed on \`src/thing.ts\` yesterday.\n`;

  test("a path-filtered git_log discharges it", () => {
    const out = run(patchInput(MERGE_SPEC), ctxWith([...NOISE, GIT_LOG_PATH_CALL]));
    expect(out?.calibration?.["outcome"]).toBe("clean");
  });

  test("without one it fires", () => {
    expect(run(patchInput(MERGE_SPEC), ctxWith([...NOISE]))?.calibration?.["outcome"]).toBe(
      "matched"
    );
  });
});

describe("run — ownership claims and ordering (AT3, AT4)", () => {
  test("AT3: fires when no search appears in the session", () => {
    const out = run(patchInput(OWNERSHIP_SPEC), ctxWith([...NOISE]));
    expect(out?.calibration?.["outcome"]).toBe("matched");
    expect(out?.calibration?.["kinds"]).toEqual(["a negative ownership claim"]);
  });

  test("AT4: a search that PRECEDES the write discharges it", () => {
    const out = run(patchInput(OWNERSHIP_SPEC), ctxWith([...NOISE, SEARCH_CALL]));
    expect(out?.calibration?.["outcome"]).toBe("clean");
  });

  test("AT4: a search that comes AFTER the write cannot discharge it", () => {
    // The mt#3682 incident, structurally. At PreToolUse the transcript IS the
    // prefix, so a later search is not in it — which is exactly why this seam
    // makes the ordering requirement free rather than needing a timestamp.
    const prefixAtWriteTime = [...NOISE];
    const out = run(patchInput(OWNERSHIP_SPEC), ctxWith(prefixAtWriteTime));
    expect(out?.calibration?.["outcome"]).toBe("matched");

    // The same session one call later would have discharged it — proving the
    // verdict tracks the prefix and not the session as a whole.
    const laterPrefix = [...prefixAtWriteTime, SEARCH_CALL];
    expect(run(patchInput(OWNERSHIP_SPEC), ctxWith(laterPrefix))?.calibration?.["outcome"]).toBe(
      "clean"
    );
  });
});

describe("run — not-adjudicable and clean paths", () => {
  test("a spec with neither claim is clean without consulting the transcript", () => {
    expect(
      run(patchInput("## Summary\n\nOrdinary work.\n"), ctxWith([]))?.calibration?.["outcome"]
    ).toBe("clean");
  });

  test("a claim with no transcript is skipped, never clean", () => {
    // A guard whose no-transcript path returned a pass would report an outage
    // as a run of correct behavior.
    expect(run(patchInput(OWNERSHIP_SPEC), ctxWith([]))?.calibration?.["outcome"]).toBe("skipped");
  });

  test("never denies — this guard is calibration-first", () => {
    const out = run(patchInput(COLLISION_SPEC), ctxWith([...NOISE]));
    expect(out?.deny).toBeUndefined();
  });

  test("RECORD-ONLY: a fire injects nothing, matching the registration's declared effects", () => {
    // Pinned rather than assumed. The registration declares `recorderEffect()`
    // alone, and PR #2886 R1's finding on the sibling was precisely a
    // declaration that under-described what the module returned. A replay put
    // this guard at 16 fires / 70 claims with one true positive, so injecting
    // would be mem#719's failure mode; mt#4190 owns the graduation.
    const out = run(patchInput(COLLISION_SPEC), ctxWith([...NOISE]));
    expect(out?.calibration?.["outcome"]).toBe("matched");
    expect(out?.additionalContext).toBeUndefined();
  });

  test("a fire still records WHICH claims were unbacked, so the tune has data", () => {
    const both = `${COLLISION_SPEC}\n${OWNERSHIP_SPEC}`;
    const out = run(patchInput(both), ctxWith([...NOISE]));
    expect(out?.calibration?.["kinds"]).toEqual([
      "a file-level collision",
      "a negative ownership claim",
    ]);
  });
});
