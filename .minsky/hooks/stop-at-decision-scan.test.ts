/* eslint-disable custom/no-real-fs-in-tests -- the dedup store (turn-end-scan-store.ts) writes real per-session JSON files; these tests exercise the real store roundtrip (write -> dedup-read) in an isolated mkdtemp dir, mirroring turn-end-unwalked-task-scan.test.ts's precedent */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectBoundTaskIds,
  detectDecisionStop,
  run,
  EVIDENCE_TOOL,
  EVIDENCE_COMPANION_TOOL,
  RECOMMENDATION_MARKERS_BASELINE,
  RECOMMENDATION_MARKERS_MT4085,
  RECOMMENDATION_MARKER_REASON,
  READ_ONLY_SESSION_PR_TOOLS,
} from "./stop-at-decision-scan";
import type { RunDeps } from "./stop-at-decision-scan";
import { CONDITIONAL_WAIT_TOOL } from "./armed-watcher";
import type { TranscriptLine } from "./transcript";
import type { DispatchContext } from "./registry";
import type { StopHookInput } from "./turn-end-retro-scan";

/** The originating incident's ids: conversation bound to mt#3639, evidence into mt#3521. */
const BOUND_TASK = "mt#3639";
const TARGET_TASK = "mt#3521";
const SESSION_START_TOOL = "mcp__minsky__session_start";
/** Declared once — mt#4228 added a second cluster of cases that name it. */
const STATUS_SET_TOOL_NAME = "mcp__minsky__tasks_status_set";
const BOUND_TARGET_REASON = "bound-task-target";
/** Aliased from the hook's export — one source of truth for the reason string. */
const MARKER_REASON = RECOMMENDATION_MARKER_REASON;

/** The R5 closing message — a factual bound, no commitment phrase, no recommendation. */
const R5_FINAL_MESSAGE =
  "Both detector misses are now documented in the task record, and the measurement premise " +
  "was false: a Rung-1 miss wrote no record at all.";

function userPrompt(text: string, timestamp?: string): TranscriptLine {
  return { type: "user", message: { role: "user", content: text }, timestamp };
}

/** Watcher tool names used by the mt#4327 fixtures. */
const WAIT_REVIEW_TOOL = "mcp__minsky__session_pr_wait-for-review";
const BASH_BG_EVIDENCE = "Bash(run_in_background)";

/** Field read off an evaluation record. */
const SUPPRESSION_REASONS_FIELD = "suppressionReasons";

/**
 * The conditional watcher: a wait only when `wait: true` is passed (mt#4327).
 *
 * Taken from the module rather than re-spelled here. The literal itself is
 * pinned by `turn-end-untaken-action-scan.test.ts`, which asserts
 * `ARMED_WAIT_TOOLS`'s exact contents — so spelling it again here would add a
 * second place to update without adding a second check.
 */
const CHECKS_TOOL = CONDITIONAL_WAIT_TOOL;

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  };
}

/** User-role by construction (the real transcript shape) but not a real prompt. */
function toolResult(useId: string, payload: unknown): TranscriptLine {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: useId, content: JSON.stringify(payload) }],
    },
  };
}

/** An earlier working turn that BINDS the conversation to mt#3639 via a session tool. */
function bindingPrefix(): TranscriptLine[] {
  return [
    userPrompt("fix the asks page rendering"),
    toolUse("toolu_bind", "mcp__minsky__session_commit", {
      task: BOUND_TASK,
      message: "fix rendering",
    }),
    toolResult("toolu_bind", { success: true }),
  ];
}

/**
 * The final turn of the originating incident: a spec-patch writing evidence
 * into TARGET_TASK (not the bound task), tool-interleaved (the tool_result
 * user-role line falls INSIDE the turn — the mem a3e60471 fixture shape),
 * ending with no discharge call.
 */
function evidenceOnlyFinalTurn(): TranscriptLine[] {
  return [
    userPrompt("why did no retrospective fire on that correction?", "2026-08-03T23:00:00Z"),
    toolUse("toolu_patch", EVIDENCE_TOOL, {
      taskId: TARGET_TASK,
      content: "## Evidence\n\nRung-1 misses wrote no record.",
    }),
    toolResult("toolu_patch", { success: true }),
  ];
}

function incidentTranscript(extraFinalTurnLines: TranscriptLine[] = []): TranscriptLine[] {
  return [...bindingPrefix(), ...evidenceOnlyFinalTurn(), ...extraFinalTurnLines];
}

