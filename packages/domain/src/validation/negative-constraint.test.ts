/**
 * Tests for the bare-prohibition detector (mt#3162).
 *
 * The load-bearing test in this file is the mt#3120 DISCRIMINATION PAIR: the real incident's
 * prompt carried BOTH a basis and an explicit licence to falsify (mem#702: "the same dispatch
 * prompt that carried the wrong constraint also stated the basis ... and granted explicit
 * latitude"), and the subagent used exactly that latitude to override the instruction and cite
 * the precedent. So the real prompt must PASS — it is the recoverable shape this mechanism
 * exists to reward — while a counterfactual bare version of the same instruction must FLAG.
 *
 * A detector that flagged both, or neither, would be worthless; the pair is what establishes it
 * discriminates on the property that actually mattered.
 *
 * Fixture provenance: the verbatim full prompt is not recoverable (the mt#3120 dispatch never
 * crossed `tasks_dispatch`, so no prompt was persisted, and a transcript full-text search for it
 * returned nothing). The fragments below are quoted verbatim from mem#702 (`e437d993`), which
 * records the prohibition ("do not attempt it") and the latitude grant ("if planning concludes
 * the retitle/rescope is warranted, amend the spec — that is expected") as direct quotes.
 */

import { describe, expect, test } from "bun:test";
import {
  analyzeNegativeConstraints,
  buildBareProhibitionMessage,
  BARE_PROHIBITION_PREFIX,
} from "./negative-constraint";

/**
 * The mt#3120 shape: a wrong prohibition, but shipped WITH its basis and an explicit licence to
 * falsify. Quoted fragments from mem#702, assembled into the prompt shape the memory describes.
 */
const MT3120_RECOVERABLE_PROMPT = [
  "The creation-time approach is blocked: the MCP caller-identity chain cannot distinguish a",
  "parent conversation from its subagents (Layer 1 is a per-process hash; Layer 3 is unbuilt),",
  "so do not attempt it in this task.",
  "",
  "If planning concludes the retitle/rescope is warranted, amend the spec — that is expected.",
].join("\n");

/** The same instruction stripped to a bare prohibition — no basis, no latitude. */
const MT3120_BARE_PROMPT = "The creation-time approach is blocked; do not attempt it in this task.";

describe("analyzeNegativeConstraints — mt#3120 discrimination pair", () => {
  test("the real (recoverable) mt#3120 prompt is NOT flagged as bare", () => {
    const report = analyzeNegativeConstraints(MT3120_RECOVERABLE_PROMPT);

    // The prohibition IS detected — we are not passing it by failing to see it.
    expect(report.findings.length).toBeGreaterThan(0);
    // ...but it carried both properties, so nothing is bare.
    expect(report.hasLicenceToFalsify).toBe(true);
    expect(report.findings.every((f) => f.hasBasis)).toBe(true);
    expect(report.bare).toEqual([]);
  });

  test("the same instruction stripped of basis and latitude IS flagged", () => {
    const report = analyzeNegativeConstraints(MT3120_BARE_PROMPT);

    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.hasLicenceToFalsify).toBe(false);
    expect(report.bare.length).toBeGreaterThan(0);
  });

  test("the pair differs only in the properties the mechanism targets", () => {
    const recoverable = analyzeNegativeConstraints(MT3120_RECOVERABLE_PROMPT);
    const bare = analyzeNegativeConstraints(MT3120_BARE_PROMPT);

    // Both contain the same prohibition phrases — the detector is not discriminating on
    // some incidental difference in wording.
    expect(bare.findings.some((f) => /do not attempt/i.test(f.phrase))).toBe(true);
    expect(recoverable.findings.some((f) => /do not attempt/i.test(f.phrase))).toBe(true);

    expect(recoverable.bare.length).toBe(0);
    expect(bare.bare.length).toBeGreaterThan(0);
  });
});

describe("analyzeNegativeConstraints — basis detection", () => {
  test("a prohibition with a because-clause but no licence is still bare", () => {
    const report = analyzeNegativeConstraints(
      "Do not build the polling path because the webhook already covers it."
    );

    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings[0]?.hasBasis).toBe(true);
    expect(report.hasLicenceToFalsify).toBe(false);
    // Basis alone does not make it recoverable — the recipient still has no standing to say so.
    expect(report.bare.length).toBeGreaterThan(0);
  });

  test("a prohibition with a licence but no basis is still bare", () => {
    const report = analyzeNegativeConstraints(
      "Do not build the polling path. If you find that wrong, say so and proceed."
    );

    expect(report.hasLicenceToFalsify).toBe(true);
    expect(report.findings[0]?.hasBasis).toBe(false);
    expect(report.bare.length).toBeGreaterThan(0);
  });

  test("a basis beyond the scan window does not count", () => {
    const report = analyzeNegativeConstraints(
      `Do not attempt the migration.${" filler.".repeat(60)} The reason is the ledger is locked.`
    );

    expect(report.findings[0]?.hasBasis).toBe(false);
  });
});

