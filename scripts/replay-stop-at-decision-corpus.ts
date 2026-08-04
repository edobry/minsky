#!/usr/bin/env bun
/**
 * Parity probe for the stop-at-decision scan (mt#3653 AT4).
 *
 * `--probe` (also the default mode) runs a canonical fixture set through BOTH
 * the source detector (`.minsky/hooks/stop-at-decision-scan.ts`) and the
 * generated `.claude/hooks` copy the harness actually executes, and fails if
 * they disagree or if any fixture's expectation is unmet — a missed recompile
 * and a regression both surface as a non-zero exit.
 *
 *     bun scripts/replay-stop-at-decision-corpus.ts --probe
 *
 * No transcript-corpus replay mode yet, deliberately: the detector's trigger
 * needs per-conversation bound-task resolution plus target-status reads, so a
 * meaningful corpus replay is the calibration review's job once live records
 * accumulate (the evaluation stream carries the denominator). The fixture
 * set here is the originating-incident signature plus each suppression leg.
 */
import { detectDecisionStop as detectFromSource } from "../.minsky/hooks/stop-at-decision-scan";
import { detectDecisionStop as detectFromGenerated } from "../.claude/hooks/stop-at-decision-scan";
import type { TranscriptLine } from "../.minsky/hooks/transcript";

const BOUND_TASK = "mt#3639";
const TARGET_TASK = "mt#3521";
const R5_FINAL_MESSAGE =
  "Both detector misses are now documented in the task record, and the measurement premise " +
  "was false: a Rung-1 miss wrote no record at all.";

function userPrompt(text: string): TranscriptLine {
  return { type: "user", message: { role: "user", content: text } };
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  };
}

function toolResult(useId: string, payload: unknown): TranscriptLine {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: useId, content: JSON.stringify(payload) }],
    },
  };
}

function bindingPrefix(): TranscriptLine[] {
  return [
    userPrompt("fix the asks page rendering"),
    toolUse("t_bind", "mcp__minsky__session_commit", { task: BOUND_TASK, message: "fix" }),
    toolResult("t_bind", { success: true }),
  ];
}

function evidenceFinalTurn(target: string, extra: TranscriptLine[] = []): TranscriptLine[] {
  return [
    userPrompt("why did no retrospective fire?"),
    toolUse("t_patch", "mcp__minsky__tasks_spec_patch", { taskId: target, content: "## Evidence" }),
    toolResult("t_patch", { success: true }),
    ...extra,
  ];
}

interface Fixture {
  note: string;
  full: TranscriptLine[];
  finalMessage: string;
  /** Expected verdict from the PURE core: does the structural signature hold? */
  expect: "fire" | "silent";
}

const FIXTURES: Fixture[] = [
  {
    note: "AT1 — originating incident: evidence-write to non-bound task, no discharge",
    full: [...bindingPrefix(), ...evidenceFinalTurn(TARGET_TASK)],
    finalMessage: R5_FINAL_MESSAGE,
    expect: "fire",
  },
  {
    note: "AT2 — same turn also files an ask",
    full: [
      ...bindingPrefix(),
      ...evidenceFinalTurn(TARGET_TASK, [toolUse("t_ask", "mcp__minsky__asks_create", {})]),
    ],
    finalMessage: R5_FINAL_MESSAGE,
    expect: "silent",
  },
  {
    note: "AT3 — spec-patch targets the conversation's own bound task",
    full: [...bindingPrefix(), ...evidenceFinalTurn(BOUND_TASK)],
    finalMessage: R5_FINAL_MESSAGE,
    expect: "silent",
  },
  {
    note: "working turn — session mutation beside the spec-patch",
    full: [
      ...bindingPrefix(),
      ...evidenceFinalTurn(TARGET_TASK, [
        toolUse("t_work", "mcp__minsky__session_write_file", { path: "src/x.ts" }),
      ]),
    ],
    finalMessage: R5_FINAL_MESSAGE,
    expect: "silent",
  },
  {
    note: "recommendation marker in the closing message",
    full: [...bindingPrefix(), ...evidenceFinalTurn(TARGET_TASK)],
    finalMessage: "Evidence recorded. My recommendation: escalate to Rung 3.",
    expect: "silent",
  },
  {
    // PR #2611 R1: session_start is a discharge (walk-forward) — for the
    // TARGET it additionally suppresses via the bound-task derivation.
    note: "session_start for the target in the same turn",
    full: [
      ...bindingPrefix(),
      ...evidenceFinalTurn(TARGET_TASK, [
        toolUse("t_start", "mcp__minsky__session_start", { task: TARGET_TASK }),
      ]),
    ],
    finalMessage: R5_FINAL_MESSAGE,
    expect: "silent",
  },
];

// NOTE (PR #2611 R1): the status-open filter is deliberately NOT probed here —
// it lives in run()'s IO shell (an injectable CLI read), not in the pure
// detection core this parity check compares across source/generated copies.
// Its coverage is the unit tests' "closed target suppresses / unknown fails
// open" cases plus the live dispatcher probe in the PR body.

/** The final turn is everything after the last real (string-content) user prompt. */
function finalTurnOf(lines: TranscriptLine[]): TranscriptLine[] {
  let lastPrompt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as TranscriptLine;
    if (line.type === "user" && typeof line.message?.content === "string") lastPrompt = i;
  }
  return lines.slice(lastPrompt + 1);
}

function verdictOf(
  detect: typeof detectFromSource,
  fixture: Fixture
): { verdict: "fire" | "silent"; reasons: string[] } {
  const detection = detect(finalTurnOf(fixture.full), fixture.full, fixture.finalMessage);
  if (detection === null) return { verdict: "silent", reasons: ["no-evidence-write"] };
  const fires = detection.suppressionReasons.length === 0 && detection.candidateTaskIds.length > 0;
  return { verdict: fires ? "fire" : "silent", reasons: detection.suppressionReasons };
}

function main(): number {
  let failures = 0;
  for (const fixture of FIXTURES) {
    const source = verdictOf(detectFromSource, fixture);
    const generated = verdictOf(detectFromGenerated, fixture);
    const parityOk = source.verdict === generated.verdict;
    const expectOk = source.verdict === fixture.expect;
    const status = parityOk && expectOk ? "PASS" : "FAIL";
    if (status === "FAIL") failures += 1;
    console.log(
      `[${status}] ${fixture.note}: source=${source.verdict} generated=${generated.verdict} ` +
        `expected=${fixture.expect}${source.reasons.length > 0 ? ` (${source.reasons.join("; ")})` : ""}`
    );
  }
  if (failures > 0) {
    console.error(`${failures} fixture(s) failed — recompile .claude/hooks or fix the detector.`);
    return 1;
  }
  console.log(`All ${FIXTURES.length} fixtures agree across source and generated copies.`);
  return 0;
}

process.exit(main());
