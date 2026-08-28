import { describe, expect, test } from "bun:test";
import {
  INJECTION_ENABLED,
  WINDOW_TURNS,
  buildInjectionReminder,
  evaluateWindow,
  renderWorstCase,
  segmentTurns,
  toolSubjectsInTurn,
} from "./cross-turn-hedge-detector";
import type { TranscriptLine } from "./transcript";

// Local builders typed as TranscriptLine — the canary-transcript helpers return
// Record<string, unknown> and would need a cast at every call site.
const prompt = (text: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: text },
});

const assistant = (text: string): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const toolUse = (id: string, name: string, input: Record<string, unknown>): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});

const toolResult = (id: string, content: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
});

/** The originating incident, reduced to its load-bearing turns (`c2027e82`). */
const HEDGE_PROSE =
  '**Where I overreached:** I said "the session that wrote mem#1323." ' +
  "That memory records no author (`sourceAgentId` is null). I inferred it from " +
  "`977e064c` holding the dogfood claims. That inference may be wrong.";

/** The prompt that opens the hedge turn in every incident fixture below. */
const OPENING_PROMPT = "what is the collision?";

const ASSERTION_PROSE =
  "Tab #7 is a separate process launched at 16:27, which was never cleared and " +
  "never paused; it wrote mem#1323 at 20:55 UTC, updated it at 23:14, and kept " +
  "right on working.";

