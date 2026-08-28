import { describe, expect, test } from "bun:test";
import {
  WARRANT_VOCABULARY,
  detectCrossTurnHedgeDecay,
  extractSubjects,
  findHedgeMarker,
  normalizeSubject,
  splitClaimUnits,
  type HedgeLeg,
  type ScannedTurn,
} from "./cross-turn-hedge";

/** The two marker legs, named once so a rename cannot leave a stale literal behind. */
const WARRANT_LEG: HedgeLeg = "warrant-vocabulary";
const NATURAL_LEG: HedgeLeg = "natural-language";

/**
 * Identity elider. Most cases are about the matcher, not about elision; the two
 * elision cases below pass a real stripping function so the contract — "elide runs
 * BEFORE matching" — is exercised rather than assumed.
 */
const noElide = (t: string): string => t;

/** Strips ```-fenced regions, the shape the adapter's `elideMarkdownNonProse` covers. */
const fenceElider = (t: string): string => t.replace(/```[\s\S]*?```/g, " ");

function turn(index: number, prose: string): ScannedTurn {
  return { index, prose };
}

/**
 * The originating incident, verbatim from conversation `c2027e82` (2026-08-27).
 * Hedge in turn 3; the unhedged restatement lands in turn 5, NOT the adjacent turn —
 * which is why this detector needs a window rather than an N/N+1 comparison.
 */
const INCIDENT_HEDGE =
  '**Where I overreached:** I said "the session that wrote mem#1323." ' +
  "That memory records no author (`sourceAgentId` is null). I inferred it from " +
  "`977e064c` holding the dogfood claims. That inference may be wrong.";

const INCIDENT_ASSERTION =
  "Tab #7 is a separate process launched at 16:27, which was never cleared and " +
  "never paused; it wrote mem#1323 at 20:55 UTC, updated it at 23:14, and kept " +
  "right on working.";

describe("detectCrossTurnHedgeDecay — the originating incident", () => {
  test("fires on a subject hedged in turn 3 and asserted in turn 5", () => {
    const result = detectCrossTurnHedgeDecay({
      priorTurns: [turn(3, INCIDENT_HEDGE), turn(4, "Only two transcripts have distinct mtimes.")],
      currentTurn: turn(5, INCIDENT_ASSERTION),
      toolSubjectsByTurn: new Map(),
      elide: noElide,
    });

    expect(result.matched).toBe(true);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding).toBeDefined();
    expect(finding?.subject).toBe("mem#1323");
    expect(finding?.subjectKind).toBe("memory");
    expect(finding?.hedgeTurnIndex).toBe(3);
    expect(finding?.assertionExcerpt).toContain("it wrote mem#1323");
    // The reported hedge is the FIRST claim unit carrying both a marker and the
    // subject. In the real turn that is the "overreached" sentence, which precedes
    // the "I inferred" one — so this pins the earliest-hedge rule against the actual
    // transcript rather than against whichever marker reads as most salient.
    expect(finding?.hedgeMarker).toBe("I overreached");
    expect(finding?.hedgeExcerpt).toContain("mem#1323");
  });

  test("the hedge turn's OWN tool call does not suppress — it is what produced the hedge", () => {
    // Turn 3 ran `memory_get {id: "mem#1323"}`; the result's `sourceAgentId: null`
    // is precisely why the claim was hedged. Counting it as verification would make
    // the detector inert on the incident that produced it (mem#704).
    const result = detectCrossTurnHedgeDecay({
      priorTurns: [turn(3, INCIDENT_HEDGE)],
      currentTurn: turn(5, INCIDENT_ASSERTION),
      toolSubjectsByTurn: new Map([[3, new Set(["mem#1323"])]]),
      elide: noElide,
    });

    expect(result.matched).toBe(true);
    expect(result.resolvedSubjects).toEqual([]);
  });

  test("a post-hedge tool call naming the subject suppresses (the correction turn)", () => {
    // Turn 6 ran the discriminating grep in its own turn, then asserted authorship
    // correctly. That is the behaviour the detector must NOT flag.
    const result = detectCrossTurnHedgeDecay({
      priorTurns: [turn(3, INCIDENT_HEDGE), turn(4, "Identifying which stream it is on.")],
      currentTurn: turn(6, "mem#1323 was written by `dec670d8`, the pre-clear conversation."),
      toolSubjectsByTurn: new Map([[6, new Set(["mem#1323"])]]),
      elide: noElide,
    });

    expect(result.matched).toBe(false);
    expect(result.resolvedSubjects).toEqual(["mem#1323"]);
  });

  test("a self-report that re-hedges while naming the subject is not an assertion", () => {
    // The exemplary behaviour: turn 6 also said "I inferred mem#1323's authorship
    // from tab #7 holding claims". It carries a hedge marker, so it is a hedge.
    const result = detectCrossTurnHedgeDecay({
      priorTurns: [turn(3, INCIDENT_HEDGE)],
      currentTurn: turn(
        6,
        "**My error:** I inferred mem#1323's authorship from tab #7 holding claims on mt#4693."
      ),
      toolSubjectsByTurn: new Map(),
      elide: noElide,
    });

    expect(result.matched).toBe(false);
  });
});

