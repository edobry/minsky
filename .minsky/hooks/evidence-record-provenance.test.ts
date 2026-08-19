/**
 * mt#4044 — a `Negative control:` or `Execution evidence:` record claiming a run
 * that never happened, at the commit and PR-body seams.
 *
 * The load-bearing pair is in `run()` at the end: the SAME commit message
 * produces a warning in a session where the control was not run and none in a
 * session where it was. Everything before it bounds the trigger, because a guard
 * that fires at an author who DID the work is worse than one that misses — see
 * the direction-of-error note in `evidence-provenance-table.ts`.
 *
 * The fixture is the real one. `INCIDENT_MESSAGE` is the negative-control block
 * from mt#4024's commit 98e2ac5fd (the incident that filed this task), and the
 * discharging run is the shape bun actually printed for it — including the
 * `(mt#4024)` the runner interpolates into the test name, which is exactly why
 * the whole backticked span cannot be the join key.
 */
import { describe, test, expect } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- the R1 regression is that a REAL `bodyPath` file was never read; an injected reader would assert that a fake agrees with the code, which is the one thing that cannot fail. Written to tmpdir and removed in a finally.
import { writeFileSync, rmSync } from "node:fs";
// eslint-disable-next-line custom/no-real-fs-in-tests -- the rule prefers a fixed '/mock/tmp', but this file writes a REAL file (see above), so a fixed path would race across parallel test files. The name is pid-suffixed and removed in a finally.
import { tmpdir } from "node:os";
import type { DispatchContext } from "./registry";
import type { ToolHookInput } from "./types";
import type { TranscriptLine } from "./transcript";
import { GUARD_REGISTRY } from "./registry";
import {
  extractSubjectTokens,
  isTestRunningCall,
  failingTestRuns,
} from "./evidence-provenance-table";
import { judgeClaims, resolveArtifactText, run } from "./evidence-record-provenance";
import { findToolCallsWithResults } from "./transcript";

// ---------------------------------------------------------------------------
// Fixtures — the real record and the real runs, per the header
// ---------------------------------------------------------------------------

/**
 * VERBATIM from the transcript, wrap points included. The wrap is not incidental:
 * re-flowing this fixture to put the newline somewhere tidier is what hid the
 * span-pairing defect that `unwrapForSpanScan` now fixes — the hand-wrapped copy
 * passed while the real message extracted `: swapping` as its subject.
 */
const INCIDENT_MESSAGE = `feat(mt#4024): Add the share page, publish confirmation, and links inventory

Completes the UI half.

Negative control — \`SharedConversationPage > reads ONLY the public share
endpoint\`: swapping \`NO_ENTITY_INDEX\` for \`useEntityIndex()\` (the authenticated
view's index) makes it fail with 2 requests instead of 1, the second being a
gated route. Restored, 5/5.
`;

/** The unrelated red run that preceded the real commit: a genuine bug, not the control. */
const UNRELATED_FAILURE =
  "src/cockpit/web/components/PublishConversationDialog.test.tsx:\n" +
  "TypeError: Invalid URL\n 4 pass\n 1 fail\nRan 5 tests across 1 file.";

/** The control's own run, as bun printed it. */
const SUBJECT_FAILURE =
  "src/cockpit/web/pages/SharedConversationPage.test.tsx:\n" +
  "error: expect(received).toHaveLength(expected)\nExpected length: 1\nReceived length: 7\n" +
  "(fail) SharedConversationPage (mt#4024) > reads ONLY the public share endpoint — " +
  "no gated route is touched [5.98ms]\n\n 4 pass\n 1 fail\nRan 5 tests across 1 file.";

const GREEN_RUN = "bun test v1.3.14\n\n 5 pass\n 0 fail\nRan 5 tests across 1 file. [447.00ms]";

let nextId = 0;