describe("segmentTurns", () => {
  test("splits on real user prompts, oldest first", () => {
    const segments = segmentTurns([
      prompt("one"),
      assistant("a1"),
      prompt("two"),
      assistant("a2"),
      assistant("a2b"),
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveLength(2);
    expect(segments[1]).toHaveLength(3);
  });

  test("a tool_result does not open a new segment", () => {
    const segments = segmentTurns([
      prompt("one"),
      toolUse("t1", "Bash", { command: "ls" }),
      toolResult("t1", "file.ts"),
      assistant("done"),
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(4);
  });

  test("drops leading lines that precede the first prompt", () => {
    // A transcript opening mid-conversation, or one whose head was compacted away.
    // Such lines have no bounding prompt, so their window position is unknowable.
    const segments = segmentTurns([assistant("orphan"), prompt("one"), assistant("a1")]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.[0]?.message?.content).toBe("one");
  });

  test("an empty transcript yields no segments", () => {
    expect(segmentTurns([])).toEqual([]);
  });
});

describe("toolSubjectsInTurn", () => {
  test("collects subjects from tool_use inputs", () => {
    const subjects = toolSubjectsInTurn([toolUse("t1", "memory_get", { id: "mem#1323" })]);
    expect([...subjects]).toEqual(["mem#1323"]);
  });

  test("collects subjects from tool_result content", () => {
    const subjects = toolSubjectsInTurn([toolResult("t1", "matched mt#4701 in the ledger")]);
    expect([...subjects]).toEqual(["mt#4701"]);
  });

  test("does NOT collect subjects from assistant prose", () => {
    // The question this set answers is "did anything LOOK at the subject". The agent
    // talking about it again is the behaviour under investigation, not evidence
    // against it — counting prose would let a claim back itself.
    expect(toolSubjectsInTurn([assistant("mem#1323 was written by dec670d8")]).size).toBe(0);
  });

  test("handles a top-level tool_use line shape", () => {
    const subjects = toolSubjectsInTurn([
      { type: "tool_use", name: "memory_get", input: { id: "mem#1323" } },
    ]);
    expect([...subjects]).toEqual(["mem#1323"]);
  });
});

describe("evaluateWindow — the originating incident", () => {
  test("fires on the hedge/restatement pair with no intervening lookup", () => {
    const evaluated = evaluateWindow([
      prompt(OPENING_PROMPT),
      toolUse("t1", "mcp__minsky__memory_get", { id: "mem#1323" }),
      toolResult("t1", '{"sourceAgentId": null}'),
      assistant(HEDGE_PROSE),
      prompt("keep going"),
      toolUse("t2", "Bash", { command: "ps -eo pid,comm" }),
      assistant("Identifying which stream it is on."),
      prompt("and now?"),
      assistant(ASSERTION_PROSE),
    ]);

    expect(evaluated).not.toBeNull();
    expect(evaluated?.result.matched).toBe(true);
    expect(evaluated?.result.findings[0]?.subject).toBe("mem#1323");
    // The hedge sits two turns back, which is why an adjacent-turn comparison
    // would have missed the real incident.
    expect(evaluated?.evaluation["hedgeGapTurns"]).toEqual([2]);
  });

  test("the hedge turn's own memory_get does not count as resolving it", () => {
    // Turn 3's `memory_get` returned `sourceAgentId: null` — the call that CREATED
    // the uncertainty. Counting it would make the detector inert on its own
    // originating case (mem#704: a probe that cannot discriminate is not evidence).
    const evaluated = evaluateWindow([
      prompt(OPENING_PROMPT),
      toolUse("t1", "mcp__minsky__memory_get", { id: "mem#1323" }),
      toolResult("t1", '{"sourceAgentId": null}'),
      assistant(HEDGE_PROSE),
      prompt("and now?"),
      assistant(ASSERTION_PROSE),
    ]);

    expect(evaluated?.result.matched).toBe(true);
    expect(evaluated?.result.resolvedSubjects).toEqual([]);
  });

  test("a post-hedge lookup suppresses — the correction turn", () => {
    const evaluated = evaluateWindow([
      prompt(OPENING_PROMPT),
      assistant(HEDGE_PROSE),
      prompt("dig further"),
      toolUse("t9", "Bash", { command: "grep -l mem#1323 *.jsonl" }),
      toolResult("t9", "dec670d8.jsonl"),
      assistant("mem#1323 was written by `dec670d8`, the pre-clear conversation."),
    ]);

    expect(evaluated?.result.matched).toBe(false);
    expect(evaluated?.result.resolvedSubjects).toEqual(["mem#1323"]);
  });
});

describe("evaluateWindow — declines to score", () => {
  test("returns null on a single-turn window", () => {
    expect(evaluateWindow([prompt("one"), assistant(HEDGE_PROSE)])).toBeNull();
  });

  test("returns null when the current turn has no assistant prose", () => {
    expect(
      evaluateWindow([
        prompt("one"),
        assistant(HEDGE_PROSE),
        prompt("two"),
        toolUse("t1", "Bash", { command: "ls" }),
      ])
    ).toBeNull();
  });

  test("returns null when every prior turn is prose-free", () => {
    expect(
      evaluateWindow([
        prompt("one"),
        toolUse("t1", "Bash", { command: "ls" }),
        prompt("two"),
        assistant(ASSERTION_PROSE),
      ])
    ).toBeNull();
  });
});

describe("evaluateWindow — the evaluation stream", () => {
  test("records a non-firing window too, so the fire rate is measurable", () => {
    const evaluated = evaluateWindow([
      prompt("one"),
      assistant("Nothing uncertain here."),
      prompt("two"),
      assistant("Still nothing."),
    ]);

    expect(evaluated).not.toBeNull();
    expect(evaluated?.evaluation["fired"]).toBe(false);
    expect(evaluated?.evaluation["turnsScanned"]).toBe(2);
    expect(evaluated?.evaluation["windowTurns"]).toBe(WINDOW_TURNS);
  });

  test("splits the two marker legs so they tune independently", () => {
    const evaluated = evaluateWindow([
      prompt("one"),
      assistant("Status on mt#4701: inferred, not measured."),
      prompt("two"),
      assistant("mt#4701 ships the falsifier."),
    ]);

    expect(evaluated?.evaluation["legCounts"]).toEqual({
      warrantVocabulary: 1,
      naturalLanguage: 0,
    });
    expect(evaluated?.evaluation["subjectKinds"]).toEqual(["task"]);
  });
});

describe("injection posture", () => {
  test("ships calibration-first", () => {
    expect(INJECTION_ENABLED).toBe(false);
  });

  test("the reminder names both sides of the pair and points at the rule", () => {
    const text = buildInjectionReminder({
      matched: true,
      findings: [
        {
          subject: "mem#1323",
          subjectKind: "memory",
          hedgeTurnIndex: 0,
          hedgeLeg: "natural-language",
          hedgeMarker: "may be wrong",
          hedgeExcerpt: "I inferred mem#1323's author.",
          assertionExcerpt: "it wrote mem#1323 at 20:55 UTC",
        },
      ],
      hedgedSubjects: ["mem#1323"],
      resolvedSubjects: [],
    });

    expect(text).toContain("mem#1323");
    expect(text).toContain("may be wrong");
    expect(text).toContain("it wrote mem#1323 at 20:55 UTC");
    expect(text).toContain("claim-confidence.mdc");
  });

  test("the worst-case render stays inside its declared attention budget", () => {
    // Pins the registry's `attentionCost` against drift — the mt#3479 ceiling test
    // is what catches a render that grew past its declaration.
    expect(renderWorstCase().length).toBeLessThanOrEqual(900);
  });
});
