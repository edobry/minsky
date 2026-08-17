/**
 * mt#3587 — a recorded spec DEVIATION is a claim to VERIFY, not a resolution.
 *
 * `/implement-task` §7 item 5 tells an implementer who deviated from a spec decision to
 * "update the spec to record the change + rationale." It never says the rationale itself must
 * be verified, so an implementer can follow the item exactly, record a confidently-argued but
 * unchecked justification, and ship a wrong deviation — with the record making it look
 * reconciled to everyone downstream.
 *
 * Originating incident (mt#3571 / PR #2549 R1): a deviation from SC4 was recorded, with a
 * rationale reasoning about what a label MEANS while never checking what its CONSUMER does with
 * it. `isSuppressedRecord` (`src/domain/calibration/calibration-sweep.ts:1059`) is
 * `suppressionReasons.length > 0`, so an unlabeled record counts as an operator-facing fire —
 * inflating the very measurement that surface existed to produce. The reviewer caught it as
 * BLOCKING with no directive at all; this makes explicit what it did once unprompted.
 *
 * Shape constraint (mt#3547's replay measurements): the reviewer exhausts its tool budget at
 * every cap tested, and its cap=6 replication found the token saving comes at a real detection
 * cost. So the directive must ride the batched `submit_spec_verifications` call the reviewer
 * already makes and impose no new `read_file` obligation — asserted below, because "adds no
 * budget" is part of the contract rather than an intention.
 *
 * Lives in its own file rather than in `prompt.test.ts` because that file sits at the
 * `max-lines` ceiling (1500); appending there fails lint.
 */

import { describe, expect, test } from "bun:test";
import { buildCriticConstitution, buildReviewPrompt } from "./prompt";

const SAMPLE_DIFF = "diff --git a/foo b/foo";
const TOOLS_DIRECTIVE_HEADLINE = "A recorded DEVIATION is a claim to verify, not a resolution.";

describe("recorded-deviation verification instruction (mt#3587)", () => {
  test("tool-emission variant turns the entry on whether the rationale HOLDS, not on its presence", () => {
    const prompt = buildCriticConstitution(true, "normal", true);
    expect(prompt).toContain(TOOLS_DIRECTIVE_HEADLINE);
    expect(prompt).toContain("whether the rationale HOLDS");
    expect(prompt).toContain("never on whether a rationale is PRESENT");
  });

  test("tool-emission variant reuses the carve-out rule's actual-behavior standard", () => {
    // The phrasing already in the file (the carve-out entries) is extended rather than
    // paraphrased, so the two rules cannot drift into saying different things.
    const prompt = buildCriticConstitution(true, "normal", true);
    expect(prompt).toContain("not against its own self-description");
  });

  test("tool-emission variant rides the existing batched call and adds no read obligation", () => {
    // The budget constraint is asserted, not merely intended: mt#3547 measured the reviewer
    // exhausting its cap on every attempt, so a directive implying an extra round or an
    // unconditional read would displace existing coverage rather than add to it.
    const prompt = buildCriticConstitution(true, "normal", true);
    expect(prompt).toContain("inside this SAME batched call");
    expect(prompt).toContain("no extra tool round");
    expect(prompt).toContain("obliges no `read_file` you were not already going to make");
  });

  test("the budget clause does NOT read as a prohibition on using tools (R1)", () => {
    // R1 BLOCKING, and correct: the first wording — "no additional `read_file`" — was written as
    // a budget statement and reads as a ban, contradicting the constitution's own Tool Access
    // section ("Before making any claim about a file or directory that is not directly in the
    // diff, USE THE TOOLS to verify it"). A reviewer following the ban would decline exactly the
    // read a consumer-claim rationale most needs. The clause now names itself as a statement
    // about what the directive REQUIRES, and points back at Tool Access for what is permitted.
    const prompt = buildCriticConstitution(true, "normal", true);
    expect(prompt).toContain("not a restriction on what you may do");
    expect(prompt).toContain("exactly what the Tool Access section above is for");
    // The bare prohibition must be gone, not merely qualified elsewhere in the file.
    expect(prompt).not.toContain("no additional `read_file`");
  });

  test("the prose variant carries the same tool-use cue, so the variants do not drift (R1)", () => {
    const prompt = buildCriticConstitution(false);
    expect(prompt).toContain("use the tools per the Tool Access section");
  });

  test("tool-emission variant preserves the mt#3919 Unverifiable contract for an uncheckable rationale", () => {
    const prompt = buildCriticConstitution(true, "normal", true);
    expect(prompt).toContain('report the entry "Unverifiable" per the contract below');
    expect(prompt).toContain('do NOT guess "Not Met"');
    expect(prompt).toContain("do NOT accept the rationale as compliance");
  });

  test("no-tools (prose) variant carries the same instruction on the spec verification table", () => {
    const prompt = buildCriticConstitution(false);
    expect(prompt).toContain("that rationale is a claim to VERIFY, not a resolution");
    expect(prompt).toContain("never on whether a justification is PRESENT");
    expect(prompt).toContain("an unchecked rationale is not evidence of compliance");
  });

  test("the instruction appears in all three toolsAvailable/outputToolsActive combinations", () => {
    // Mirrors the mt#3217 carve-out coverage test: `buildCriticConstitution(true)` with
    // outputToolsActive at its false default falls back to the PROSE output format, so the
    // directive has to land in BOTH constants or one live combination ships without it.
    expect(buildCriticConstitution(true, "normal", true)).toContain("DEVIATION");
    expect(buildCriticConstitution(true, "normal", false)).toContain("DEVIATION");
    expect(buildCriticConstitution(false)).toContain("DEVIATION");
  });

  // The mt#3571 shape, reconstructed: a deviation recorded in the PR body whose rationale is a
  // claim about a CONSUMER. What the reviewer DOES with it is an LLM judgment call and not
  // unit-testable; what IS testable is that both halves reach the model — the deviation text in
  // the user prompt, the directive in the system prompt.
  const DEVIATION_PR_BODY = `Adds a log-only detector surface.

**SC4 deviation.** SC4 asks that the new surface be recorded under a suppression reason. I
deviated deliberately: "suppressed" misdescribes a claim that never enters the injection path,
so the record is written with no suppression reason at all.`;

  test("buildReviewPrompt carries a PR-body-recorded deviation into the reviewer's context, alongside the instruction", () => {
    const reviewPrompt = buildReviewPrompt({
      prNumber: 2549,
      prTitle: "log-only detector surface",
      prBody: DEVIATION_PR_BODY,
      taskSpec:
        "## Success Criteria\n\n- SC4: the new log-only surface is recorded under a suppression reason.",
      diff: SAMPLE_DIFF,
      authorshipTier: 3,
      branchName: "task/mt-3571",
      baseBranch: "main",
    });
    expect(reviewPrompt).toContain("SC4 deviation");
    expect(reviewPrompt).toContain("deviated deliberately");
    expect(buildCriticConstitution(true, "normal", true)).toContain(TOOLS_DIRECTIVE_HEADLINE);
  });
});
