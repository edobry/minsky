/**
 * mt#4540 — the population split a suppression-accuracy rate is computed over.
 *
 * Every case here pins a defect PR #3317 R1 found in the first cut. Both were
 * set-membership arithmetic, both were invisible in a report that prints only
 * totals, and one moved the headline rate from 3.2% to 4.9% while REDUCING the
 * observations behind it from 3 to 2 — the shape that makes a correction read
 * as strengthening evidence while thinning it.
 */

import { describe, expect, test } from "bun:test";
import { partitionBySuppression } from "./replay-wall-of-text-window";
import {
  SUPPRESSION_DEPTH_REQUEST,
  SUPPRESSION_QUESTION_ANSWER,
} from "../.minsky/hooks/wall-of-text-detector";

type Turn = Parameters<typeof partitionBySuppression>[0][number];

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    sessionId: "s",
    turnIndex: 1,
    currentWords: 10,
    sumWords: 400,
    maxWords: 400,
    blockCount: 2,
    toolCalls: 0,
    firesCurrent: false,
    firesSum: true,
    firesMax: true,
    suppressed: false,
    suppressionReasons: [],
    largestBlockLead: "lead",
    reactionText: "ok thanks",
    reactionAt: "2026-08-20T00:00:00Z",
    ...overrides,
  } as Turn;
}

const ALL = () => true;
const labelOf = (p: ReturnType<typeof partitionBySuppression>, i: number) => p.populations[i]?.[0];
const setOf = (p: ReturnType<typeof partitionBySuppression>, i: number) =>
  p.populations[i]?.[1] ?? [];

describe("partitionBySuppression — the populations are disjoint (PR #3317 R1)", () => {
  test("a turn BOTH gates suppressed lands in its own row, not in either single-gate row", () => {
    const both = turn({
      suppressed: true,
      suppressionReasons: [SUPPRESSION_DEPTH_REQUEST, SUPPRESSION_QUESTION_ANSWER],
    });
    const p = partitionBySuppression([both], ALL);

    expect(labelOf(p, 0)).toBe("suppressed: depth-request only");
    expect(setOf(p, 0)).toHaveLength(0);
    expect(labelOf(p, 1)).toBe("suppressed: question-answer only");
    expect(setOf(p, 1)).toHaveLength(0);
    expect(labelOf(p, 2)).toBe("suppressed: BOTH gates");
    expect(setOf(p, 2)).toHaveLength(1);
  });

  /**
   * The defect exactly: the first cut counted a both-gates turn in depth and
   * excluded it from question-answer, so depth's denominator was inflated by
   * every both-gates turn while question-answer's was not.
   */
  test("no turn appears in more than one population", () => {
    const turns = [
      turn({ suppressed: true, suppressionReasons: [SUPPRESSION_DEPTH_REQUEST] }),
      turn({ suppressed: true, suppressionReasons: [SUPPRESSION_QUESTION_ANSWER] }),
      turn({
        suppressed: true,
        suppressionReasons: [SUPPRESSION_DEPTH_REQUEST, SUPPRESSION_QUESTION_ANSWER],
      }),
      turn(),
    ];
    const p = partitionBySuppression(turns, ALL);

    const total = p.populations.reduce((n, [, set]) => n + set.length, 0);
    expect(total).toBe(turns.length);
    for (const t of turns) {
      const appearances = p.populations.filter(([, set]) => set.includes(t)).length;
      expect(appearances).toBe(1);
    }
  });

  test("an unsuppressed firing turn is DELIVERED", () => {
    const p = partitionBySuppression([turn()], ALL);
    expect(labelOf(p, 3)).toBe("DELIVERED (reminder injected)");
    expect(setOf(p, 3)).toHaveLength(1);
  });

  test("a turn that does not fire is the control, not a population member", () => {
    const p = partitionBySuppression([turn({ firesMax: false })], ALL);
    expect(p.populations.every(([, set]) => set.length === 0)).toBe(true);
    expect(p.control).toHaveLength(1);
  });
});

describe("partitionBySuppression — an unreadable reaction is excluded, not scored (PR #3317 R1)", () => {
  test("a turn with no reacting prompt is dropped from every denominator and counted", () => {
    const p = partitionBySuppression([turn({ reactionText: "" }), turn()], ALL);

    expect(p.droppedNoReaction).toBe(1);
    expect(setOf(p, 3)).toHaveLength(1); // only the readable one is scored
  });

  test("whitespace-only counts as unreadable", () => {
    const p = partitionBySuppression([turn({ reactionText: "   \n\t " })], ALL);
    expect(p.droppedNoReaction).toBe(1);
    expect(p.populations.every(([, set]) => set.length === 0)).toBe(true);
  });

  test("a dropped turn is NOT silently counted as 'no complaint'", () => {
    // The bias this guards: an unreadable reaction can never be a candidate, so
    // leaving it in the denominator only ever pushes a rate DOWN.
    const p = partitionBySuppression(
      [turn({ reactionText: "" }), turn({ reactionText: "" }), turn()],
      ALL
    );
    expect(p.droppedNoReaction).toBe(2);
    expect(setOf(p, 3)).toHaveLength(1);
  });

  test("the count is zero when every reaction is readable", () => {
    expect(partitionBySuppression([turn(), turn()], ALL).droppedNoReaction).toBe(0);
  });
});

describe("partitionBySuppression — the window predicate is applied first", () => {
  test("out-of-window turns are excluded from populations, control and the dropped count alike", () => {
    const inWindow = (t: Turn) => t.sessionId === "keep";
    const p = partitionBySuppression(
      [
        turn({ sessionId: "keep" }),
        turn({ sessionId: "drop" }),
        turn({ sessionId: "drop", reactionText: "" }),
      ],
      inWindow
    );

    expect(setOf(p, 3)).toHaveLength(1);
    expect(p.control).toHaveLength(0);
    // The out-of-window unreadable turn must not inflate the dropped count —
    // it was never in the measured corpus to begin with.
    expect(p.droppedNoReaction).toBe(0);
  });
});