function ctxFor(lines: TranscriptLine[]): DispatchContext {
  return { transcriptLines: lines } as unknown as DispatchContext;
}

function inputWith(finalMessage: string): StopHookInput {
  return {
    session_id: "mt3653-test",
    last_assistant_message: finalMessage,
    cwd: process.cwd(),
  } as StopHookInput;
}

/** Slice the final turn out of a full transcript the way run() does. */
function finalTurnOf(lines: TranscriptLine[]): TranscriptLine[] {
  let lastPrompt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as TranscriptLine;
    const content = line.message?.content;
    if (line.type === "user" && typeof content === "string") lastPrompt = i;
  }
  return lines.slice(lastPrompt + 1);
}

describe("collectBoundTaskIds", () => {
  test("collects task ids from session-tool calls anywhere in the transcript", () => {
    expect(collectBoundTaskIds(incidentTranscript())).toEqual(new Set([BOUND_TASK]));
  });

  test("ignores non-session tools and non-task-shaped values", () => {
    const lines = [
      toolUse("t1", "mcp__minsky__tasks_status_set", { taskId: "mt#1" }),
      toolUse("t2", SESSION_START_TOOL, { task: "not-a-task-id" }),
    ];
    expect(collectBoundTaskIds(lines)).toEqual(new Set());
  });
});

describe("detectDecisionStop (pure core)", () => {
  test("AT1 signature: evidence-write to a non-bound task, no discharge, no marker", () => {
    const full = incidentTranscript();
    const detection = detectDecisionStop(finalTurnOf(full), full, R5_FINAL_MESSAGE);
    expect(detection).not.toBeNull();
    expect(detection?.candidateTaskIds).toEqual([TARGET_TASK]);
    expect(detection?.suppressionReasons).toEqual([]);
  });

  test("returns null when the turn has no spec-patch at all", () => {
    const full = [...bindingPrefix(), userPrompt("status?"), toolUse("t", "Bash", {})];
    expect(detectDecisionStop(finalTurnOf(full), full, "all quiet")).toBeNull();
  });

  // AT2 — the same evidence-write turn, discharged. Each consumer call must silence it.
  test.each([
    ["mcp__minsky__asks_create", { question: "Rung-2 disposition?", parentTaskId: TARGET_TASK }],
    // IN-PROGRESS, not READY (mt#4228). This row asserts that the tool
    // discharges; a transition INTO READY no longer does, because it OPENS a
    // hand-off rather than walking one. The READY and PLANNING cases are
    // asserted directly in the `hand-off-qualified suppressions` block below,
    // so the behaviour this row used to cover is still pinned — by the test
    // that is actually about it.
    [STATUS_SET_TOOL_NAME, { taskId: TARGET_TASK, status: "IN-PROGRESS" }],
    ["mcp__minsky__tasks_dispatch", { taskId: TARGET_TASK }],
    ["mcp__minsky__tasks_create", { title: "follow-up" }],
    [SESSION_START_TOOL, { task: "mt#9999" }],
    ["Skill", { skill: "plan-task", args: TARGET_TASK }],
  ])("suppresses when the turn also called %s", (tool, input) => {
    const full = incidentTranscript([
      toolUse("toolu_discharge", tool as string, input as Record<string, unknown>),
    ]);
    const detection = detectDecisionStop(finalTurnOf(full), full, R5_FINAL_MESSAGE);
    expect(detection?.suppressionReasons.some((r) => r.startsWith("discharged:"))).toBe(true);
  });

  // PR #2611 R1 — a same-turn session_start FOR THE TARGET suppresses through
  // BOTH paths: the explicit discharge entry, and the bound-task derivation
  // (collectBoundTaskIds scans the full transcript including the firing turn,
  // so the target lands in the bound set). Assert both reasons so a future
  // change to either path keeps the other covering this case.
  test("session_start for the target task suppresses via discharge AND binding", () => {
    const full = incidentTranscript([
      toolUse("toolu_start", SESSION_START_TOOL, { task: TARGET_TASK }),
    ]);
    const detection = detectDecisionStop(finalTurnOf(full), full, R5_FINAL_MESSAGE);
    expect(detection?.candidateTaskIds).toEqual([]);
    expect(detection?.suppressionReasons).toContain(BOUND_TARGET_REASON);
    expect(detection?.suppressionReasons.some((r) => r.startsWith("discharged:"))).toBe(true);
  });

  // AT3 — evidence into the conversation's OWN task is progress recording.
  test("suppresses when the spec-patch targets the bound task", () => {
    const full = [
      ...bindingPrefix(),
      userPrompt("record the outcome", "2026-08-03T23:30:00Z"),
      toolUse("toolu_own", EVIDENCE_TOOL, { taskId: BOUND_TASK, content: "## Outcome" }),
      toolResult("toolu_own", { success: true }),
    ];
    const detection = detectDecisionStop(finalTurnOf(full), full, R5_FINAL_MESSAGE);
    expect(detection?.candidateTaskIds).toEqual([]);
    expect(detection?.suppressionReasons).toContain(BOUND_TARGET_REASON);
  });

  test("suppresses a working turn (code/session mutations beside the spec-patch)", () => {
    const full = incidentTranscript([
      toolUse("toolu_work", "mcp__minsky__session_write_file", { path: "src/x.ts" }),
    ]);
    const detection = detectDecisionStop(finalTurnOf(full), full, R5_FINAL_MESSAGE);
    expect(detection?.suppressionReasons).toContain("working-turn");
  });

  test("suppresses when the closing message carries a recommendation marker", () => {
    const full = incidentTranscript();
    const detection = detectDecisionStop(
      finalTurnOf(full),
      full,
      "Evidence recorded. My recommendation: escalate to Rung 3."
    );
    expect(detection?.suppressionReasons).toContain(MARKER_REASON);
  });

  test("counts memory_create as evidence, not as discharge", () => {
    const full = incidentTranscript([
      toolUse("toolu_mem", EVIDENCE_COMPANION_TOOL, { name: "finding", content: "x" }),
    ]);
    const detection = detectDecisionStop(finalTurnOf(full), full, R5_FINAL_MESSAGE);
    expect(detection?.suppressionReasons).toEqual([]);
    expect(detection?.memoryCreateCount).toBe(1);
  });
});

