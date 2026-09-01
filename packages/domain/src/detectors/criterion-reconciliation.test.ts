/**
 * mt#4213 — tests for the explanation-without-amendment matcher.
 *
 * The replay fixtures are VERBATIM text sampled from the recorded instances' own
 * specs, not hand-written variants: a fixture an author invented is evidence about
 * the author's model of the shape, not about the shape (mt#4114).
 */

import { describe, expect, test } from "bun:test";
import {
  amendedCriterionIds,
  detectCriterionReconciliation,
  UNMET_ASSERTIONS,
} from "./criterion-reconciliation";

/**
 * A stand-in for `elideMarkdownNonProse`, blanking fenced blocks with SAME-LENGTH
 * whitespace so offsets and line numbering survive — the property the real elider
 * guarantees and that `extractCriteria` depends on.
 *
 * Defined here rather than imported: the real one lives in `.minsky/hooks/`, and a
 * domain test importing across that boundary is the dependency inversion this
 * module's header declines. The adapter test exercises the real elider.
 */
function elide(text: string): string {
  let out = text;
  out = out.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "));
  return out;
}

/**
 * PR #3499 R1 (non-blocking): this stub is deliberately WEAKER than production —
 * it blanks fenced blocks only, where the real composition also covers code spans,
 * blockquotes and prose-quoted spans. That is safe in one direction and not the
 * other: under-eliding can only produce EXTRA matches, so a test that passes here
 * cannot be masking a false negative. The adapter test exercises the real elider.
 *
 * What both must share is LENGTH PRESERVATION, because the matcher reads offsets off
 * the elided text and applies them to the same string. Asserted rather than assumed.
 */
test("the stub elider is length- and line-preserving, like the real one", () => {
  const sample = ["# Heading", "", "text", "```", "fenced üñïçø∂é", "```", "tail"].join("\n");
  expect(elide(sample).length).toBe(sample.length);
  expect(elide(sample).split("\n").length).toBe(sample.split("\n").length);
});

const identity = (t: string): string => t;

/** Extracted so the heading is not a magic string repeated across fixtures. */
const SC_HEADING = "## Success Criteria";

describe("amendedCriterionIds", () => {
  test("numbers criteria by ordinal within their own section", () => {
    const spec = [
      SC_HEADING,
      "",
      "- [ ] first criterion",
      "- [ ] second criterion",
      "",
      "## Acceptance Tests",
      "",
      "- AT one",
      "- AT two",
      "- AT three",
    ].join("\n");

    expect(amendedCriterionIds(spec, identity)).toEqual(["SC1", "SC2", "AT1", "AT2", "AT3"]);
  });

  test("ignores bullets outside the two normative sections", () => {
    const spec = ["## Context", "", "- not a criterion", "- also not"].join("\n");
    expect(amendedCriterionIds(spec, identity)).toEqual([]);
  });
});

describe("detectCriterionReconciliation — the firing shape", () => {
  test("SC1: fires when a write asserts a criterion unmet and does not carry that criterion", () => {
    const write = [
      "## Outcome",
      "",
      "AT3 is not satisfied by the implementation as shipped; the flag table cannot",
      "change the outcome because the operand short-circuits first.",
    ].join("\n");

    const result = detectCriterionReconciliation(write, identity);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.criterionId).toBe("AT3");
    expect(result.findings[0]?.assertion).toBe("is not satisfied");
    expect(result.amended).toEqual([]);
  });

  test("finds the id across a 100-column wrap, not only on the assertion's own line", () => {
    const write = [
      "## Outcome",
      "",
      "The behaviour described by SC5 turned out to rest on a payload shape that the",
      "measured ceiling forbids, so that criterion is not satisfied as written.",
    ].join("\n");

    const result = detectCriterionReconciliation(write, identity);
    expect(result.findings.map((f) => f.criterionId)).toEqual(["SC5"]);
  });

  test("bounds the excerpt it records", () => {
    const write = `## Outcome\n\n${"x".repeat(4000)} SC2 is not satisfied ${"y".repeat(4000)}`;
    const result = detectCriterionReconciliation(write, identity);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.excerpt.length ?? 0).toBeLessThanOrEqual(200);
  });
});

