/**
 * Unit tests for consent-surface.ts (mt#3581, ADR-032).
 *
 * In-memory only — this module has no fs/DB seam and reads no clock.
 *
 * The spec's acceptance tests are pinned by name below. The load-bearing one is
 * the vocabulary check: it asserts by LITERAL SEARCH that the customer-facing
 * text carries no guard name, no threshold key, and no digit, because that
 * property is the whole point of the surface and is trivially broken by editing
 * a string.
 */

import { describe, test, expect } from "bun:test";
import {
  PREFERENCE_SUBJECTS,
  findSubject,
  renderConsentQuestion,
  findVocabularyLeaks,
  decideApplication,
  interpretPreference,
  stepForNudge,
} from "./consent-surface";
import { PREFERENCE_OVERRIDE_MAX_MULTIPLE, type ThresholdProposal } from "./threshold-tuning";

const WALL_OF_TEXT_KEY = "MINSKY_WALL_OF_TEXT_WORD_BUDGET";
const SHIPPED_DEFAULT = 200;
const OUT_OF_BOUNDS = "value-outside-bounds";

function proposal(overrides: Partial<ThresholdProposal> = {}): ThresholdProposal {
  return {
    kind: "proposal",
    guardName: "wall-of-text-detector",
    thresholdKey: WALL_OF_TEXT_KEY,
    currentValue: SHIPPED_DEFAULT,
    proposedValue: 330,
    basis: {
      labeledCount: 8,
      dismissedCount: 7,
      dismissedRate: 0.875,
      clampedToBound: false,
      clampedByHeeded: false,
    },
    requiresConsent: true,
    ...overrides,
  };
}

const context = {
  tuningOwnership: "preference" as const,
  shippedDefault: SHIPPED_DEFAULT,
  maxMultiple: PREFERENCE_OVERRIDE_MAX_MULTIPLE,
};

describe("the consent question carries none of Minsky's vocabulary", () => {
  test("AT2: the prompt and buttons contain no guard name, threshold key, or number", () => {
    for (const subject of PREFERENCE_SUBJECTS) {
      const question = renderConsentQuestion(subject);
      const leaks = findVocabularyLeaks(question, {
        thresholdKey: subject.thresholdKey,
        guardName: "wall-of-text-detector",
      });
      expect(leaks).toEqual([]);
    }
  });

  test("the leak check can actually fail — it is not vacuous", () => {
    const leaky = {
      prompt: `raise ${WALL_OF_TEXT_KEY} to 330`,
      options: ["ok", "no"] as [string, string],
    };
    const leaks = findVocabularyLeaks(leaky, { thresholdKey: WALL_OF_TEXT_KEY });

    expect(leaks).toContain("contains a digit");
    expect(leaks).toContain(WALL_OF_TEXT_KEY);
    expect(leaks).toContain("contains an env-var name");
  });

  test("renders the principal's chosen register: first person, observation then offer", () => {
    const subject = findSubject(WALL_OF_TEXT_KEY);
    expect(subject).toBeDefined();
    if (!subject) return;

    const { prompt, options } = renderConsentQuestion(subject);
    expect(prompt).toBe(
      "I've been flagging your updates as too long fairly often lately — want me to ease off?"
    );
    expect(options).toEqual(["Ease off", "Keep as is"]);
  });

  test("frequency is a word, never a count", () => {
    const subject = findSubject(WALL_OF_TEXT_KEY);
    if (!subject) throw new Error("subject missing");
    expect(renderConsentQuestion(subject, "a lot").prompt).toContain("a lot");
    expect(renderConsentQuestion(subject, "a lot").prompt).not.toMatch(/\d/);
  });
});

describe("decideApplication", () => {
  test("AT6: an invariant-class guard is refused", () => {
    const decision = decideApplication(proposal(), { ...context, tuningOwnership: "invariant" });
    expect(decision).toEqual({ kind: "refuse", reason: "invariant-class-never-tunable" });
  });

  test("a no-consent proposal is refused — that path is mt#3633, not this task", () => {
    const decision = decideApplication(proposal({ requiresConsent: false }), context);
    expect(decision).toEqual({ kind: "refuse", reason: "no-consent-path-not-in-this-task" });
  });

  test("AT4: a consented proposal applies at exactly the proposed value", () => {
    expect(decideApplication(proposal(), context)).toEqual({ kind: "apply", value: 330 });
  });

  test("bounds are re-checked rather than trusted from the proposal", () => {
    // The decider would never emit this; the point is that a value crossing the
    // module boundary is checked again before it becomes a live threshold.
    const overCeiling = decideApplication(proposal({ proposedValue: 99999 }), context);
    expect(overCeiling).toEqual({ kind: "refuse", reason: OUT_OF_BOUNDS });

    const fractional = decideApplication(proposal({ proposedValue: 330.5 }), context);
    expect(fractional).toEqual({ kind: "refuse", reason: OUT_OF_BOUNDS });

    const zero = decideApplication(proposal({ proposedValue: 0 }), context);
    expect(zero).toEqual({ kind: "refuse", reason: OUT_OF_BOUNDS });
  });

  test("a threshold with no customer-facing subject is refused, not applied silently", () => {
    const decision = decideApplication(
      proposal({ thresholdKey: "MINSKY_SOMETHING_UNNAMED" }),
      context
    );
    expect(decision).toEqual({ kind: "refuse", reason: "unknown-threshold-key" });
  });
});