describe("run — status filter, dedup, evaluation stream (AT1-AT3 end-to-end)", () => {
  let storeDir: string;
  let evaluations: Array<Record<string, unknown>>;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "mt3653-"));
    evaluations = [];
  });
  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  function depsWith(statusByTask: Record<string, string | undefined>): RunDeps {
    return {
      readTaskStatusFn: (taskId: string) => statusByTask[taskId],
      appendEvaluationRecordFn: (_cwd, record) => {
        evaluations.push(record);
      },
      storeDir,
    };
  }

  test("AT1: the originating incident produces one calibration record naming the target", () => {
    const outcome = run(
      inputWith(R5_FINAL_MESSAGE),
      ctxFor(incidentTranscript()),
      depsWith({ [TARGET_TASK]: "TODO" })
    );
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toBeUndefined();
    const targets = outcome?.calibration?.["targets"] as Array<{ taskId: string; status: string }>;
    expect(targets).toEqual([{ taskId: TARGET_TASK, status: "TODO" }]);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.["fired"]).toBe(true);
  });

  test("AT2: an asks_create in the same turn produces no record, and the evaluation says why", () => {
    const outcome = run(
      inputWith(R5_FINAL_MESSAGE),
      ctxFor(incidentTranscript([toolUse("toolu_ask", "mcp__minsky__asks_create", {})])),
      depsWith({ [TARGET_TASK]: "TODO" })
    );
    expect(outcome).toBeNull();
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.["fired"]).toBe(false);
  });

  test("AT3: a spec-patch to the bound task produces no record", () => {
    const full = [
      ...bindingPrefix(),
      userPrompt("record the outcome", "2026-08-03T23:30:00Z"),
      toolUse("toolu_own", EVIDENCE_TOOL, { taskId: BOUND_TASK, content: "## Outcome" }),
      toolResult("toolu_own", { success: true }),
    ];
    const outcome = run(inputWith(R5_FINAL_MESSAGE), ctxFor(full), depsWith({}));
    expect(outcome).toBeNull();
    expect(evaluations[0]?.[SUPPRESSION_REASONS_FIELD]).toContain(BOUND_TARGET_REASON);
  });

  test("a closed target suppresses (target-not-open); an unknown status fails open", () => {
    const closed = run(
      inputWith(R5_FINAL_MESSAGE),
      ctxFor(incidentTranscript()),
      depsWith({ [TARGET_TASK]: "DONE" })
    );
    expect(closed).toBeNull();
    expect(evaluations[0]?.[SUPPRESSION_REASONS_FIELD]).toContain("target-not-open");

    const unknown = run(
      inputWith(R5_FINAL_MESSAGE),
      ctxFor(incidentTranscript()),
      depsWith({ [TARGET_TASK]: undefined })
    );
    expect(unknown).not.toBeNull();
    const targets = unknown?.calibration?.["targets"] as Array<{ taskId: string; status: string }>;
    expect(targets).toEqual([{ taskId: TARGET_TASK, status: "unknown" }]);
  });

  test("dedup: a Stop re-entry for the same turn writes neither a second record nor a second evaluation", () => {
    const deps = depsWith({ [TARGET_TASK]: "TODO" });
    const first = run(inputWith(R5_FINAL_MESSAGE), ctxFor(incidentTranscript()), deps);
    expect(first).not.toBeNull();
    const second = run(inputWith(R5_FINAL_MESSAGE), ctxFor(incidentTranscript()), deps);
    expect(second).toBeNull();
    expect(evaluations).toHaveLength(1);
  });

  test("returns null (no evaluation write) on a turn with no spec-patch", () => {
    const full = [...bindingPrefix(), userPrompt("thanks"), toolUse("t", "Bash", {})];
    const outcome = run(inputWith("done"), ctxFor(full), depsWith({}));
    expect(outcome).toBeNull();
    expect(evaluations).toHaveLength(0);
  });
});

