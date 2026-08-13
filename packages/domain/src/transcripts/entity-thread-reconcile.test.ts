/**
 * Tests for the entity-thread reconcile core (mt#4073).
 *
 * These cover the two hazards the module is balanced between — duplicating a
 * reply that already landed, and back-filling turns that were never thread
 * replies — plus the normalization difference between the two write paths that
 * makes string equality unsound.
 */

import { describe, test, expect } from "bun:test";
import {
  normalizeForMatch,
  isTranscriptTurnStored,
  selectRecoverableTurns,
  RECONCILE_SKEW_TOLERANCE_MS,
  type StoredThreadTurn,
  type TranscriptAssistantTurn,
} from "./entity-thread-reconcile";

const T0 = Date.parse("2026-08-12T21:00:00.000Z");
const minutes = (n: number): number => n * 60_000;

function transcriptTurn(
  overrides: Partial<TranscriptAssistantTurn> & Pick<TranscriptAssistantTurn, "text" | "endedAtMs">
): TranscriptAssistantTurn {
  return {
    conversationId: "conv-a",
    turnIndex: 1,
    ...overrides,
  };
}

describe("normalizeForMatch", () => {
  test("collapses the whitespace difference between the two join conventions", () => {
    // The recorder joins an event's text blocks with "", the transcript
    // extractor with "\n" — the same model output, two renderings.
    const recorderSide = "first block" + "second block";
    const transcriptSide = "first block" + "\n" + "second block";

    expect(normalizeForMatch(recorderSide)).toBe("first blocksecond block");
    expect(normalizeForMatch(transcriptSide)).toBe("first block second block");
    // Not equal as strings, which is exactly why matching is containment-based
    // rather than equality-based; see isTranscriptTurnStored below.
    expect(normalizeForMatch(recorderSide)).not.toBe(normalizeForMatch(transcriptSide));
  });

  test("trims ends and collapses runs, leaving case and punctuation alone", () => {
    expect(normalizeForMatch("  a\n\n  b\t c  ")).toBe("a b c");
    expect(normalizeForMatch("Yes. No!")).toBe("Yes. No!");
  });
});

describe("isTranscriptTurnStored", () => {
  test("recognizes an exact match", () => {
    const stored: StoredThreadTurn[] = [{ content: "the answer", createdAtMs: T0 }];
    expect(isTranscriptTurnStored("the answer", stored)).toBe(true);
  });

  test("recognizes a match across the \\n-vs-empty join difference", () => {
    const stored: StoredThreadTurn[] = [{ content: "one\n\ntwo", createdAtMs: T0 }];
    expect(isTranscriptTurnStored("one two", stored)).toBe(true);
  });

  test("does not match an unrelated reply", () => {
    const stored: StoredThreadTurn[] = [{ content: "the answer", createdAtMs: T0 }];
    expect(isTranscriptTurnStored("a completely different reply", stored)).toBe(false);
  });

  test("an empty stored turn suppresses nothing", () => {
    // "".includes() is true of every string; a single blank row must not make
    // every transcript turn look already-recovered.
    const stored: StoredThreadTurn[] = [{ content: "   ", createdAtMs: T0 }];
    expect(isTranscriptTurnStored("a real reply", stored)).toBe(false);
  });
});

