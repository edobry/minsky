/**
 * mt#4531 — the measured window is the whole turn's prose, not only its last
 * block.
 *
 * Lives in its own file rather than appending to
 * `wall-of-text-detector.test.ts`, which is already ~1900 lines.
 */

import { describe, expect, test } from "bun:test";
import {
  collectTurnProse,
  measureWallOfText,
  run,
  WORD_COUNT_THRESHOLD,
  type RunDeps,
} from "./wall-of-text-detector";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

const FAKE_TRANSCRIPT_PATH = "/tmp/mt4531-fake-transcript.jsonl";

function ts(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 7, 25, 0, 0, offsetSeconds)).toISOString();
}

function userLine(offsetSeconds: number, text: string): TranscriptLine {
  return {
    type: "user",
    message: { role: "user", content: text },
    timestamp: ts(offsetSeconds),
  } as TranscriptLine;
}

function assistantTextLine(offsetSeconds: number, text: string): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts(offsetSeconds),
  } as TranscriptLine;
}

function assistantToolUseLine(offsetSeconds: number, toolName = "Read"): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: toolName, input: {} }] },
    timestamp: ts(offsetSeconds),
  } as TranscriptLine;
}

/** n filler words. */
function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
}

function makeInput(): ClaudeHookInput {
  return {
    session_id: "mt4531-session",
    transcript_path: FAKE_TRANSCRIPT_PATH,
    cwd: "/tmp",
    hook_event_name: "UserPromptSubmit",
  } as ClaudeHookInput;
}

function makeCtx(transcriptLines: TranscriptLine[]): DispatchContext {
  return { transcriptLines } as DispatchContext;
}

/** No filesystem, and never reports a prior record, so dedupe never suppresses. */
const DETERMINISTIC_DEPS: RunDeps = { readCalibrationLogTextFn: () => undefined };

/**
 * The R7 shape, to scale: a wall in the FIRST block and a short closing one.
 *
 * The originating turn (session 6388062c, 2026-08-25T01:11:36Z) ran 597 / 81 /
 * 66 / 110 words across four blocks and drew "This is way too much information.
 * I cannot process all of this." The spec's AT1 rounds that to 600 and 110.
 */
function r7ShapedTurn(
  opener = "Help me understand what we just did, what the situation is, and what we do next."
): TranscriptLine[] {
  return [
    userLine(0, opener),
    assistantTextLine(1, words(600)),
    assistantToolUseLine(2),
    assistantTextLine(3, words(81)),
    assistantTextLine(4, words(110)),
    userLine(5, "next prompt"),
  ];
}

/**
 * The same shape opened by a DIRECTIVE rather than a question.
 *
 * The real R7 opener is interrogative, which trips the mt#3718 question-answer
 * override — see the dedicated test below for what that means and why it is
 * recorded rather than changed here. Tests that need to read the INJECTED text
 * use this opener so they are measuring the reminder, not the override.
 */
function r7ShapedTurnUnsuppressed(): TranscriptLine[] {
  return r7ShapedTurn("proceed with the next step");
}

describe("mt#4531 — whole-turn measurement (AT1)", () => {
  test("a 600-word FIRST block with a 110-word closing block fires", () => {
    const outcome = run(makeInput(), makeCtx(r7ShapedTurn()), DETERMINISTIC_DEPS);

    expect(outcome).not.toBeNull();
    const record = outcome?.calibration as Record<string, unknown> | undefined;
    expect(record?.trigger).toBe("over-budget");
    expect(record?.largestBlockWords).toBe(600);
    // `wordCount` still means the FINAL block — record continuity.
    expect(record?.wordCount).toBe(110);
    expect(record?.totalWords).toBe(791);
    expect(record?.blockCount).toBe(3);
  });

  /**
   * NEGATIVE CONTROL, encoded rather than narrated.
   *
   * `measureWallOfText` accepts a bare string, and a bare string is exactly the
   * pre-mt#4531 measurement: the final block alone. Asserting that the SAME
   * turn does not fire that way pins the defect in the test itself, so it
   * cannot rot the way a one-off manual revert does. If someone reverts the
   * widening, the test above goes red; if someone widens the LABEL leg too,
   * this one does.
   */
  test("negative control — the same turn measured the old way (final block only) does NOT fire", () => {
    const finalBlockOnly = measureWallOfText(words(110));

    expect(finalBlockOnly.matched).toBe(false);
    expect(finalBlockOnly.wordCount).toBe(110);
    expect(finalBlockOnly.wordCount).toBeLessThan(WORD_COUNT_THRESHOLD);
  });

  test("the widening strictly subsumes the old behaviour — a long FINAL block still fires", () => {
    const lines: TranscriptLine[] = [
      userLine(0, "go"),
      assistantTextLine(1, words(20)),
      assistantTextLine(2, words(400)),
      userLine(3, "next"),
    ];

    const outcome = run(makeInput(), makeCtx(lines), DETERMINISTIC_DEPS);
    const record = outcome?.calibration as Record<string, unknown> | undefined;
    expect(record?.trigger).toBe("over-budget");
    expect(record?.wordCount).toBe(400);
    expect(record?.largestBlockWords).toBe(400);
  });
});