/** One tool call plus its correlated result, as two transcript lines. */
function call(name: string, input: Record<string, unknown>, resultText: string): TranscriptLine[] {
  const id = `tu_${++nextId}`;
  return [
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: id, content: [{ type: "text", resultText }] },
        ],
      },
    },
  ] as unknown as TranscriptLine[];
}

/** A `session_exec` test run returning `output`. */
function testRun(command: string, output: string): TranscriptLine[] {
  const id = `tu_${++nextId}`;
  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name: "mcp__minsky__session_exec", input: { command } }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: id, content: [{ type: "text", text: output }] },
        ],
      },
    },
  ] as unknown as TranscriptLine[];
}

const TEST_CMD = "bun test --preload ./tests/dom-setup.ts --timeout=15000";

function ctxWith(lines: TranscriptLine[]): DispatchContext {
  return { transcriptLines: lines } as unknown as DispatchContext;
}

function commitInput(message: string): ToolHookInput {
  return {
    session_id: "sess-mt4044",
    tool_name: "mcp__minsky__session_commit",
    tool_input: { message },
  } as unknown as ToolHookInput;
}

// ---------------------------------------------------------------------------
// The subject join
// ---------------------------------------------------------------------------

describe("extractSubjectTokens", () => {
  test("splits a test-name span, because the runner interpolates into it", () => {
    // `SharedConversationPage > reads ONLY …` never appears verbatim in bun's
    // output — it prints `SharedConversationPage (mt#4024) > reads ONLY …`. Both
    // halves DO appear, which is the whole reason the split exists.
    const tokens = extractSubjectTokens(INCIDENT_MESSAGE);
    expect(tokens).toContain("SharedConversationPage");
    expect(tokens).toContain("reads ONLY the public share endpoint");
    expect(SUBJECT_FAILURE).toContain("SharedConversationPage");
  });

  test("survives the soft wrap the real message has mid-span", () => {
    // The defect the replay found. On the raw text the pairing goes off by one
    // at the wrap and yields `: swapping` — a token that joins against nothing,
    // so the guard would fire even on a control that DID run.
    expect(extractSubjectTokens(INCIDENT_MESSAGE)).not.toContain(": swapping");
    expect(extractSubjectTokens(INCIDENT_MESSAGE)).toContain("NO_ENTITY_INDEX");
  });

  test("a fenced block's own delimiters do not re-introduce the off-by-one", () => {
    const withFence = [
      "Negative control — `parseThreadTurns`: reverted, saw red.",
      "",
      "```",
      "some `pasted` output",
      "```",
    ].join("\n");
    expect(extractSubjectTokens(withFence)).toContain("parseThreadTurns");
  });

  test("keeps source and test paths, which are the commonest subject shape", () => {
    const tokens = extractSubjectTokens("Negative control — src/adapters/telegram-transport.ts");
    expect(tokens).toContain("src/adapters/telegram-transport.ts");
  });

  test("drops short spans that would collide by accident", () => {
    expect(extractSubjectTokens("Negative control: reverted `db` and `id`, saw red.")).toEqual([]);
  });
});