describe("selectRecoverableTurns", () => {
  test("returns the turn the thread is missing", () => {
    const result = selectRecoverableTurns({
      storedAgentTurns: [{ content: "earlier reply", createdAtMs: T0 }],
      transcriptTurns: [
        transcriptTurn({ text: "earlier reply", endedAtMs: T0, turnIndex: 1 }),
        transcriptTurn({ text: "the lost reply", endedAtMs: T0 + minutes(5), turnIndex: 2 }),
      ],
    });

    expect(result.map((t) => t.text)).toEqual(["the lost reply"]);
  });

  /**
   * Acceptance test 3 — the normalization case, asserted directly.
   *
   * The recorder wrote TWO turns for one model message (one per event); the
   * transcript merged them into one row (same message.id, mt#3883). Both
   * landed, so nothing is missing — and a naive equality check would see the
   * merged row matching neither stored turn and re-append it, putting the reply
   * on screen twice.
   */
  test("does not re-append a merged transcript row whose parts both landed", () => {
    const result = selectRecoverableTurns({
      storedAgentTurns: [
        { content: "Here is the first half.", createdAtMs: T0 },
        { content: "And the second half.", createdAtMs: T0 + 1_000 },
      ],
      transcriptTurns: [
        transcriptTurn({
          text: "Here is the first half.\nAnd the second half.",
          endedAtMs: T0 + 2_000,
        }),
      ],
    });

    expect(result).toEqual([]);
  });

  /**
   * Acceptance test 4 — the window bound.
   *
   * A conversation's assistant history can predate the thread entirely (the
   * recorder is registered when the thread's route first runs). Those turns
   * were never thread replies and must not be backfilled.
   */
  test("ignores transcript turns at or before the newest stored agent turn", () => {
    const result = selectRecoverableTurns({
      storedAgentTurns: [{ content: "most recent stored", createdAtMs: T0 }],
      transcriptTurns: [
        transcriptTurn({ text: "from long before this thread", endedAtMs: T0 - minutes(60) }),
        transcriptTurn({ text: "also before", endedAtMs: T0 - minutes(30) }),
      ],
    });

    expect(result).toEqual([]);
  });

  test("falls back to the thread's start when no agent turn has landed yet", () => {
    const threadStartedAtMs = T0;
    const result = selectRecoverableTurns({
      storedAgentTurns: [],
      threadStartedAtMs,
      transcriptTurns: [
        transcriptTurn({ text: "predates the thread", endedAtMs: T0 - minutes(60) }),
        transcriptTurn({ text: "the only reply, never stored", endedAtMs: T0 + minutes(1) }),
      ],
    });

    expect(result.map((t) => t.text)).toEqual(["the only reply, never stored"]);
  });

  test("recovers nothing when neither anchor is available", () => {
    // No stored agent turn and no thread start means nothing bounds the
    // conversation's history against this thread's — refusing is the safe
    // direction, since the alternative is an unbounded backfill.
    const result = selectRecoverableTurns({
      storedAgentTurns: [],
      transcriptTurns: [transcriptTurn({ text: "unbounded", endedAtMs: T0 })],
    });

    expect(result).toEqual([]);
  });

  test("tolerates clock skew between the daemon and Postgres", () => {
    // A turn stamped slightly BEFORE the newest stored turn is still eligible:
    // the two instants come from different clocks, and the alternative it must
    // exclude (a turn from earlier in the thread) is minutes away, not seconds.
    const result = selectRecoverableTurns({
      storedAgentTurns: [{ content: "stored", createdAtMs: T0 }],
      transcriptTurns: [
        transcriptTurn({
          text: "arrived within the skew window",
          endedAtMs: T0 - (RECONCILE_SKEW_TOLERANCE_MS - 5_000),
        }),
      ],
    });

    expect(result.map((t) => t.text)).toEqual(["arrived within the skew window"]);
  });

  /**
   * Acceptance test 5's ordering half — replies land in the order produced.
   *
   * Regression for PR #2971 R1: the first cut sorted by `(conversationId,
   * turnIndex)`, which across a swap orders by an arbitrary UUID comparison.
   * The ids here are chosen so lexicographic order CONTRADICTS time order — the
   * replaced conversation (`f...`) holds the EARLIER replies but sorts last as a
   * string. The original test used `conv-a`/`conv-b`, where the two orderings
   * agreed, so it passed against the broken sort.
   */
  test("orders recovered turns by time, across a conversation swap", () => {
    const replacedConversation = "ffffffff-0000-4000-8000-000000000000";
    const currentConversation = "00000000-0000-4000-8000-000000000000";

    const result = selectRecoverableTurns({
      storedAgentTurns: [{ content: "anchor", createdAtMs: T0 }],
      transcriptTurns: [
        transcriptTurn({
          conversationId: currentConversation,
          turnIndex: 2,
          text: "said after the swap, second",
          endedAtMs: T0 + minutes(4),
        }),
        transcriptTurn({
          conversationId: replacedConversation,
          turnIndex: 9,
          text: "said BEFORE the swap",
          endedAtMs: T0 + minutes(1),
        }),
        transcriptTurn({
          conversationId: currentConversation,
          turnIndex: 1,
          text: "said after the swap, first",
          endedAtMs: T0 + minutes(3),
        }),
      ],
    });

    expect(result.map((t) => t.text)).toEqual([
      "said BEFORE the swap",
      "said after the swap, first",
      "said after the swap, second",
    ]);
  });
});