describe("mt#4085 — the natural-prose decision handoff", () => {
  /**
   * Verbatim tails of records the 2026-08-13 calibration pass classified FALSE.
   * Sampled from `.minsky/stop-at-decision-calibration.jsonl`, not paraphrased:
   * a detector fixture is an input drawn from the matcher's domain, and
   * paraphrasing silently moves it out (mem#1020).
   */
  const CORPUS_HANDOFFS: ReadonlyArray<readonly [string, string]> = [
    [
      "possessive-inversion / yours to set (2026-08-10T15:24:57Z)",
      "I didn't start mt#3897, even though its blocker cleared — a pending option on " +
        "ask#7639 could reverse it, and detector enforcement posture is yours to set.",
    ],
    [
      "possessive-inversion / yours to call (2026-08-10T17:40:01Z)",
      "Confirming whether that peer is done is yours to call.",
    ],
    [
      "nominalized / the decision reduces to (2026-08-11T20:29:00Z)",
      "The decision reduces to which strain you'd rather live with: family-spanning " +
        "entities, a nameless column header, an over-claiming guard, or a bet on a Draft.",
    ],
    [
      "nominalized / the choice it has to make (2026-08-12T00:20:22Z)",
      "Both findings are now written into mt#4010's spec, including the choice it has " +
        "to make: absorb the interlock page, or state a division of labor.",
    ],
    [
      "position-stating / my three positions (2026-08-12T21:51:50Z)",
      "Still open from last turn, and unchanged by the interruption: my three positions " +
        "— the pending request should be held by the task rather than the conversation.",
    ],
  ];

  /**
   * The two records the pass could not classify. Both stored tails are UNDER the
   * 600-char cutoff (232 and 213 chars), so these are the COMPLETE messages the
   * detector judged — which is what makes them usable as a negative control at
   * all. A truncated control would prove nothing: a candidate could match text
   * outside the stored window and silence it while the replay reported it firing.
   */
  const CORPUS_CONTROLS: ReadonlyArray<readonly [string, string]> = [
    [
      "uncertain (2026-08-08T23:46:04Z)",
      "The task I've been working in is mt#3514 — the scope note above refers to its four " +
        "original criteria, which remain open; only the orphan-removal criterion is " +
        "implemented and waiting on that commit command.",
    ],
    [
      "uncertain (2026-08-10T11:24:38Z)",
      "Not a new retrospective case — that sentence is reporting the R4 analysis I just " +
        "completed and recorded in mem#612 and mt#2447, not surfacing a fresh failure.\n\n" +
        "Waiting on your token; nothing else is blocked on me.",
    ],
  ];

  const suppressionFor = (message: string): string[] => {
    const full = incidentTranscript();
    return detectDecisionStop(finalTurnOf(full), full, message)?.suppressionReasons ?? [];
  };

  describe("negative control on the FIXTURES themselves — these must have failed before", () => {
    // Without this, every AT1 assertion below would pass on a marker the BASELINE
    // already carried, and the test would be green whether or not mt#4085 shipped.
    // That is the non-discriminating-acceptance-test class of mt#4114.
    test.each(CORPUS_HANDOFFS)("%s is NOT matched by the pre-mt#4085 baseline", (_label, text) => {
      expect(RECOMMENDATION_MARKERS_BASELINE.some((re) => re.test(text))).toBe(false);
    });

    test.each(CORPUS_HANDOFFS)("%s IS matched by the mt#4085 additions", (_label, text) => {
      expect(RECOMMENDATION_MARKERS_MT4085.some((re) => re.test(text))).toBe(true);
    });
  });

  describe("AT1 — each corpus phrase suppresses the fire", () => {
    test.each(CORPUS_HANDOFFS)("%s", (_label, text) => {
      expect(suppressionFor(text)).toContain(MARKER_REASON);
    });
  });

  describe("AT2 — the two uncertain records still fire (negative control)", () => {
    test.each(CORPUS_CONTROLS)("%s is not silenced", (_label, text) => {
      expect(RECOMMENDATION_MARKERS_MT4085.some((re) => re.test(text))).toBe(false);
      expect(suppressionFor(text)).not.toContain(MARKER_REASON);
    });
  });

  test("AT3 — an evidence-write closing with a bare status recap still fires", () => {
    const recap =
      "Both detector misses are now documented in the task record, and the measurement " +
      "premise was false: a Rung-1 miss wrote no record at all.";
    const reasons = suppressionFor(recap);
    expect(reasons).not.toContain(MARKER_REASON);
    expect(reasons).toEqual([]);
  });

  describe("PR #3037 R1 — bounding the breadth of /\\byours to \\w+/", () => {
    /**
     * The review asked whether the open `\w+` should be narrowed to a verb set
     * like `set|call|decide|choose`. Measured against the recovered corpus (533
     * evaluated turns) before answering: every verb that actually follows
     * "yours to" is a decision verb —
     *
     *   authorize 4, decide 3, resolve 2, route 1, clear 1, pick 1,
     *   write 1, set 1, make 1, call 1, reverse 1, certify 1
     *
     * — 12 distinct verbs, and the suggested allowlist would have caught 4 of
     * them. Narrowing would reintroduce exactly the recall failure this task
     * exists to fix, so the pattern stays open and these tests bound it instead,
     * which is the alternative the review itself offered.
     */
    test.each([
      "authorize",
      "decide",
      "resolve",
      "route",
      "clear",
      "pick",
      "write",
      "set",
      "make",
      "call",
      "reverse",
      "certify",
    ])("a decision verb observed in the corpus matches: yours to %s", (verb) => {
      expect(
        RECOMMENDATION_MARKERS_MT4085.some((re) => re.test(`that one is yours to ${verb}`))
      ).toBe(true);
    });

    test("the possessive-inversion pattern requires the 'yours to' construction", () => {
      // Bounds the pattern from the other side: "yours" alone, or a possessive
      // without the infinitive, is not a decision handoff.
      for (const text of [
        "the remaining budget is yours",
        "yours truly",
        "this workspace is yours and mine",
      ]) {
        expect(RECOMMENDATION_MARKERS_MT4085.some((re) => re.test(text))).toBe(false);
      }
    });
  });

  test("the addition does not silence the residual class it deliberately excludes", () => {
    // Four records in the same window were classified false and are NOT addressed
    // here: they narrate the evidence-write rather than handing a decision over.
    // Pinned so a later widening that swallows them breaks a test rather than
    // drifting — suppressing this shape would match nearly every evaluated turn,
    // since an evidence-write IS this detector's trigger condition.
    const narratesTheWrite =
      "Two corrections recorded: the rewrite trigger I'd captured was wrong, and the Rust " +
      "spike isn't a drop-in reference. I've recorded that and withdrawn the gap.";
    expect(RECOMMENDATION_MARKERS_MT4085.some((re) => re.test(narratesTheWrite))).toBe(false);
  });
});