describe("detectCriterionReconciliation — the three negative controls", () => {
  test("SC2: silent when the SAME write also amends the named criterion", () => {
    const write = [
      SC_HEADING,
      "",
      "- [ ] first criterion, untouched",
      "- [ ] second criterion, untouched",
      "- [ ] AT3's replacement: the corrected, satisfiable case",
      "",
      "## Outcome",
      "",
      "SC3 is not satisfied as originally written; amended above with the rationale.",
    ].join("\n");

    const result = detectCriterionReconciliation(write, identity);

    expect(result.amended).toContain("SC3");
    expect(result.findings).toEqual([]);
  });

  test("SC3a: silent when the unmet assertion names no criterion id", () => {
    const write = [
      "## Outcome",
      "",
      "One requirement is not satisfied and has been descoped; see the PR body.",
    ].join("\n");

    expect(detectCriterionReconciliation(write, identity).findings).toEqual([]);
  });

  test("SC3b: silent under a heading that RECORDS already-discharged work", () => {
    const write = [
      "## Required actions resolved (2026-08-19)",
      "",
      "AT3 is not satisfied was the finding; it has since been amended in place.",
    ].join("\n");

    expect(detectCriterionReconciliation(write, identity).findings).toEqual([]);
  });

  test("silent on an assertion quoted inside a fenced block", () => {
    const write = [
      "## Context",
      "",
      "The reviewer's wording to match is:",
      "",
      "```",
      "AT3 is not satisfied by the current implementation",
      "```",
    ].join("\n");

    expect(detectCriterionReconciliation(write, elide).findings).toEqual([]);
  });

  /**
   * Regression for a defect this suite caught during implementation: the adjacency
   * window was a flat character radius and crossed section headings, so a criterion
   * id sitting in a DIFFERENT section bound to an assertion that never referred to
   * it. Proximity in the file is not reference in the prose.
   */
  test("does not bind an id from a different section to this section's assertion", () => {
    const write = [
      SC_HEADING,
      "",
      "- [ ] the replacement for AT7, corrected and satisfiable",
      "",
      "## Outcome",
      "",
      "SC1 is not satisfied and is amended above.",
    ].join("\n");

    const result = detectCriterionReconciliation(write, identity);

    // AT7 is named in the criteria section, not by the assertion — it must not fire.
    expect(result.findings.map((f) => f.criterionId)).not.toContain("AT7");
  });

  test("silent on an empty or whitespace write", () => {
    expect(detectCriterionReconciliation("", identity).findings).toEqual([]);
    expect(detectCriterionReconciliation("   \n  ", identity).findings).toEqual([]);
  });
});

describe("PR #3499 R1 — the two BLOCKING defects", () => {
  /**
   * `is not met` contains `not met`. Scanning each phrase independently produced
   * TWO findings for one sentence, and the dedupe key included the phrase so it
   * could not collapse them.
   */
  test("overlapping phrases yield ONE finding, not one per phrase", () => {
    const write = "## Outcome\n\nSC2 is not met by the shipped implementation.";
    const result = detectCriterionReconciliation(write, identity);

    expect(result.findings).toHaveLength(1);
    // The LONGER phrase wins at that offset.
    expect(result.findings[0]?.assertion).toBe("is not met");
  });

  test("a criterion named twice in one section still yields one finding", () => {
    const write = "## Outcome\n\nSC2 is not satisfied. As noted, SC2 cannot be satisfied either.";
    expect(detectCriterionReconciliation(write, identity).findings).toHaveLength(1);
  });

  /**
   * `İ` (U+0130) lowercases to TWO code units, so a lowercased-copy search returned
   * offsets that no longer addressed the original string. Everything downstream —
   * the section clamp, the adjacency window, the excerpt — read from the wrong
   * place. One such character before the assertion is enough to show it.
   */
  test("a length-changing Unicode character does not shift the reported excerpt", () => {
    const write = `## Outcome\n\nİİİ context here. SC7 cannot be satisfied as written.`;
    const result = detectCriterionReconciliation(write, identity);

    expect(result.findings.map((f) => f.criterionId)).toEqual(["SC7"]);
    // The excerpt must contain the real assertion text, not a shifted slice.
    expect(result.findings[0]?.excerpt).toContain("cannot be satisfied");
  });

  test("the id is still found when the shift would have pushed it out of the window", () => {
    // 'İ' repeated ahead of the hit: under the old lowercased-copy search every
    // offset past this run was wrong by one per character.
    const write = `## Outcome\n\n${"İ".repeat(60)}\n\nSC3 is not satisfied.`;
    expect(
      detectCriterionReconciliation(write, identity).findings.map((f) => f.criterionId)
    ).toEqual(["SC3"]);
  });
});