describe("mt#4531 — the reminder names what was measured (AT2)", () => {
  test("when the wall is NOT the final block, the payload names the largest block and the total", () => {
    const outcome = run(makeInput(), makeCtx(r7ShapedTurnUnsuppressed()), DETERMINISTIC_DEPS);
    const context = outcome?.additionalContext ?? "";

    expect(context).toContain("791 words across 3 messages");
    expect(context).toContain("largest 600");
    expect(context).toContain("closing 110");
    // The payload is bounded by this guard's declared attention cost — a
    // detector about output volume must not answer a breach by raising it.
    expect(context.length).toBeLessThanOrEqual(400);
    // The pre-mt#4531 wording is what let the fire be satisfied by trimming the
    // tail alone — it must not describe a whole-turn measurement.
    expect(context).not.toContain("final report ran");
  });

  test("when the final block IS the largest, the payload keeps the simple report wording", () => {
    const lines: TranscriptLine[] = [
      userLine(0, "go"),
      assistantTextLine(1, words(20)),
      assistantTextLine(2, words(400)),
      userLine(3, "next"),
    ];

    const context = run(makeInput(), makeCtx(lines), DETERMINISTIC_DEPS)?.additionalContext ?? "";
    expect(context).toContain("final report ran 400 words");
    expect(context).not.toContain("LARGEST single message");
  });
});

describe("mt#4531 — known limitation: the depth-request override still suppresses the R7 turn", () => {
  /**
   * **A limitation pinned deliberately, not a passing behaviour** — and the
   * sharpest single finding this task turned up.
   *
   * The real R7 turn opened on "**Help me understand** what we just did..."
   * That matches `DEPTH_REQUEST_PATTERNS`, so the mt#3112 depth-request
   * override withholds the reminder. Under the widened metric the R7 turn now
   * LOGS a fire where it previously produced nothing at all — but its reminder
   * is still suppressed.
   *
   * The override's premise is that a report which is long BECAUSE depth was
   * asked for is not a violation, so reminding the agent would train it to tune
   * the reminder out. **R7 falsifies that premise on this very turn**: the
   * principal asked to understand, got 854 words, and answered "This is way too
   * much information. I cannot process all of this." Asking for an explanation
   * is not asking for volume — which is precisely the distinction
   * `DEPTH_REQUEST_PATTERNS` cannot draw, since it keys on the request's
   * phrasing and never on what came back.
   *
   * Sizing it from the replay: of 156 turns newly firing under the
   * largest-block metric, 84 (54%) are suppressed by one of the two overrides.
   * So more than half of what the widening newly sees is still not delivered.
   *
   * Re-calibrating that gate is a different question from which unit is
   * measured, and this task is scoped to the unit (principal-scoped
   * 2026-08-25). Tracked at mt#4540. This test is the executable record, so the
   * limitation cannot be forgotten or silently "fixed" without reading why it
   * is here.
   */
  test("logs the fire but withholds the reminder — tracked at mt#4540", () => {
    const outcome = run(makeInput(), makeCtx(r7ShapedTurn()), DETERMINISTIC_DEPS);

    // It FIRES now — pre-mt#4531 there was no record at all for this turn.
    const record = outcome?.calibration as Record<string, unknown> | undefined;
    expect(record?.trigger).toBe("over-budget");
    expect(record?.largestBlockWords).toBe(600);
    expect(record?.suppressionReasons).toEqual(["depth-request-override"]);

    // ...and the reminder is still withheld.
    expect(outcome?.additionalContext).toBeUndefined();
  });
});

describe("mt#4531 — false-positive controls", () => {
  /**
   * The heartbeat shape, which `user-preferences.mdc §Progress heartbeats`
   * MANDATES: a long tool-heavy turn carrying many short status lines. Their
   * SUM clears the threshold; no single one does.
   *
   * This is the control that decided the metric. Replayed over 2574 real turns,
   * summing newly fired on 977 and **444 of those were this shape**; keying on
   * the largest single block newly fired on 156 and **0** were.
   */
  test("many short heartbeat lines summing over the threshold do NOT fire", () => {
    const lines: TranscriptLine[] = [userLine(0, "go")];
    for (let i = 0; i < 30; i++) {
      lines.push(assistantTextLine(1 + i * 2, words(40)));
      lines.push(assistantToolUseLine(2 + i * 2));
    }
    lines.push(userLine(100, "next"));

    const outcome = run(makeInput(), makeCtx(lines), DETERMINISTIC_DEPS);
    expect(outcome).toBeNull();

    // ...and the sum really would have cleared it, so the test is not passing
    // for the trivial reason that the fixture is small.
    const prose = collectTurnProse(lines.slice(1, -1), words(40));
    expect(prose.totalWords).toBeGreaterThanOrEqual(WORD_COUNT_THRESHOLD);
    expect(prose.largestBlockWords).toBeLessThan(WORD_COUNT_THRESHOLD);
  });
});

describe("mt#4531 — collectTurnProse", () => {
  test("a bare string measures identically to the pre-mt#4531 path", () => {
    const text = words(350);
    const asString = measureWallOfText(text);
    const asProse = measureWallOfText({
      finalText: text,
      largestBlockWords: 350,
      totalWords: 350,
      blockCount: 1,
    });

    expect(asString).toEqual(asProse);
    expect(asString.largestBlockWords).toBe(asString.wordCount);
  });

  /**
   * ADR-031's lag case: the recorded `last_assistant_message` can carry a final
   * block the transcript has not flushed. Folding it in is what keeps the
   * widening from SHRINKING a measurement relative to today.
   */
  test("a recorded final block absent from the transcript still counts", () => {
    const turnLines = [assistantTextLine(1, words(50)), assistantTextLine(2, words(60))];
    const prose = collectTurnProse(turnLines, words(500));

    expect(prose.largestBlockWords).toBe(500);
    expect(prose.totalWords).toBeGreaterThanOrEqual(500);
  });

  test("an empty turn falls back to the resolved final text rather than measuring nothing", () => {
    const prose = collectTurnProse([], words(320));

    expect(prose.blockCount).toBe(1);
    expect(prose.largestBlockWords).toBe(320);
    expect(prose.totalWords).toBe(320);
  });
});