describe("armed-watcher suppression (mt#4327)", () => {
  // A turn that armed a wait is MID-FLIGHT: it has nothing to mint YET, so it is
  // not at a decision, ripe or otherwise. Every fixture below closes with prose
  // that says nothing about waiting, so a phrase-matching suppressor could not
  // separate them from the regression floor — which is the point of SC2.
  const SILENT_ABOUT_WAITING = "Patched the finding into the spec.";

  function detectWith(extra: TranscriptLine[]) {
    const full = incidentTranscript(extra);
    return detectDecisionStop(finalTurnOf(full), full, SILENT_ABOUT_WAITING);
  }

  test("AT1: a tool that IS an armed wait suppresses, and names itself as the evidence", () => {
    const detection = detectWith([
      // No `task` argument on any watcher fixture below: a session tool carrying
      // one BINDS the conversation to it, which empties candidateTaskIds and
      // raises `bound-task-target` instead — a different suppression confounding
      // the one under test.
      toolUse("toolu_wait", WAIT_REVIEW_TOOL, {
        reviewer: "minsky-reviewer[bot]",
      }),
    ]);
    expect(detection?.armedWatcherEvidence).toEqual([WAIT_REVIEW_TOOL]);
    expect(detection?.suppressionReasons).toContain(`armed-watcher:${WAIT_REVIEW_TOOL}`);
  });

  test("AT1: session_pr_checks asked to wait suppresses", () => {
    const detection = detectWith([toolUse("toolu_checks", CHECKS_TOOL, { wait: true })]);
    expect(detection?.armedWatcherEvidence).toEqual([CHECKS_TOOL]);
  });

  test("AT1: a backgrounded Bash call suppresses", () => {
    const detection = detectWith([
      toolUse("toolu_bg", "Bash", { command: "sleep 30", run_in_background: true }),
    ]);
    expect(detection?.armedWatcherEvidence).toEqual([BASH_BG_EVIDENCE]);
  });

  test("the same tool WITHOUT its wait flag does not suppress — the gate is the flag, not the name", () => {
    // Discriminating control. Without `wait: true` the call is a one-shot
    // snapshot read and no watcher survives it, so this turn really did stop. A
    // suppressor keyed on the tool NAME passes all three tests above and is
    // still wrong here; only this case separates the two implementations.
    const detection = detectWith([toolUse("toolu_checks", CHECKS_TOOL, {})]);
    expect(detection?.armedWatcherEvidence).toEqual([]);
    expect(detection?.suppressionReasons).toEqual([]);
  });

  test("AT2 regression floor: a turn that armed nothing still fires, field written empty", () => {
    const detection = detectWith([]);
    expect(detection?.suppressionReasons).toEqual([]);
    expect(detection?.armedWatcherEvidence).toEqual([]);
  });

  test("multiple armed waits render in a stable order, whatever order the turn used", () => {
    // PR #3402 R1: the reason string is what calibration review GROUPS by, so a
    // pair armed in one order and the same pair armed in the other must produce
    // ONE string, not two. The fixture arms them in reverse of the expected
    // output on purpose — insertion order would fail this, sorting passes it.
    const detection = detectWith([
      toolUse("toolu_wait", WAIT_REVIEW_TOOL, {
        reviewer: "minsky-reviewer[bot]",
      }),
      toolUse("toolu_bg", "Bash", { command: "sleep 30", run_in_background: true }),
    ]);
    expect(detection?.armedWatcherEvidence).toEqual([BASH_BG_EVIDENCE, WAIT_REVIEW_TOOL]);
    expect(detection?.suppressionReasons).toContain(
      `armed-watcher:${BASH_BG_EVIDENCE},${WAIT_REVIEW_TOOL}`
    );
  });

  describe("AT3 — the evidence reaches the record, suppressed or not", () => {
    let storeDir: string;
    let evaluations: Array<Record<string, unknown>>;

    beforeEach(() => {
      storeDir = mkdtempSync(join(tmpdir(), "mt4327-"));
      evaluations = [];
    });
    afterEach(() => {
      rmSync(storeDir, { recursive: true, force: true });
    });

    test("a suppressed turn records armedWatcherEvidence naming what suppressed it", () => {
      const outcome = run(
        inputWith(SILENT_ABOUT_WAITING),
        ctxFor(
          incidentTranscript([
            toolUse("toolu_wait", "mcp__minsky__deployment_wait-for-latest", {
              service: "minsky-mcp",
            }),
          ])
        ),
        {
          readTaskStatusFn: () => "TODO",
          appendEvaluationRecordFn: (_cwd, record) => {
            evaluations.push(record);
          },
          storeDir,
        }
      );

      expect(outcome).toBeNull();
      expect(evaluations).toHaveLength(1);
      expect(evaluations[0]?.["fired"]).toBe(false);
      // The whole point of SC3: "not a stop" is now distinguishable from "no gap
      // found" without re-deriving it from the turn.
      expect(evaluations[0]?.["armedWatcherEvidence"]).toEqual([
        "mcp__minsky__deployment_wait-for-latest",
      ]);
      expect(evaluations[0]?.[SUPPRESSION_REASONS_FIELD]).toContain(
        "armed-watcher:mcp__minsky__deployment_wait-for-latest"
      );
    });
  });
});