describe("analyzeNegativeConstraints — no false fire on ordinary prompts", () => {
  test("a prompt with no prohibition produces no findings", () => {
    const report = analyzeNegativeConstraints(
      "Implement the retry path per the spec's Acceptance Tests, then open a PR."
    );

    expect(report.findings).toEqual([]);
    expect(report.bare).toEqual([]);
  });

  test("empty, whitespace, and non-string input are safe", () => {
    expect(analyzeNegativeConstraints("").findings).toEqual([]);
    expect(analyzeNegativeConstraints("   \n  ").findings).toEqual([]);
    expect(analyzeNegativeConstraints(undefined).findings).toEqual([]);
    expect(analyzeNegativeConstraints(null).findings).toEqual([]);
  });

  test("repeated calls do not leak regex lastIndex state across invocations", () => {
    const text = "Do not attempt the migration. Do not attempt the backfill.";
    const first = analyzeNegativeConstraints(text);
    const second = analyzeNegativeConstraints(text);

    expect(first.findings.length).toBe(2);
    expect(second.findings.length).toBe(first.findings.length);
  });

  test("findings are ordered by position regardless of which pattern matched", () => {
    const report = analyzeNegativeConstraints(
      "This is not possible right now, and do not attempt the fallback either."
    );

    expect(report.findings.length).toBeGreaterThanOrEqual(2);
    const indices = report.findings.map((f) => f.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe("buildBareProhibitionMessage", () => {
  test("names the matched phrase and the accepted form", () => {
    const report = analyzeNegativeConstraints(MT3120_BARE_PROMPT);
    const message = buildBareProhibitionMessage(report);

    expect(message).toContain(BARE_PROHIBITION_PREFIX);
    expect(message).toContain("do not attempt");
    // The message must show the caller what to write instead, not just refuse.
    expect(message).toContain("BECAUSE");
    expect(message).toContain("say so and proceed");
  });

  test("distinguishes which property is missing", () => {
    const noLicence = buildBareProhibitionMessage(
      analyzeNegativeConstraints("Do not build it because the webhook covers it.")
    );
    expect(noLicence).toContain("no licence to falsify");

    const noBasis = buildBareProhibitionMessage(
      analyzeNegativeConstraints("Do not build it. If you find that wrong, say so.")
    );
    expect(noBasis).toContain("no basis stated");
  });
});

describe("PR #2260 R1 — regex corrections", () => {
  test('both "let me know if" and "tell me if" count as a licence', () => {
    // The prior single pattern matched the ungrammatical "tell me know if" and MISSED "tell me if".
    const letMeKnow = analyzeNegativeConstraints(
      "Do not attempt the migration because the ledger is locked. Let me know if that is wrong."
    );
    expect(letMeKnow.hasLicenceToFalsify).toBe(true);
    expect(letMeKnow.bare).toEqual([]);

    const tellMe = analyzeNegativeConstraints(
      "Do not attempt the migration because the ledger is locked. Tell me if that is wrong."
    );
    expect(tellMe.hasLicenceToFalsify).toBe(true);
    expect(tellMe.bare).toEqual([]);
  });

  test("benign scoping prose is not a prohibition", () => {
    // These are ordinary task-step instructions, not epistemic constraints on an approach.
    // The generic `skip` pattern and `avoid using` were removed for exactly this reason.
    for (const text of [
      "Skip the integration tests for now and focus on the unit layer.",
      "Skip this step if the fixture already exists.",
      "Avoid touching unrelated files in this PR.",
      "Avoid using the deprecated helper where a modern one exists.",
    ]) {
      const report = analyzeNegativeConstraints(text);
      expect(report.findings).toEqual([]);
      expect(report.bare).toEqual([]);
    }
  });

  test("benign scoping prose stays unflagged even with no licence text present", () => {
    const report = analyzeNegativeConstraints("Skip the integration tests.");
    expect(report.hasLicenceToFalsify).toBe(false);
    expect(report.bare).toEqual([]);
  });

  test("an approach-level prohibition is still caught after narrowing", () => {
    const report = analyzeNegativeConstraints("Do not pursue the polling approach in this task.");
    expect(report.bare.length).toBeGreaterThan(0);
  });

  test('the word "override" in technical prose does not grant a licence', () => {
    // A bare /\boverride\b/ marked this prompt as licenced, SUPPRESSING a true positive.
    const report = analyzeNegativeConstraints(
      "The creation-time approach is blocked; do not attempt it. Set the override env var to 1."
    );
    expect(report.hasLicenceToFalsify).toBe(false);
    expect(report.bare.length).toBeGreaterThan(0);
  });

  test('an instructional "override this" still grants a licence', () => {
    const report = analyzeNegativeConstraints(
      "Do not attempt it because the identity chain is unavailable. Override this if you find otherwise."
    );
    expect(report.hasLicenceToFalsify).toBe(true);
    expect(report.bare).toEqual([]);
  });
});