describe("replay against the recorded instances (SC6)", () => {
  /**
   * R3 — mt#4162 / PR #3053. VERBATIM heading from that spec, which announced the
   * unmet criterion in a `###` heading while `## Acceptance Tests`' AT2 line stayed
   * as written.
   */
  test("R3 (mt#4162) fires", () => {
    const write = [
      "### AT2 is NOT satisfied, and half of it cannot be",
      "",
      "Checked rather than asserted (mt#4114's class):",
    ].join("\n");

    const result = detectCriterionReconciliation(write, identity);
    expect(result.findings.map((f) => f.criterionId)).toContain("AT2");
  });

  /**
   * R4 — mt#4320 / PR #3161. VERBATIM heading. Note it names TWO criteria; both are
   * legitimately unamended by this write, so both are reported.
   */
  test("R4 (mt#4320) fires", () => {
    const write = [
      "### AT3 as written cannot be satisfied by the fix SC1 describes",
      "",
      "`find . -path docs -prune` credits **every** prescribable directory.",
    ].join("\n");

    const result = detectCriterionReconciliation(write, identity);
    expect(result.findings.map((f) => f.criterionId)).toContain("AT3");
  });

  /**
   * R1 — mt#4038 / PR #2914. A RECORDED MISS, asserted so the gap is visible in the
   * suite rather than discovered later.
   *
   * Planning measured mt#4038's spec as containing NONE of `UNMET_ASSERTIONS`: its
   * author phrased the reconciliation as an amendment record ("the spec's `## Outcome`
   * section records an amendment" — the reviewer's own words on PR #2914 round 2),
   * not as an assertion that the criterion is unmet.
   *
   * **Do not fix this by extending `UNMET_ASSERTIONS`.** That is the regex arms race
   * ADR-024 exists to end and this module's header forbids; the evaluation stream
   * counts the miss, and a rung-2 climb is the sanctioned answer if recall binds.
   */
  test("R1 (mt#4038) is a KNOWN MISS at Rung 1 — asserted, not silently uncovered", () => {
    const write = [
      "## Outcome",
      "",
      "SC4 amended to include `structural` as a fifth axis-3 mechanism value, with the",
      "rationale recorded in docs/architecture/interceptors.md.",
    ].join("\n");

    const result = detectCriterionReconciliation(write, identity);
    expect(result.findings).toEqual([]);
  });

  /**
   * R2 — mt#4076 / PR #3047 wrote only to the PR BODY. Asserted absent rather than
   * silently uncovered: this seam sees spec writes, so a PR body never reaches it.
   */
  test("R2 (mt#4076) is out of scope — the PR-body surface never reaches this seam", () => {
    expect(UNMET_ASSERTIONS.length).toBeGreaterThan(0);
  });
});

describe("negative control (AT4)", () => {
  /**
   * With the amended-criterion suppression reverted to always-empty, the compliant
   * shape must FAIL — proving the SC2 test above can distinguish the two, rather
   * than passing because nothing ever fires.
   */
  test("compliant shape fires once the amended-set check is disabled", () => {
    const write = [
      SC_HEADING,
      "",
      "- [ ] first criterion, untouched",
      "- [ ] second criterion, untouched",
      "- [ ] AT3's replacement: the corrected, satisfiable case",
      "",
      "## Outcome",
      "",
      "SC3 is not satisfied as originally written; amended above with the rationale.",
    ].join("\n");

    // The real run is silent…
    expect(detectCriterionReconciliation(write, identity).findings).toEqual([]);

    // …and it is the amended set that makes it so: strip the criteria section and the
    // identical assertion fires. This is the control — the probe CAN fail.
    const withoutAmendment = write.split("## Outcome")[1] ?? "";
    const control = detectCriterionReconciliation(`## Outcome${withoutAmendment}`, identity);
    expect(control.findings.map((f) => f.criterionId)).toEqual(["SC3"]);
  });
});