describe("detectCrossTurnHedgeDecay — negative controls", () => {
  test("a subject hedged and never restated does not fire", () => {
    const result = detectCrossTurnHedgeDecay({
      priorTurns: [turn(1, INCIDENT_HEDGE)],
      currentTurn: turn(2, "Moving on to the deploy check; nothing else outstanding."),
      toolSubjectsByTurn: new Map(),
      elide: noElide,
    });

    expect(result.matched).toBe(false);
    expect(result.hedgedSubjects).toEqual(["mem#1323"]);
  });

  test("a hedge and an assertion about DIFFERENT subjects do not fire", () => {
    const result = detectCrossTurnHedgeDecay({
      priorTurns: [turn(1, "I inferred that mem#1323 was written by that tab.")],
      currentTurn: turn(2, "mem#1324 was written at 23:14 and covers the untaken-action stream."),
      toolSubjectsByTurn: new Map(),
      elide: noElide,
    });

    expect(result.matched).toBe(false);
  });

  test("a question restates nothing", () => {
    const result = detectCrossTurnHedgeDecay({
      priorTurns: [turn(1, INCIDENT_HEDGE)],
      currentTurn: turn(2, "Is mem#1323 still the handoff you want me working from?"),
      toolSubjectsByTurn: new Map(),
      elide: noElide,
    });

    expect(result.matched).toBe(false);
  });

  test("a hedge inside a fenced block is elided before matching", () => {
    const result = detectCrossTurnHedgeDecay({
      priorTurns: [turn(1, "Quoting the earlier note:\n```\nI inferred mem#1323's author.\n```")],
      currentTurn: turn(2, "mem#1323 was written at 20:55 UTC."),
      toolSubjectsByTurn: new Map(),
      elide: fenceElider,
    });

    expect(result.matched).toBe(false);
    expect(result.hedgedSubjects).toEqual([]);
  });

  test("an assertion inside a fenced block is elided before matching", () => {
    const result = detectCrossTurnHedgeDecay({
      priorTurns: [turn(1, INCIDENT_HEDGE)],
      currentTurn: turn(2, "The reviewer pasted:\n```\nit wrote mem#1323 at 20:55 UTC\n```"),
      toolSubjectsByTurn: new Map(),
      elide: fenceElider,
    });

    expect(result.matched).toBe(false);
  });

  test("prose with no subject key never fires, however hedged", () => {
    const result = detectCrossTurnHedgeDecay({
      priorTurns: [turn(1, "I inferred the handoff came from the pre-clear tab; may be wrong.")],
      currentTurn: turn(2, "The handoff came from the pre-clear tab."),
      toolSubjectsByTurn: new Map(),
      elide: noElide,
    });

    expect(result.matched).toBe(false);
  });
});

describe("detectCrossTurnHedgeDecay — reporting", () => {
  test("records which marker leg fired so the two tune independently", () => {
    const warrant = detectCrossTurnHedgeDecay({
      priorTurns: [turn(1, "Status on mt#4701: inferred, not measured.")],
      currentTurn: turn(2, "mt#4701 ships the falsifier for the warrant vocabulary."),
      toolSubjectsByTurn: new Map(),
      elide: noElide,
    });
    expect(warrant.findings[0]?.hedgeLeg).toBe(WARRANT_LEG);

    const natural = detectCrossTurnHedgeDecay({
      priorTurns: [turn(1, "PR #3412 conflicts with our scope, though that may be wrong.")],
      currentTurn: turn(2, "PR #3412 conflicts with our scope, so we reframed."),
      toolSubjectsByTurn: new Map(),
      elide: noElide,
    });
    expect(natural.findings[0]?.hedgeLeg).toBe(NATURAL_LEG);
    expect(natural.findings[0]?.subjectKind).toBe("changeset");
  });

  test("reports the EARLIEST hedge when a subject is hedged repeatedly", () => {
    const result = detectCrossTurnHedgeDecay({
      priorTurns: [
        turn(2, "I inferred mem#1323's author from the claim record."),
        turn(3, "Still unverified: mem#1323's author."),
      ],
      currentTurn: turn(4, "mem#1323 was written by that tab."),
      toolSubjectsByTurn: new Map(),
      elide: noElide,
    });

    expect(result.findings[0]?.hedgeTurnIndex).toBe(2);
  });

  test("reports each decayed subject once, not once per restating sentence", () => {
    const result = detectCrossTurnHedgeDecay({
      priorTurns: [turn(1, "I inferred mem#1323's author.")],
      currentTurn: turn(2, "mem#1323 was written at 20:55.\nmem#1323 kept right on working."),
      toolSubjectsByTurn: new Map(),
      elide: noElide,
    });

    expect(result.findings).toHaveLength(1);
  });
});

