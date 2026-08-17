/* eslint-disable custom/no-real-fs-in-tests -- the dedup store (turn-end-scan-store.ts) writes real per-session JSON files; these tests exercise the real store roundtrip (write -> dedup-read) in an isolated mkdtemp dir, mirroring turn-end-unwalked-task-scan.test.ts's precedent */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
} from "./stop-at-decision-scan";
import type { RunDeps } from "./stop-at-decision-scan";
import type { TranscriptLine } from "./transcript";
import type { DispatchContext } from "./registry";
import type { StopHookInput } from "./turn-end-retro-scan";

/** The originating incident's ids: conversation bound to mt#3639, evidence into mt#3521. */
const BOUND_TASK = "mt#3639";
const TARGET_TASK = "mt#3521";
const SESSION_START_TOOL = "mcp__minsky__session_start";
const BOUND_TARGET_REASON = "bound-task-target";
const MARKER_REASON = "recommendation-marker";

/** The R5 closing message — a factual bound, no commitment phrase, no recommendation. */
const R5_FINAL_MESSAGE =
  "Both detector misses are now documented in the task record, and the measurement premise " +
  "was false: a Rung-1 miss wrote no record at all.";

function userPrompt(text: string, timestamp?: string): TranscriptLine {
  return { type: "user", message: { role: "user", content: text }, timestamp };
}

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
    ["mcp__minsky__tasks_status_set", { taskId: TARGET_TASK, status: "READY" }],
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
    expect(evaluations[0]?.["suppressionReasons"]).toContain(BOUND_TARGET_REASON);
  });

  test("a closed target suppresses (target-not-open); an unknown status fails open", () => {
    const closed = run(
      inputWith(R5_FINAL_MESSAGE),
      ctxFor(incidentTranscript()),
      depsWith({ [TARGET_TASK]: "DONE" })
    );
    expect(closed).toBeNull();
    expect(evaluations[0]?.["suppressionReasons"]).toContain("target-not-open");

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