describe("interpretPreference — the customer's own words", () => {
  test("maps annoyance about length to loosening the length threshold", () => {
    for (const phrase of [
      "stop telling me my updates are too long",
      "these summaries are too long, ease off",
      "fewer length reminders please",
    ]) {
      expect(interpretPreference(phrase)).toEqual({
        kind: "nudge",
        nudge: { thresholdKey: WALL_OF_TEXT_KEY, direction: "loosen" },
      });
    }
  });

  test("maps a request for earlier check-ins to tightening the quiet threshold", () => {
    expect(interpretPreference("tell me sooner when you go quiet")).toEqual({
      kind: "nudge",
      nudge: { thresholdKey: "MINSKY_SILENT_STRETCH_GAP_MINUTES", direction: "tighten" },
    });
  });

  test("AT: reversal uses the same vocabulary and is read as the opposite nudge", () => {
    expect(interpretPreference("actually, keep flagging those long updates")).toEqual({
      kind: "nudge",
      nudge: { thresholdKey: WALL_OF_TEXT_KEY, direction: "tighten" },
    });
  });

  test("an unmatched phrase returns null rather than guessing a guard", () => {
    expect(interpretPreference("hello").kind).toBe("no-match");
    expect(interpretPreference("").kind).toBe("no-match");
    expect(interpretPreference("stop").kind).toBe("no-match"); // direction without a subject
    expect(interpretPreference("my updates").kind).toBe("no-match"); // subject without a direction
  });
});

/**
 * PR #2577 R1. Both ties used to be broken silently, so a phrase naming two
 * subjects moved a threshold the customer never mentioned — and the surface
 * deliberately shows them no numbers to notice it by.
 */
describe("interpretPreference — ambiguity is reported, not resolved", () => {
  test("a phrase naming both subjects is ambiguous rather than length-wins", () => {
    const result = interpretPreference("stop nagging me about long updates and going quiet");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.reason).toBe("two-subjects");
    expect(result.candidates).toHaveLength(2);
  });

  test("a phrase pulling both directions is ambiguous rather than loosen-wins", () => {
    const result = interpretPreference("fewer length reminders but be stricter about my reports");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.reason).toBe("two-directions");
    expect(result.candidates).toEqual(["loosen", "tighten"]);
  });

  test("an unambiguous phrase still resolves — the check does not over-fire", () => {
    expect(interpretPreference("stop telling me my updates are too long").kind).toBe("nudge");
  });
});

describe("stepForNudge — one bounded step, repeatable", () => {
  const nudge = { thresholdKey: WALL_OF_TEXT_KEY, direction: "loosen" as const };
  const stepContext = {
    currentValue: SHIPPED_DEFAULT,
    shippedDefault: SHIPPED_DEFAULT,
    maxMultiple: PREFERENCE_OVERRIDE_MAX_MULTIPLE,
  };

  test("AT5: expressing the same preference twice moves two steps", () => {
    const first = stepForNudge(nudge, stepContext);
    expect(first).toBe(250);

    const second = stepForNudge(nudge, { ...stepContext, currentValue: first ?? 0 });
    expect(second).toBe(300);
  });

  test("AT5: repeated nudges stop at the ceiling rather than running away", () => {
    let value = SHIPPED_DEFAULT;
    for (let i = 0; i < 100; i++) {
      const next = stepForNudge(nudge, { ...stepContext, currentValue: value });
      if (next === null) break;
      value = next;
    }

    expect(value).toBe(SHIPPED_DEFAULT * PREFERENCE_OVERRIDE_MAX_MULTIPLE);
    expect(stepForNudge(nudge, { ...stepContext, currentValue: value })).toBeNull();
  });

  test("steps are linear in the shipped default, not compounding on the current value", () => {
    // 25% of 200 is 50 at every current value, so three steps is exactly +150.
    const a = stepForNudge(nudge, { ...stepContext, currentValue: 200 });
    const b = stepForNudge(nudge, { ...stepContext, currentValue: a ?? 0 });
    const c = stepForNudge(nudge, { ...stepContext, currentValue: b ?? 0 });
    expect(c).toBe(350);
  });

  test("tightening moves the other way and stops at the floor", () => {
    const tighten = { thresholdKey: WALL_OF_TEXT_KEY, direction: "tighten" as const };
    expect(stepForNudge(tighten, stepContext)).toBe(150);

    const atFloor = Math.max(1, Math.ceil(SHIPPED_DEFAULT / PREFERENCE_OVERRIDE_MAX_MULTIPLE));
    expect(stepForNudge(tighten, { ...stepContext, currentValue: atFloor })).toBeNull();
  });

  test("a step is at least 1 even for a small shipped default", () => {
    const small = {
      currentValue: 2,
      shippedDefault: 2,
      maxMultiple: PREFERENCE_OVERRIDE_MAX_MULTIPLE,
    };
    expect(stepForNudge(nudge, small)).toBe(3);
  });
});