describe("subject extraction", () => {
  test("recognizes every decidable entity form", () => {
    const subjects = extractSubjects(
      "mt#4701 mem#1323 ask#10657 ws#12 PR #3412 " +
        "949192b5-ed9c-4191-a1fc-b176e4bdc2d6 .minsky/hooks/transcript.ts"
    );
    expect([...subjects.keys()].sort()).toEqual(
      [
        ".minsky/hooks/transcript.ts",
        "949192b5-ed9c-4191-a1fc-b176e4bdc2d6",
        "ask#10657",
        "mem#1323",
        "mt#4701",
        "pr#3412",
        "ws#12",
      ].sort()
    );
  });

  test("normalizes the PR spacing variants to one subject", () => {
    expect(normalizeSubject("PR #3412")).toBe("pr#3412");
    expect(normalizeSubject("PR#3412")).toBe("pr#3412");
    expect(normalizeSubject("pr #3412")).toBe("pr#3412");
  });

  test("a /g pattern does not skip matches across successive calls", () => {
    // Guards the shared-lastIndex hazard the module works around by re-constructing
    // each RegExp: without it, every other call would silently return fewer subjects.
    expect(extractSubjects("mt#1 mt#2").size).toBe(2);
    expect(extractSubjects("mt#1 mt#2").size).toBe(2);
  });

  test("bare prose numbers are not subjects", () => {
    expect(extractSubjects("23:14 UTC, 20:55, 1323 records").size).toBe(0);
  });
});

describe("claim-unit splitting", () => {
  test("splits on markdown line breaks as well as sentence terminators", () => {
    expect(splitClaimUnits("**Heading**\nA claim. Another claim.")).toEqual([
      "**Heading**",
      "A claim.",
      "Another claim.",
    ]);
  });
});

describe("hedge markers", () => {
  test("warrant vocabulary takes precedence over a natural-language hedge", () => {
    expect(findHedgeMarker("This is inferred and may be wrong")?.leg).toBe(WARRANT_LEG);
  });

  // PR #3419 R1: `unknown` is part of the ratified vocabulary and must be matched,
  // but only in LABEL POSITION — bare, it is an ordinary English word.
  test("`unknown` in label position IS a warrant marker", () => {
    for (const text of [
      "mem#1323's author (unknown: no discriminating probe run)",
      "mem#1323 — unknown, pending a grep",
      "warrant: unknown for mem#1323",
      "mem#1323 authorship, confidence = unknown",
      "unknown: whether mem#1323 was written here",
    ]) {
      expect(findHedgeMarker(text)?.leg, text).toBe(WARRANT_LEG);
    }
  });

  test("`unknown` describing the world is NOT a marker", () => {
    for (const text of [
      "the author is unknown",
      "an unknown actor holds the claim",
      "this fails for unknown reasons",
    ]) {
      expect(findHedgeMarker(text), text).toBeNull();
    }
  });

  // PR #3419 R2: the vocabulary leg must contain EXACTLY the four ratified labels, so
  // its fire rate means "the ratified labels are decaying" and not something vaguer.
  test("the vocabulary leg is exactly claim-confidence.mdc's four labels", () => {
    expect(WARRANT_VOCABULARY).toHaveLength(4);
    for (const [text, leg] of [
      ["mem#1323 is inferred", WARRANT_LEG],
      ["mem#1323 is assumed", WARRANT_LEG],
      ["mem#1323 — strong-evidence only", WARRANT_LEG],
      ["mem#1323 (unknown: no probe)", WARRANT_LEG],
      // A real hedge, but NOT a ratified label — measured on the other leg.
      ["mem#1323's author is unverified", NATURAL_LEG],
    ] as const) {
      expect(findHedgeMarker(text)?.leg, text).toBe(leg);
    }
  });

  test("ordinary confident prose carries no marker", () => {
    expect(findHedgeMarker("mem#1323 was written by dec670d8 at 20:55 UTC.")).toBeNull();
  });
});
