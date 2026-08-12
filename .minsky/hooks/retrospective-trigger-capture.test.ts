/**
 * Judged-input capture on `retrospective-trigger` calibration records (mt#3821).
 *
 * Its own file rather than an append to `retrospective-trigger-scanner.test.ts`,
 * which sits at 1,911 lines — the same ceiling constraint mt#3649 hit on the
 * `code-mechanism-assertion` suite.
 */

import { describe, expect, test } from "bun:test";
import { hashJudgedText, hasJudgedInputCapture } from "./judged-input-capture";
import { elideQuotedAndCodeContexts } from "./elision";
import {
  captureInjectedInput,
  detectTriggerPhrasesWithNomination,
} from "./retrospective-trigger-scanner";
import type { NominationDeps } from "../../packages/domain/src/detectors/embedding-nomination";

/**
 * A nomination stage that nominates one family on a fixed segment, without a
 * provider. `nominate` scores cosine similarity against the exemplar set, so
 * embedding the candidate and the target exemplar identically is what makes a
 * nomination certain; every other exemplar gets an orthogonal vector.
 */
function nominatingDeps(segment: string): NominationDeps {
  return {
    embed: async (texts: string[]) =>
      texts.map((text) => (text.includes(segment) || text.includes("R1") ? [1, 0] : [0, 1])),
  } as unknown as NominationDeps;
}

describe("captureInjectedInput", () => {
  test("cuts the excerpt from the elided copy, not the raw turn", () => {
    // The phrase appears twice: first inside a fenced block the detector blanks,
    // then in live prose. A raw cut finds the fenced one — the span the rung
    // deliberately did not judge.
    const raw = [
      "Here is what the guard matches:",
      "```",
      "I was wrong about the schema",
      "```",
      "",
      "Now the real admission. I was wrong about the schema and shipped it anyway.",
    ].join("\n");

    const captured = captureInjectedInput(raw, "I was wrong about the schema");
    expect(captured.excerpt).toContain("Now the real admission.");
    expect(captured.excerpt).not.toContain("Here is what the guard matches:");
  });

  test("hashes the whole elided text, and the length describes that same text", () => {
    const raw = "prose before. I was wrong here. prose after.";
    const elided = elideQuotedAndCodeContexts(raw);
    const captured = captureInjectedInput(raw, "I was wrong here.");

    expect(captured.capture.judgedTextHash).toBe(hashJudgedText(elided));
    expect(captured.capture.judgedTextLength).toBe(elided.length);
  });

  test("still identifies the judged text when the phrase is not locatable", () => {
    // PR #2938 R1: an unlocatable phrase costs the EXCERPT, never the identity.
    // A hash-bearing record is replayable through the reconstruction script
    // whether or not an offset was recoverable, so withholding the marker here
    // would strip a record that is in fact re-classifiable.
    const raw = "some unrelated prose";
    const captured = captureInjectedInput(raw, "a phrase not present");

    expect(captured.excerpt).toBe("");
    expect(captured.capture.judgedTextHash).toBe(hashJudgedText(elideQuotedAndCodeContexts(raw)));
    expect(captured.capture.judgedTextLength).toBe(elideQuotedAndCodeContexts(raw).length);
  });
});

describe("detectTriggerPhrasesWithNomination capture", () => {
  const text = "Checking the two paths now. Both hold up under the second read.";

  test("carries the judged text's identity even when nothing is nominated", async () => {
    const result = await detectTriggerPhrasesWithNomination(text, nominatingDeps("nothing here"));
    const elided = elideQuotedAndCodeContexts(text);

    expect(result.capture?.judgedTextHash).toBe(hashJudgedText(elided));
    expect(result.capture?.judgedTextLength).toBe(elided.length);
  });

  test("carries the capture on a DEGRADED stage, which still writes a record", async () => {
    const failing = {
      embed: async () => {
        throw new Error("provider down");
      },
    } as unknown as NominationDeps;

    const result = await detectTriggerPhrasesWithNomination(text, failing);
    expect(result.degradedReason).toBeDefined();
    // The un-auditable shape this task ends: a record naming a degraded stage
    // and nothing about the text it was degraded on.
    expect(result.capture?.judgedTextHash).toBe(hashJudgedText(elideQuotedAndCodeContexts(text)));
  });

  test("a null nomination provider still yields a capture", async () => {
    const result = await detectTriggerPhrasesWithNomination(text, null);
    expect(result.degradedReason).toBe("provider-unconfigured");
    expect(result.capture?.judgedTextHash).toBe(hashJudgedText(elideQuotedAndCodeContexts(text)));
  });
});

describe("the record fields a capture produces", () => {
  test("hasJudgedInputCapture is true for a record built from a capture", () => {
    const captured = captureInjectedInput("prose. I was wrong here. more prose.", "I was wrong");
    const record: Record<string, unknown> = {
      matches: [{ family: "R1", phrase: "I was wrong" }],
      transcript_excerpt: captured.excerpt,
      captureSchema: 1,
      judged_text_hash: captured.capture.judgedTextHash,
    };
    expect(hasJudgedInputCapture(record)).toBe(true);
  });

  test("and false for the pre-mt#3821 record shape", () => {
    expect(
      hasJudgedInputCapture({
        matches: [{ family: "R1", phrase: "I was wrong" }],
        transcript_excerpt: "…I was wrong…",
      })
    ).toBe(false);
  });
});
