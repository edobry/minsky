/**
 * Spec-criterion-claim matcher tests — mt#4153.
 *
 * The two AT replays are the load-bearing cases: each reproduces a real incident
 * where a self-authored criterion passed the full 16-criterion gate battery and
 * then did damage. AT1 (mt#3479) licensed a removal; AT2 (mt#2430) invented a
 * precondition that drew a BLOCKING review finding and nearly parked three ready
 * subtasks.
 *
 * Elision is exercised with a PASSTHROUGH here and with the real
 * `elideMarkdownNonProse` in `.minsky/hooks/spec-criterion-claim-detector.test.ts`.
 * That split is deliberate: this file tests the class logic, and a domain test
 * importing the hooks tree would invert the same layering the matcher's own
 * docblock declines to invert. SC8's assertion — that elision actually fires —
 * belongs where the real elider is wired, and it lives there.
 */

import { describe, test, expect } from "bun:test";
import {
  detectSpecCriterionClaims,
  extractCriteria,
  hasInlineVerifyingCommand,
  type AuthorizingSource,
} from "./spec-criterion-claim";

/** Identity elider — see the file docblock for why the real one is used elsewhere. */
const passthrough = (text: string): string => text;

const SC_HEADING = "## Success Criteria";
const AT_HEADING = "## Acceptance Tests";

/** Build a minimal spec with one scanned section. Named per `custom/no-magic-string-duplication`. */
const specWith = (heading: string, ...items: string[]): string =>
  [heading, "", ...items].join("\n");

const R2_ASK: AuthorizingSource = {
  askId: "ask#8467",
  chosen: "One decision record answering the seven open questions, then implementation subtasks",
  description:
    "Write a single ADR covering all seven questions, then file the implementation subtasks it implies.",
};