describe("isTestRunningCall", () => {
  test("a run counts; a grep that merely names a test script does not", () => {
    const ran = findToolCallsWithResults(testRun(TEST_CMD, GREEN_RUN));
    const grepped = findToolCallsWithResults(testRun('grep -n "test:components" package.json', ""));
    expect(ran.filter(isTestRunningCall)).toHaveLength(1);
    // The originating session made exactly this call. Reading it as a test run
    // would discharge a claim on the strength of a grep.
    expect(grepped.filter(isTestRunningCall)).toHaveLength(0);
  });

  test("a green summary line is not a failure, though it contains the word", () => {
    const green = findToolCallsWithResults(testRun(TEST_CMD, GREEN_RUN));
    expect(failingTestRuns(green)).toHaveLength(0);
    const red = findToolCallsWithResults(testRun(TEST_CMD, SUBJECT_FAILURE));
    expect(failingTestRuns(red)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Claim judgement
// ---------------------------------------------------------------------------

describe("judgeClaims", () => {
  test("green runs alone do NOT discharge a negative control", () => {
    // The pre-mt#4044 reading of this check — "was there a test-running call?" —
    // would pass here, and would therefore have gone silent on the incident that
    // filed the task: that session ran `bun test` five times before the commit.
    const calls = findToolCallsWithResults([
      ...testRun(TEST_CMD, GREEN_RUN),
      ...testRun(TEST_CMD, GREEN_RUN),
    ]);
    expect(judgeClaims(INCIDENT_MESSAGE, calls)[0]?.verdict).toBe("undischarged");
  });

  test("a failing run about something ELSE does not discharge it either", () => {
    // The measured state of the real session at commit 98e2ac5fd.
    const calls = findToolCallsWithResults([
      ...testRun(TEST_CMD, GREEN_RUN),
      ...testRun(`${TEST_CMD} PublishConversationDialog.test.tsx`, UNRELATED_FAILURE),
    ]);
    expect(judgeClaims(INCIDENT_MESSAGE, calls)[0]?.verdict).toBe("undischarged");
  });

  test("a failing run naming the record's subject DOES discharge it", () => {
    const calls = findToolCallsWithResults([
      ...testRun(
        `${TEST_CMD} src/cockpit/web/pages/SharedConversationPage.test.tsx`,
        SUBJECT_FAILURE
      ),
    ]);
    expect(judgeClaims(INCIDENT_MESSAGE, calls)[0]?.verdict).toBe("discharged");
  });

  test("a record that PASTES its failing run is discharged by the paste", () => {
    // The measured false-positive class (4 of 4 sampled fires). A record names
    // what was REVERTED — `closeTab` — while the run names the TEST, so the
    // subject join alone flags a control whose evidence is sitting in the body.
    const record = [
      "Negative control — the SPA seam actually closes something:",
      "",
      "Reverted the fix by replacing `closeTab(activePath)` with a comment.",
      "",
      "```",
      "(fail) TabCloseBridge — the ⌘W seam (mt#4059) > closes the ACTIVE tab [3.1ms]",
      "```",
    ].join("\n");
    const runOutput =
      "bun test v1.3.14\n(fail) TabCloseBridge — the ⌘W seam (mt#4059) > closes the ACTIVE tab [2.7ms]\n 3 pass\n 2 fail";
    const calls = findToolCallsWithResults(testRun(TEST_CMD, runOutput));
    expect(judgeClaims(record, calls)[0]?.verdict).toBe("discharged");
    // The duration differs between the paste and the re-run, which is why the
    // trailing `[N ms]` is stripped before comparing.
    expect(runOutput).not.toContain("[3.1ms]");
  });

  // -------------------------------------------------------------------------
  // mt#4067 — the quoted join accepts run output that is not a `(fail)` line.
  //
  // Measured over the live window (553 records / 96 fires): 58 fires had a
  // FAILING run in the same session and still fired. A share of them paste the
  // runner's SUMMARY or a hand-rolled harness table rather than `(fail)` lines,
  // which the join could not see. Paired same-corpus replay: 109 -> 106 fires.
  // -------------------------------------------------------------------------

  test("a pasted runner SUMMARY that appears verbatim in the run discharges", () => {
    const record = [
      "Negative control — reverted the guard and re-ran the suite:",
      "",
      "```",
      "Ran 5456 tests across 153 files. [21.61s]",
      "```",
    ].join("\n");
    const runOutput = "bun test v1.3.14\n 2 fail\nRan 5456 tests across 153 files. [21.61s]";
    const calls = findToolCallsWithResults(testRun(TEST_CMD, runOutput));
    expect(judgeClaims(record, calls)[0]?.verdict).toBe("discharged");
  });

  test("a hand-rolled harness result line discharges on a verbatim match", () => {
    const record = [
      "Negative control — the predicate run over 8 shapes:",
      "",
      "```",
      "PASS  expected=true  new=true  old=false z.coerce.number().optional()",
      "```",
    ].join("\n");
    const runOutput =
      "bun test harness\n 1 fail\nPASS  expected=true  new=true  old=false z.coerce.number().optional()";
    const calls = findToolCallsWithResults(testRun(TEST_CMD, runOutput));
    expect(judgeClaims(record, calls)[0]?.verdict).toBe("discharged");
  });

  // REGRESSION PIN for the defect the first cut of this tune introduced.
  // Widening the quoted set without splitting discharge from adjudicability let
  // a summary line make a record JUDGEABLE, so 22 records moved from
  // `unadjudicable` to `undischarged` and the live fire count went 108 -> 129 —
  // worse than the baseline it was meant to improve. The widened shapes are a
  // discharge signal only; only a `(fail)` line makes absence meaningful.
  test("a summary-only record with no subject stays UNADJUDICABLE, never a fire", () => {
    const record = [
      "Negative control — reverted and re-ran:",
      "",
      "```",
      "Ran 5456 tests across 153 files. [21.61s]",
      "```",
    ].join("\n");
    // A failing run exists, but nothing in it matches the paste.
    const calls = findToolCallsWithResults(
      testRun(TEST_CMD, "(fail) Unrelated > other [1ms]\n 1 fail")
    );
    const v = judgeClaims(record, calls)[0];
    expect(v?.kind).toBe("negative-control");
    expect(v?.verdict).toBe("unadjudicable");
    expect(v?.verdict).not.toBe("undischarged");
  });

  test("a fabricated SUMMARY paste does not discharge — the verbatim match still binds", () => {
    const record = [
      "Negative control — invented:",
      "",
      "```",
      "Ran 9999 tests across 999 files. [0.01s]",
      "```",
    ].join("\n");
    const calls = findToolCallsWithResults(testRun(TEST_CMD, "(fail) Real > case [1ms]\n 1 fail"));
    // It carries no `(fail)` line, so absence is not condemnable -> unadjudicable,
    // but crucially it is NOT discharged: the paste bought nothing.
    expect(judgeClaims(record, calls)[0]?.verdict).not.toBe("discharged");
  });

  // PR #3143 R1 — the reviewer's brittleness concern, pinned rather than argued.
  // Measured on the live corpus before responding: 0 of 186 real failing-run
  // tool results carry ANSI, and whitespace-collapsing or stack-stripping bought
  // ZERO additional discharges over 69 records. ANSI stripping is applied anyway
  // (semantics-preserving, so it cannot merge lines that differ in content);
  // whitespace collapsing is declined because it CAN, for no measured gain.

  test("ANSI colour in the run output does not defeat the join", () => {
    const record = [
      "Negative control — reverted and re-ran:",
      "",
      "```",
      "(fail) TabCloseBridge > closes the ACTIVE tab when one is focused",
      "```",
    ].join("\n");
    const coloured =
      "\u001b[31m(fail)\u001b[0m TabCloseBridge > closes the ACTIVE tab when one is focused\n 1 fail";
    const calls = findToolCallsWithResults(testRun(TEST_CMD, coloured));
    expect(judgeClaims(record, calls)[0]?.verdict).toBe("discharged");
  });

  test("differing internal whitespace still does NOT match — collapsing is declined", () => {
    // Characterizes the deliberate limit. Collapsing would discharge this, and it
    // measured zero real cases, so the join stays strict here.
    const record = [
      "Negative control:",
      "",
      "```",
      "(fail) TabCloseBridge  >  closes the ACTIVE tab when one is focused",
      "```",
    ].join("\n");
    const calls = findToolCallsWithResults(
      testRun(
        TEST_CMD,
        "(fail) TabCloseBridge > closes the ACTIVE tab when one is focused\n 1 fail"
      )
    );
    expect(judgeClaims(record, calls)[0]?.verdict).not.toBe("discharged");
  });

  test("a matching line beyond the 20th is still found — the cap is not a recall bound", () => {
    // R1 NON-BLOCKING: the first cut capped extraction at 20 lines, which could
    // drop the only line that would have discharged in a long pasted run.
    const filler = Array.from(
      { length: 30 },
      (_, i) => `(fail) FillerSuite > case number ${i} that is long enough to clear the floor`
    );
    const theMatch = "(fail) RealSuite > the only case that actually appears in the run output";
    const record = ["Negative control:", "", "```", ...filler, theMatch, "```"].join("\n");
    const calls = findToolCallsWithResults(testRun(TEST_CMD, `${theMatch}\n 1 fail`));
    expect(judgeClaims(record, calls)[0]?.verdict).toBe("discharged");
  });

  test("a FABRICATED paste matches nothing and still fires", () => {
    // The whole point of preferring the quoted join: it cannot be satisfied
    // without the run, so widening it to kill the false positives above does not
    // open a way to claim a control by writing one.
    const record = [
      "Negative control — invented:",
      "",
      "```",
      "(fail) SomeSuite (mt#0) > a case that was never actually run [1.0ms]",
      "```",
    ].join("\n");
    const calls = findToolCallsWithResults(testRun(TEST_CMD, "(fail) Unrelated > other [1ms]"));
    expect(judgeClaims(record, calls)[0]?.verdict).toBe("undischarged");
  });

  test("a record naming no subject is unadjudicable, never clean", () => {
    const verdicts = judgeClaims("Negative control: reverted it and saw red.", []);
    expect(verdicts[0]?.verdict).toBe("unadjudicable");
  });

  test("a fenced marker is quoted text, not a record (mt#3778 placement rule)", () => {
    const fenced = ["Some prose.", "", "```", "Negative control: reverted, saw red.", "```"].join(
      "\n"
    );
    expect(judgeClaims(fenced, [])).toHaveLength(0);
  });

  test("an execution-evidence block needs only that SOME test ran", () => {
    const body = "## Execution evidence\n\n```\n 5 pass 0 fail\n```\n";
    expect(judgeClaims(body, [])[0]).toMatchObject({
      kind: "execution-evidence",
      verdict: "undischarged",
    });
    const ran = findToolCallsWithResults(testRun(TEST_CMD, GREEN_RUN));
    expect(judgeClaims(body, ran)[0]?.verdict).toBe("discharged");
  });
});

// ---------------------------------------------------------------------------
// Artifact resolution across the three seams
// ---------------------------------------------------------------------------

describe("resolveArtifactText", () => {
  test("reads a commit message, a PR body, and a title", () => {
    expect(resolveArtifactText({ message: "m" })).toBe("m");
    expect(resolveArtifactText({ body: "b", title: "t" })).toBe("b\n\nt");
  });

  test("bodyPath is read even when a title is present — the R1 bypass", () => {
    // PR #2941 R1. `session_pr_create` REQUIRES `title`, so gating the bodyPath
    // read on "no inline field present" meant the file was never read on that
    // seam at all: the whole `--body-path` shape was a silent bypass, not a
    // corner case.
    const path = `${tmpdir()}/mt4044-bodypath-${process.pid}.md`;
    // eslint-disable-next-line custom/no-real-fs-in-tests -- see the import-site justification: a REAL file is the subject of this regression, since the defect was that the file was never read.
    writeFileSync(path, "Negative control — `theSubject`: reverted, saw red.\n");
    try {
      const text = resolveArtifactText({ title: "a title", bodyPath: path });
      expect(text).toContain("a title");
      expect(text).toContain("Negative control");
      // And it reaches the judgement, not just the string.
      expect(judgeClaims(text ?? "", [])[0]?.kind).toBe("negative-control");
    } finally {
      // eslint-disable-next-line custom/no-real-fs-in-tests -- cleanup for the real file written above.
      rmSync(path, { force: true });
    }
  });

  test("an unreadable bodyPath falls back to the inline text rather than discarding it", () => {
    // Losing the file can only lose a record (safe direction); returning null
    // would downgrade a real inline claim to `skipped` over a missing file.
    expect(resolveArtifactText({ title: "kept", bodyPath: "/nonexistent/mt4044.md" })).toBe("kept");
    expect(resolveArtifactText({ bodyPath: "/nonexistent/mt4044.md" })).toBeNull();
    expect(resolveArtifactText({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe("run", () => {
  test("fires on the incident, and stays silent once the control has run", () => {
    const withoutControl = run(
      commitInput(INCIDENT_MESSAGE),
      ctxWith([
        ...testRun(TEST_CMD, GREEN_RUN),
        ...testRun(`${TEST_CMD} PublishConversationDialog.test.tsx`, UNRELATED_FAILURE),
      ])
    );
    expect(withoutControl?.calibration?.["outcome"]).toBe("matched");
    // Record-only by design and by measurement — see INJECTS_NOTHING_BY_DESIGN.
    // Pinned as a test so a later change to inject has to be deliberate.
    expect(withoutControl?.additionalContext).toBeUndefined();

    const withControl = run(
      commitInput(INCIDENT_MESSAGE),
      ctxWith(testRun(`${TEST_CMD} SharedConversationPage.test.tsx`, SUBJECT_FAILURE))
    );
    expect(withControl?.additionalContext).toBeUndefined();
    expect(withControl?.calibration?.["outcome"]).toBe("clean");
  });

  test("an absent transcript is skipped, never clean", () => {
    // A guard whose no-transcript path returned a pass would report an outage as
    // a run of correct behavior.
    const outcome = run(commitInput(INCIDENT_MESSAGE), ctxWith([]));
    expect(outcome?.calibration?.["outcome"]).toBe("skipped");
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("a message with no evidence record is clean and silent", () => {
    const outcome = run(commitInput("fix(mt#1): tidy an import"), ctxWith(call("Bash", {}, "")));
    expect(outcome?.calibration?.["outcome"]).toBe("clean");
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("mentions-but-unmatched is its own outcome, so the MISS rate is measurable", () => {
    // ask#6982's armed evidence stream. Without this split, a formatting
    // mismatch is indistinguishable from a genuinely absent record, and every
    // future widening is argued from anecdote instead of a rate (mt#3511).
    const outcome = run(
      commitInput("fix(mt#1): tidy\n\nTODO: add a negative control for this later.\n"),
      ctxWith(call("Bash", {}, ""))
    );
    expect(outcome?.calibration?.["outcome"]).toBe("unmatched-shape");
  });

  test("the override is audited rather than silent", () => {
    process.env["MINSKY_SKIP_EVIDENCE_PROVENANCE"] = "1";
    try {
      const outcome = run(commitInput(INCIDENT_MESSAGE), ctxWith([]));
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
      expect(outcome?.additionalContext).toBeUndefined();
    } finally {
      delete process.env["MINSKY_SKIP_EVIDENCE_PROVENANCE"];
    }
  });

  test("the judged artifact is captured, so a calibration record can be replayed", () => {
    const outcome = run(commitInput(INCIDENT_MESSAGE), ctxWith(testRun(TEST_CMD, GREEN_RUN)));
    expect(outcome?.calibration?.["captureSchema"]).toBeNumber();
    expect(outcome?.calibration?.["judgedArtifact"]).toMatchObject({ truncated: false });
  });
});

describe("registration", () => {
  test("is calibration-first — asserted, not merely intended", () => {
    const reg = GUARD_REGISTRY.find((r) => r.name === "evidence-record-provenance");
    expect(reg?.denyCapable).toBe(false);
    // LOAD-BEARING: without it the dispatcher hands this guard no transcript and
    // it records `skipped` on every live run — present, tested, green, inert
    // (PR #2886 R1 on the sibling).
    expect(reg?.needsTranscript).toBe(true);
    expect(reg?.matcher).toContain("mcp__minsky__session_commit");
  });
});
