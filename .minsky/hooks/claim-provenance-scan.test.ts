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
  claimsRemainingWork,
  extractAuthoredSpecText,
  remainingWorkSubjects,
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

/** The seam all three originating incidents actually wrote at. */
const SPEC_PATCH_TOOL = "mcp__minsky__tasks_spec_patch";

/** A spec-patch call — the seam both originating incidents actually wrote at. */
function patchInput(content: string): ToolHookInput {
  return {
    session_id: "sess-mt4168",
    tool_name: SPEC_PATCH_TOOL,
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

  test("PR #3050 R1: scoped to the collision paragraph, not the whole spec", () => {
    // An unrelated PR cited elsewhere must not become a required read. It did
    // before this fix, so the guard fired at authors who HAD read the PR their
    // claim was actually about — the dangerous direction.
    const withUnrelated = `${COLLISION_SPEC}
## Context

- **mt#1** — see PR #9999 for the sibling's approach, which is unrelated to any file here.
`;
    expect(citedPrNumbers(withUnrelated)).toEqual([2692]);
  });

  test("PR #3050 R1: a bare #123 is NOT a citation, because task refs carry one", () => {
    // `mt#4168` has a word boundary right before its `#`, so taking bare `#N`
    // would turn every task citation in a spec into a PR whose files must have
    // been read. The comment used to claim bare-`#N` was supported; it never
    // was, and it must not be.
    const withTaskRefs = `## Context

This collides with mt#4168 and mt#3806 on \`src/thing.ts\`, per issue #4242.
`;
    expect(citedPrNumbers(withTaskRefs)).toEqual([]);
  });

  test("PR #3050 R1 end-to-end: reading the cited PR discharges despite other PRs in the spec", () => {
    const withUnrelated = `${COLLISION_SPEC}
## Context

- Sibling work landed in PR #9999; unrelated.
`;
    const out = run(patchInput(withUnrelated), ctxWith([...NOISE, PR_FILES_CALL(2692)]));
    expect(out?.calibration?.["outcome"]).toBe("clean");
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

// ---------------------------------------------------------------------------
// The remaining-work class (mt#4299)
// ---------------------------------------------------------------------------
//
// The incident (mem#1114): a genuinely verified root-cause section was patched
// into mt#2307's spec and closed with "Whoever takes this task should confirm
// that trade still holds…" — work mt#2664 had completed ten weeks earlier. The
// verified body supplied the rider's felt credibility; the rider itself was
// never evaluated as a proposition.
//
// As above, the discriminating assertions are the PAIRS.

/** A rider naming its subject outright. */
const REMAINING_WORK_SPEC = `## Summary

Record the root cause.

## Findings

The lenient top-level schema is deliberate. mt#2307 still needs its test renamed
and a doc note added before it can be closed out.
`;

/**
 * The originating shape: deictic, naming no id in the claim's own paragraph.
 *
 * The referent of "this task" is the \`taskId\` of the write itself. A spec id
 * DOES appear in an earlier paragraph, which is deliberate — it pins that the
 * subject is resolved per-paragraph and does not leak across them.
 */
const DEICTIC_RIDER_SPEC = `## Summary

Record the root cause.

## Findings

mt#2161 made the top-level schema lenient deliberately; the docstring says so.

Whoever takes this task should confirm that trade still holds and then update
the test plus a doc note.
`;

/** A spec-patch whose target id is the referent of "this task". */
function patchInputFor(taskId: string, content: string): ToolHookInput {
  return {
    session_id: "sess-mt4299",
    tool_name: SPEC_PATCH_TOOL,
    tool_input: { taskId, content },
  } as unknown as ToolHookInput;
}

const STATUS_GET_CALL = (taskId: string) =>
  toolCallLine("mcp__minsky__tasks_status_get", { taskId });
const TASK_GET_CALL = (taskId: string) => toolCallLine("mcp__minsky__tasks_get", { taskId });
const SPEC_GET_CALL = (taskId: string) => toolCallLine("mcp__minsky__tasks_spec_get", { taskId });
const REFS_STATUS_CALL = (refs: string[]) => toolCallLine("mcp__minsky__refs_status", { refs });

describe("claimsRemainingWork — recognition", () => {
  test("a forward-looking assertion naming a task is a claim", () => {
    expect(claimsRemainingWork(REMAINING_WORK_SPEC, null)).toBe(true);
  });

  test("the deictic form resolves against the task being written", () => {
    expect(claimsRemainingWork(DEICTIC_RIDER_SPEC, "mt#2307")).toBe(true);
  });

  test("with no target id the deictic form is NOT adjudicable, so it is not a claim", () => {
    // `tasks_create` carries no taskId: a task being born has no state anyone
    // could have read, so demanding a read would be undischargeable.
    expect(claimsRemainingWork(DEICTIC_RIDER_SPEC, null)).toBe(false);
  });

  test("ordinary descriptive prose about a task is not a claim", () => {
    expect(
      claimsRemainingWork("mt#2307 changed the loader to warn instead of throwing.", "mt#1")
    ).toBe(false);
  });

  test("the hyphenated term of art does not fire — it names this class, it is not one", () => {
    // Without the whitespace requirement the guard fires on every spec that
    // DISCUSSES remaining-work claims, starting with mt#4299's own.
    expect(
      claimsRemainingWork("A remaining-work claim about mt#4295 would be invisible here.", "mt#1")
    ).toBe(false);
  });

  test("an audit RECORD enumerating gate verdicts is not an assertion", () => {
    // Same structural discriminator the collision class earned in mt#4190: a
    // gate block is the recorded OUTPUT of a check, not a claim.
    const gateBlock = `- **(a)** pass — all five sections present.
- **(b)** pass — mt#2307 still needs nothing; criteria satisfied.
- **(c)** pass — In/Out both enumerated.`;
    expect(claimsRemainingWork(gateBlock, "mt#1")).toBe(false);
  });
});

describe("remainingWorkSubjects — the join key", () => {
  test("explicit ids win, and are normalized to one spelling", () => {
    expect(remainingWorkSubjects("mt#2307 still needs a doc note.", "mt#1")).toEqual(["mt2307"]);
  });

  test("a memory or ask short id is not a task and cannot be a subject", () => {
    // mem#N has no status to read, so treating it as a subject would demand a
    // call that cannot exist.
    expect(remainingWorkSubjects("mem#1114 still needs retiring.", null)).toEqual([]);
  });

  test("PR #3173 R1: md#N is not a subject — it is placeholder text in this corpus", () => {
    // `md#N` is a documented task-id form, and matching it was measured wrong:
    // 64 distinct tokens repo-wide led by md#123 (110x) / md#999 (66x), which are
    // the tool description's own examples and test fixtures, and refs_status
    // reports the real ones absent. A subject no status read can discharge is the
    // one failure this class exists to avoid.
    expect(remainingWorkSubjects("md#456 still needs its doc note.", null)).toEqual([]);
    // ...and it must not silently fall through to the deictic branch either,
    // which would swap one wrong subject for another.
    expect(remainingWorkSubjects("md#456 still needs its doc note.", "mt#1")).toEqual([]);
  });

  test("several ids in one paragraph are all required", () => {
    expect(
      remainingWorkSubjects("mt#4295 and mt#4301 still need their guards.", null).sort()
    ).toEqual(["mt4295", "mt4301"]);
  });
});

describe("run — remaining-work claims (AT1, AT2, AT3)", () => {
  test("AT1: fires when the cited task's status was never read", () => {
    const out = run(patchInputFor("mt#1651", REMAINING_WORK_SPEC), ctxWith([...NOISE]));
    expect(out?.calibration?.["outcome"]).toBe("matched");
    expect(out?.calibration?.["kinds"]).toEqual(["a remaining-work assertion"]);
  });

  test("AT2: a status read on THAT id, preceding the write, discharges it", () => {
    const out = run(
      patchInputFor("mt#1651", REMAINING_WORK_SPEC),
      ctxWith([...NOISE, STATUS_GET_CALL("mt#2307")])
    );
    expect(out?.calibration?.["outcome"]).toBe("clean");
  });

  test("AT3: a status read on a DIFFERENT id does not discharge it", () => {
    // The join is ID-SCOPED, which is strictly stronger than the ownership
    // half's presence-only `sessionRanASearch`. mt#4190 measured what
    // presence-only costs: 25 claims, 25 discharged, never fires.
    const out = run(
      patchInputFor("mt#1651", REMAINING_WORK_SPEC),
      ctxWith([...NOISE, STATUS_GET_CALL("mt#9999")])
    );
    expect(out?.calibration?.["outcome"]).toBe("matched");
  });

  test("the originating incident: the deictic rider fires against its own task", () => {
    const out = run(patchInputFor("mt#2307", DEICTIC_RIDER_SPEC), ctxWith([...NOISE]));
    expect(out?.calibration?.["outcome"]).toBe("matched");
    expect(out?.calibration?.["kinds"]).toEqual(["a remaining-work assertion"]);
  });

  test("the originating incident: reading mt#2307 first discharges it", () => {
    // One `tasks_status_get` is the whole remedy mem#1114 prescribes.
    const out = run(
      patchInputFor("mt#2307", DEICTIC_RIDER_SPEC),
      ctxWith([...NOISE, STATUS_GET_CALL("mt#2307")])
    );
    expect(out?.calibration?.["outcome"]).toBe("clean");
  });

  test("the subject is per-paragraph: an id in an EARLIER paragraph is not the referent", () => {
    // DEICTIC_RIDER_SPEC names mt#2161 two paragraphs up. Reading THAT must not
    // discharge a claim whose subject is the task being patched.
    const out = run(
      patchInputFor("mt#2307", DEICTIC_RIDER_SPEC),
      ctxWith([...NOISE, STATUS_GET_CALL("mt#2161")])
    );
    expect(out?.calibration?.["outcome"]).toBe("matched");
  });
});

describe("run — the discharge set is generous (all four tools)", () => {
  const cases: Array<[string, ReturnType<typeof toolCallLine>]> = [
    ["tasks_status_get", STATUS_GET_CALL("mt#2307")],
    ["tasks_get", TASK_GET_CALL("mt#2307")],
    ["tasks_spec_get", SPEC_GET_CALL("mt#2307")],
    ["refs_status (array)", REFS_STATUS_CALL(["mt#4295", "mt#2307", "3165"])],
  ];

  for (const [label, call] of cases) {
    test(`${label} discharges the claim`, () => {
      // Direction of error: a status-read spelling missed here fires at an
      // author who looked the task up, which is the dangerous direction.
      const out = run(patchInputFor("mt#1651", REMAINING_WORK_SPEC), ctxWith([...NOISE, call]));
      expect(out?.calibration?.["outcome"]).toBe("clean");
    });
  }

  test("the unpunctuated spelling is the same id", () => {
    // The substrate stores `mt2307`; both spellings are in live circulation, so
    // a literal comparison would miss across them.
    const out = run(
      patchInputFor("mt#1651", REMAINING_WORK_SPEC),
      ctxWith([...NOISE, STATUS_GET_CALL("mt2307")])
    );
    expect(out?.calibration?.["outcome"]).toBe("clean");
  });

  test("every cited subject must be read, not just one of them", () => {
    const two = `## Findings\n\nmt#4295 and mt#4301 still need their guards before this lands.\n`;
    const partial = run(
      patchInputFor("mt#1", two),
      ctxWith([...NOISE, STATUS_GET_CALL("mt#4295")])
    );
    expect(partial?.calibration?.["outcome"]).toBe("matched");

    const both = run(
      patchInputFor("mt#1", two),
      ctxWith([...NOISE, REFS_STATUS_CALL(["mt#4295", "mt#4301"])])
    );
    expect(both?.calibration?.["outcome"]).toBe("clean");
  });
});

describe("run — the class reaches every spec-WRITE seam (PR #3173 R1)", () => {
  // The seam finding this guard was built on: binding only to `tasks_create`
  // would miss the surface both original incidents wrote at. A new class that
  // silently covered only `tasks_spec_patch` would rebuild that gap one level
  // down — the same shape, one class over — so each seam is pinned rather than
  // assumed from the shared `SPEC_TEXT_FIELD_BY_TOOL` lookup.
  const SEAMS: Array<[string, string, (content: string) => ToolHookInput]> = [
    [
      "tasks_edit",
      "specContent",
      (content) =>
        ({
          session_id: "sess-mt4299",
          tool_name: "mcp__minsky__tasks_edit",
          tool_input: { taskId: "mt#1651", specContent: content },
        }) as unknown as ToolHookInput,
    ],
    [
      "tasks_spec_search_replace",
      "replace",
      (content) =>
        ({
          session_id: "sess-mt4299",
          tool_name: "mcp__minsky__tasks_spec_search_replace",
          tool_input: { taskId: "mt#1651", search: "old", replace: content },
        }) as unknown as ToolHookInput,
    ],
  ];

  for (const [tool, field, build] of SEAMS) {
    test(`${tool} (${field}): fires undischarged, and a status read on the cited id clears it`, () => {
      expect(run(build(REMAINING_WORK_SPEC), ctxWith([...NOISE]))?.calibration?.["outcome"]).toBe(
        "matched"
      );
      expect(
        run(build(REMAINING_WORK_SPEC), ctxWith([...NOISE, STATUS_GET_CALL("mt#2307")]))
          ?.calibration?.["outcome"]
      ).toBe("clean");
    });
  }

  /** A new spec at birth — the one seam that carries no `taskId`. */
  function createInput(spec: string): ToolHookInput {
    return {
      session_id: "sess-mt4299",
      tool_name: "mcp__minsky__tasks_create",
      tool_input: { spec },
    } as unknown as ToolHookInput;
  }

  test("tasks_create: the deictic form has no referent, so it does not fire", () => {
    // Not an oversight — a task being born has no id and no state anyone could
    // have read, so the claim is not adjudicable.
    expect(
      run(createInput(DEICTIC_RIDER_SPEC), ctxWith([...NOISE]))?.calibration?.["outcome"]
    ).toBe("clean");
  });

  test("tasks_create: an EXPLICIT id in a new spec still fires", () => {
    // The deictic exemption above must not turn `tasks_create` into a blind spot
    // for the form that IS adjudicable there.
    expect(
      run(createInput(REMAINING_WORK_SPEC), ctxWith([...NOISE]))?.calibration?.["outcome"]
    ).toBe("matched");
  });
});