describe("hand-off-qualified suppressions (mt#4228)", () => {
  /** A closing message with no recommendation marker, so only the suppressions under test can fire. */
  const R6_FINAL_MESSAGE =
    "mt#3845 is out of BLOCKED and back in PLANNING with all of this recorded. " +
    "PR #3078 is open against the same two files, so that should land first.";

  /** Detect, assert the turn was a candidate at all, and hand back a non-null result. */
  function mustDetect(full: TranscriptLine[]): NonNullable<ReturnType<typeof detectDecisionStop>> {
    const detection = detectDecisionStop(finalTurnOf(full), full, R6_FINAL_MESSAGE);
    expect(detection).not.toBeNull();
    return detection as NonNullable<typeof detection>;
  }

  test("R6: a spec-patch + a transition INTO PLANNING + a scratch write now FIRES", () => {
    // The verbatim shape of the 2026-08-17 incident, from the detector's own
    // evaluation record: candidate mt#3845, one spec patch, suppressed by
    // `discharged:mcp__minsky__tasks_status_set` and `working-turn`.
    const detection = mustDetect(
      incidentTranscript([
        toolUse("toolu_status", STATUS_SET_TOOL_NAME, {
          taskId: TARGET_TASK,
          status: "PLANNING",
        }),
        toolResult("toolu_status", { success: true }),
        toolUse("toolu_scratch", "Write", {
          file_path: "/private/tmp/claude-501/proj/sess/scratchpad/runs.ts",
          content: "// measurement script",
        }),
        toolResult("toolu_scratch", { success: true }),
      ])
    );

    expect(detection.candidateTaskIds).toEqual([TARGET_TASK]);
    expect(detection.suppressionReasons).toEqual([]);
  });

  test("a transition to IN-PROGRESS still discharges — only hand-off states changed", () => {
    const detection = mustDetect(
      incidentTranscript([
        toolUse("toolu_status", STATUS_SET_TOOL_NAME, {
          taskId: TARGET_TASK,
          status: "IN-PROGRESS",
        }),
        toolResult("toolu_status", { success: true }),
      ])
    );

    expect(detection.suppressionReasons).toContain(`discharged:${STATUS_SET_TOOL_NAME}`);
    expect(detection.dischargeToolsSeen).toEqual([STATUS_SET_TOOL_NAME]);
  });

  test("an unparseable status FAILS OPEN and still discharges", () => {
    const detection = mustDetect(
      incidentTranscript([
        toolUse("toolu_status", STATUS_SET_TOOL_NAME, { taskId: TARGET_TASK }),
        toolResult("toolu_status", { success: true }),
      ])
    );

    expect(detection.suppressionReasons).toContain(`discharged:${STATUS_SET_TOOL_NAME}`);
  });

  test("a REPO write still marks the turn as working", () => {
    // The path predicate must not swallow real work — this is the half that
    // keeps the `working-turn` suppression meaningful.
    const detection = mustDetect(
      incidentTranscript([
        toolUse("toolu_repo", "Write", {
          file_path: "/Users/edobry/Projects/minsky/src/thing.ts",
          content: "export const x = 1;",
        }),
        toolResult("toolu_repo", { success: true }),
      ])
    );

    expect(detection.suppressionReasons).toContain("working-turn");
  });

  test("a scratch write BESIDE a repo write still marks the turn as working", () => {
    const detection = mustDetect(
      incidentTranscript([
        toolUse("toolu_scratch", "Write", { file_path: "/tmp/probe.ts", content: "//" }),
        toolResult("toolu_scratch", { success: true }),
        toolUse("toolu_repo", "Edit", {
          file_path: "/Users/edobry/Projects/minsky/src/thing.ts",
          old_string: "a",
          new_string: "b",
        }),
        toolResult("toolu_repo", { success: true }),
      ])
    );

    expect(detection.suppressionReasons).toContain("working-turn");
  });

  test("a READ-ONLY session_pr_* call is not work — this is what kept R6 suppressed", () => {
    // The `mcp__minsky__session_pr_` prefix matched the whole family. Listing
    // PRs is investigation, which is the trigger condition, not a reason to
    // suppress. Found by replay: the R6 turn's `working-turn` came from one
    // `session_pr_list` and survived both qualifications the task was scoped to.
    const detection = mustDetect(
      incidentTranscript([
        toolUse("toolu_list", "mcp__minsky__session_pr_list", { status: "open" }),
        toolResult("toolu_list", { pullRequests: [] }),
      ])
    );

    expect(detection.suppressionReasons).toEqual([]);
  });

  test("a MUTATING session_pr_* call is still work", () => {
    // The other half of the family must keep suppressing, or the exclusion has
    // swallowed the rule instead of narrowing it.
    for (const tool of [
      "mcp__minsky__session_pr_create",
      "mcp__minsky__session_pr_merge",
      "mcp__minsky__session_pr_edit",
    ]) {
      const detection = mustDetect(
        incidentTranscript([
          toolUse("toolu_mutate", tool, { task: TARGET_TASK }),
          toolResult("toolu_mutate", { success: true }),
        ])
      );
      expect(detection.suppressionReasons).toContain("working-turn");
    }
  });

  test("every READ_ONLY_SESSION_PR_TOOLS entry names a real command (PR #3090 R1)", () => {
    // R1 flagged the hyphen in `…session_pr_wait-for-review` as a typo. It is
    // not: that command's id is `session.pr.wait-for-review`, so the leaf name
    // itself carries a hyphen and the MCP name keeps it. Pinned against the
    // GENERATED manifest rather than a hand-written list, so an entry that
    // matches nothing fails here instead of silently never suppressing —
    // which is exactly the failure mode the finding was worried about, caught
    // by a mechanism rather than by agreeing with it.
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "src/generated/completion-manifest.json"), "utf8")
    ) as unknown;
    const ids = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return void node.forEach(walk);
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const id = record["commandId"];
      if (typeof id === "string") ids.add(`mcp__minsky__${id.replace(/\./g, "_")}`);
      Object.values(record).forEach(walk);
    };
    walk(manifest);

    expect(ids.size).toBeGreaterThan(50);
    for (const tool of READ_ONLY_SESSION_PR_TOOLS) {
      expect(ids.has(tool)).toBe(true);
    }
  });

  test("a hand-off status-set is RECORDED as seen-but-not-discharging", () => {
    // The calibration stream must still be able to tell "no status-set call"
    // from "a status-set call that opened a hand-off" (PR #3090 R1,
    // non-blocking) — `dischargeToolsSeen` alone can no longer distinguish them.
    const handoff = mustDetect(
      incidentTranscript([
        toolUse("toolu_status", STATUS_SET_TOOL_NAME, {
          taskId: TARGET_TASK,
          status: "PLANNING",
        }),
        toolResult("toolu_status", { success: true }),
      ])
    );
    expect(handoff.dischargeToolsSeen).toEqual([]);
    expect(handoff.statusSetSeenButNotDischarging).toBe(true);

    const forward = mustDetect(
      incidentTranscript([
        toolUse("toolu_status", STATUS_SET_TOOL_NAME, {
          taskId: TARGET_TASK,
          status: "DONE",
        }),
        toolResult("toolu_status", { success: true }),
      ])
    );
    expect(forward.statusSetSeenButNotDischarging).toBe(false);

    // No call at all is also false — the flag means "seen AND not discharging".
    expect(mustDetect(incidentTranscript()).statusSetSeenButNotDischarging).toBe(false);
  });

  test("a session write is working regardless of path — no path check applies to it", () => {
    const detection = mustDetect(
      incidentTranscript([
        toolUse("toolu_sess", "mcp__minsky__session_write_file", {
          sessionId: "s",
          path: "/tmp/whatever.ts",
          content: "//",
        }),
        toolResult("toolu_sess", { success: true }),
      ])
    );

    expect(detection.suppressionReasons).toContain("working-turn");
  });
});