describe("Class A — unverified corpus-state assertion (mt#4153)", () => {
  test("AT1 replay: a `remains documented` criterion fires", () => {
    const spec = specWith(
      SC_HEADING,
      "- [ ] `MINSKY_ACK_UNTAKEN_ACTION` remains functional and remains documented in `CLAUDE.md` §Hook Files."
    );

    const result = detectSpecCriterionClaims(spec, null, passthrough);

    expect(result.matched).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.klass).toBe("A");
    expect(result.findings[0]?.phrase.toLowerCase()).toBe("remains");
    expect(result.findings[0]?.section).toBe("Success Criteria");
  });

  test("AT1 replay: the same criterion carrying its own grep does NOT fire", () => {
    // The silencer is the point of the class: a criterion that ships the one-line
    // check which would settle it is no longer an unverified assertion.
    const spec = specWith(
      SC_HEADING,
      "- [ ] `MINSKY_ACK_UNTAKEN_ACTION` remains documented — `grep -rn 'MINSKY_ACK_UNTAKEN_ACTION' CLAUDE.md` returns a hit."
    );

    expect(detectSpecCriterionClaims(spec, null, passthrough).matched).toBe(false);
  });

  test("a criterion with no corpus-state assertion does not fire", () => {
    const spec = specWith(SC_HEADING, "- [ ] The parser rejects a trailing comma.");
    expect(detectSpecCriterionClaims(spec, null, passthrough).matched).toBe(false);
  });

  // --- The corpus-referent conjunct -------------------------------------------
  //
  // These pin a NARROWING that a corpus measurement forced, and they are the only
  // thing standing between the referent requirement and a silent revert: every one
  // of the fixtures above happens to carry a backticked identifier, so all 37 tests
  // passed both before and after the conjunct was added. Measured over the 120
  // most-recently-updated specs, trigger-phrase-only matching fired on 69.2%;
  // requiring a referent in the same sentence took that to 50.8%. Both cases below
  // are verbatim shapes from that run's own false positives.
  //
  // Verified as negative controls rather than assumed (mt#3244): with the conjunct
  // disabled, exactly these two fail — 17 pass / 2 fail. The third is a POSITIVE
  // test and keeps passing when disabled, because it guards the sentence-splitting
  // that only binds while the conjunct is on.

  test("a trigger phrase with no corpus referent does NOT fire", () => {
    // Real FP (mt#4202): "still" as an ordinary adverb. Nothing here asserts
    // anything about the repo, so the sentence names nothing to go look at.
    const spec = specWith(
      SC_HEADING,
      "- [ ] Run the script against a cockpit with ingested conversations; it still reaches PASS."
    );
    expect(detectSpecCriterionClaims(spec, null, passthrough).matched).toBe(false);
  });

  test("a referent in a DIFFERENT sentence does not license the trigger", () => {
    // The conjunct is same-sentence on purpose: a referent anywhere in the criterion
    // would be satisfied by almost any real criterion, which is no conjunct at all.
    const spec = specWith(
      SC_HEADING,
      "- [ ] The handler still returns early. A separate pass rewrites `CLAUDE.md`."
    );
    expect(detectSpecCriterionClaims(spec, null, passthrough).matched).toBe(false);
  });

  test("a trigger and its referent on WRAPPED lines are one sentence", () => {
    // PR #3063 R1 (BLOCKING) + its non-blocking sibling: `\n` used to end the
    // sentence window, so the most ordinary shape in this repo — a bullet wrapped at
    // 100 chars, trigger on one line and referent on the next — was a false
    // negative.
    //
    // The referent must be on the SECOND line and nowhere on the first, or the test
    // cannot see the bug: the AT1 criterion carries `MINSKY_ACK_UNTAKEN_ACTION`
    // alongside its trigger, so it fires with or without the newline boundary.
    // Measured — that first draft passed 20/20 against the buggy regex.
    const spec = specWith(
      SC_HEADING,
      ["- [ ] The override remains documented", "      in `CLAUDE.md` §Hook Files."].join("\n")
    );

    const result = detectSpecCriterionClaims(spec, null, passthrough);

    expect(result.matched).toBe(true);
    expect(result.findings[0]?.klass).toBe("A");
  });

  test("a filename referent survives sentence splitting", () => {
    // `CLAUDE.md` carries a period, and splitting sentences on any `.` would cut it
    // in half — dropping the `md` and defeating the very pattern looking for it.
    const spec = specWith(SC_HEADING, "- [ ] The override remains documented in CLAUDE.md");
    expect(detectSpecCriterionClaims(spec, null, passthrough).matched).toBe(true);
  });

  test("Acceptance Tests are scanned too, not just Success Criteria", () => {
    const spec = specWith(
      AT_HEADING,
      "1. The override is already registered in `HOOK_ONLY_ENV_VARS`."
    );
    const result = detectSpecCriterionClaims(spec, null, passthrough);
    expect(result.matched).toBe(true);
    expect(result.findings[0]?.section).toBe("Acceptance Tests");
  });

  test("a trigger outside the scanned sections is ignored", () => {
    const spec = [
      "## Summary",
      "",
      "The override remains documented today, which is why this matters.",
      "",
      SC_HEADING,
      "",
      "- [ ] The parser rejects a trailing comma.",
    ].join("\n");
    expect(detectSpecCriterionClaims(spec, null, passthrough).matched).toBe(false);
  });
});

describe("Class B — invented precondition (mt#4153)", () => {
  test("AT2 replay: `once the ADR is accepted` fires when the ask never said accepted", () => {
    const spec = specWith(
      SC_HEADING,
      "- [ ] Implementation subtasks are filed once the ADR is accepted."
    );

    const result = detectSpecCriterionClaims(spec, R2_ASK, passthrough);

    expect(result.matched).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.klass).toBe("B");
    expect(result.findings[0]?.condition?.toLowerCase()).toBe("accepted");
    expect(result.findings[0]?.askId).toBe("ask#8467");
  });

  test("AT3 negative control: a precondition PRESENT in the chosen option does not fire", () => {
    // The ask's own words gate on the decision record landing, so a criterion that
    // gates on the same thing is authorized, not invented.
    const source: AuthorizingSource = {
      askId: "ask#8467",
      chosen: "One decision record, merged first, then implementation subtasks",
      description: "The ADR must be merged before subtasks are filed.",
    };
    const spec = specWith(
      SC_HEADING,
      "- [ ] Implementation subtasks are filed once the ADR is merged."
    );

    expect(detectSpecCriterionClaims(spec, source, passthrough).matched).toBe(false);
  });

  test("AT3 negative control: with no linked ask, Class B never fires", () => {
    // An unlinked task has no machine-readable authorization to compare against,
    // and guessing is worse than silence (SC2).
    const spec = specWith(
      SC_HEADING,
      "- [ ] Implementation subtasks are filed once the ADR is accepted."
    );

    const result = detectSpecCriterionClaims(spec, null, passthrough);
    expect(result.matched).toBe(false);
    expect(result.authorizingSourceAvailable).toBe(false);
  });

  test("the description is read as authorization, not only the chosen label", () => {
    // The real constraint routinely lives in the option's description rather than
    // its label, so reading the label alone would fire on authorized work.
    const source: AuthorizingSource = {
      askId: "ask#1",
      chosen: "Ship it",
      description: "Land the change once the migration is done.",
    };
    const spec = specWith(SC_HEADING, "- [ ] The change lands once the migration is done.");
    expect(detectSpecCriterionClaims(spec, source, passthrough).matched).toBe(false);
  });

  test("an object-form gate fires when nothing in it traces to the source", () => {
    const source: AuthorizingSource = {
      askId: "ask#2",
      chosen: "Build the detector now",
      description: "Ship the matcher and its tests.",
    };
    const spec = specWith(
      SC_HEADING,
      "- [ ] The flip ships, contingent on operator triage of the calibration corpus."
    );
    const result = detectSpecCriterionClaims(spec, source, passthrough);
    expect(result.matched).toBe(true);
    expect(result.findings[0]?.klass).toBe("B");
  });

  test("an object-form gate stays silent when one token traces to the source", () => {
    // A single shared token makes the gate arguably authorized, and silence is the
    // right default for an arguable case.
    const source: AuthorizingSource = {
      askId: "ask#2",
      chosen: "Build the detector after operator triage",
      description: "Triage first.",
    };
    const spec = specWith(
      SC_HEADING,
      "- [ ] The flip ships, contingent on operator triage of the calibration corpus."
    );
    expect(detectSpecCriterionClaims(spec, source, passthrough).matched).toBe(false);
  });
});

describe("criterion extraction (mt#4153)", () => {
  test("a wrapped bullet is one criterion, including its continuation lines", () => {
    const spec = specWith(
      SC_HEADING,
      "- [ ] The detector ships and the override",
      "      remains documented in `CLAUDE.md`.",
      "- [ ] A second, unrelated criterion."
    );

    const criteria = extractCriteria(spec, passthrough);
    expect(criteria).toHaveLength(2);
    // The trigger sits on the continuation line, and is still found.
    const result = detectSpecCriterionClaims(spec, null, passthrough);
    expect(result.matched).toBe(true);
    expect(result.criteriaExamined).toBe(2);
  });

  test("criteriaExamined counts what was scanned — the evaluation stream's denominator", () => {
    const spec = [SC_HEADING, "", "- [ ] One.", "- [ ] Two.", "", AT_HEADING, "", "1. Three."].join(
      "\n"
    );
    expect(detectSpecCriterionClaims(spec, null, passthrough).criteriaExamined).toBe(3);
  });

  test("an empty or section-less spec yields nothing rather than throwing", () => {
    expect(detectSpecCriterionClaims("", null, passthrough).criteriaExamined).toBe(0);
    expect(detectSpecCriterionClaims("## Summary\n\nJust prose.", null, passthrough).matched).toBe(
      false
    );
  });
});

describe("inline verifying command (mt#4153)", () => {
  test("recognizes a command leader inside a code span", () => {
    expect(hasInlineVerifyingCommand("check `grep -rn FOO CLAUDE.md` returns a hit")).toBe(true);
    expect(hasInlineVerifyingCommand("check `$ rg FOO` returns a hit")).toBe(true);
    expect(hasInlineVerifyingCommand("run `bun test ./x.test.ts`")).toBe(true);
  });

  test("a code span that is not a command does not silence anything", () => {
    expect(hasInlineVerifyingCommand("`MINSKY_ACK_FOO` remains documented")).toBe(false);
    expect(hasInlineVerifyingCommand("no spans at all")).toBe(false);
  });
});
