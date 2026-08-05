import { describe, expect, it } from "bun:test";

import {
  ARTIFACT_CAPTURE_MAX_CHARS,
  captureArtifact,
  CAPTURE_SCHEMA_FIELD,
  CAPTURE_SCHEMA_VERSION,
  extractMatchContext,
  hasJudgedInputCapture,
  hashJudgedText,
  MATCH_CONTEXT_MAX_CHARS,
} from "./judged-input-capture";
import { detectDeferralPhrases } from "./ask-routing-deferral-detector";
import { checkTestFirstEvidence, runTestFirstCalibration } from "./test-first-evidence";
import type { PrFile } from "./require-execution-evidence-before-merge";
import { assessClassifiability } from "../../src/domain/calibration/calibration-sweep";

// ---------------------------------------------------------------------------
// Fixtures — the mt#3584 scenario, which is the incident this task descends from
// ---------------------------------------------------------------------------

const BUGFIX_TITLE = "fix(mt#1234): correct the thing";
const BUGFIX_FILES: PrFile[] = [
  { filename: "src/domain/thing.test.ts", status: "modified" },
  { filename: "src/domain/thing.ts", status: "modified" },
];

/**
 * A body whose negative-control label sits ABOVE the `Execution evidence:`
 * heading — accepted by the current matcher, so this PR does NOT flag.
 */
const BODY_LABEL_ABOVE = [
  "## Testing",
  "",
  "Negative control: reverted the fix, the test went red.",
  "",
  "Execution evidence:",
  "",
  "```",
  " 12 pass 0 fail",
  "```",
].join("\n");

/** The same PR after an edit that removes the label entirely — now it WOULD flag. */
const BODY_LABEL_REMOVED = [
  "## Testing",
  "",
  "Execution evidence:",
  "",
  "```",
  " 12 pass 0 fail",
  "```",
].join("\n");

/**
 * Re-derive the verdict from a calibration record ALONE.
 *
 * The point of the exercise is what this function does NOT take: no PR number,
 * no forge client, no task id to fetch a spec with. Everything it feeds the
 * matcher comes off the record.
 */
function rederiveFromRecord(record: {
  prTitle: string;
  modifiedTestFiles: string[];
  judgedPrBody: { excerpt: string };
  judgedSpec: { excerpt: string } | null;
}) {
  const files: PrFile[] = record.modifiedTestFiles.map((filename) => ({
    filename,
    status: "modified",
  }));
  return checkTestFirstEvidence(
    files,
    record.prTitle,
    record.judgedPrBody.excerpt,
    record.judgedSpec?.excerpt ?? null
  );
}

// ---------------------------------------------------------------------------

describe("captureArtifact", () => {
  it("carries the text unchanged, with a hash of it, when under the cap", () => {
    const capture = captureArtifact("a short body");
    expect(capture.excerpt).toBe("a short body");
    expect(capture.truncated).toBe(false);
    expect(capture.length).toBe("a short body".length);
    expect(capture.hash).toBe(hashJudgedText("a short body"));
  });

  // AT4 — capture is truncated at the documented cap.
  it("truncates at the documented cap and says so, hashing the FULL text", () => {
    const long = "x".repeat(ARTIFACT_CAPTURE_MAX_CHARS + 500);
    const capture = captureArtifact(long);

    expect(capture.excerpt.length).toBeLessThanOrEqual(ARTIFACT_CAPTURE_MAX_CHARS);
    expect(capture.truncated).toBe(true);
    expect(capture.length).toBe(long.length);
    // The hash covers the whole artifact, not the excerpt — otherwise two
    // different bodies sharing a prefix would hash identically and mutation
    // past the cut would be invisible, which is the property the hash exists for.
    expect(capture.hash).toBe(hashJudgedText(long));
    expect(capture.hash).not.toBe(hashJudgedText(capture.excerpt));
  });

  it("gives a mutated artifact a different hash", () => {
    expect(captureArtifact(BODY_LABEL_ABOVE).hash).not.toBe(
      captureArtifact(BODY_LABEL_REMOVED).hash
    );
  });
});

describe("extractMatchContext", () => {
  it("returns the sentence containing the match, not the whole text", () => {
    const text = "First sentence here. The decision needs your call. Third one after.";
    const index = text.indexOf("needs your call");
    const context = extractMatchContext(text, index, "needs your call".length);

    expect(context).toBe("The decision needs your call.");
  });

  it("includes one preceding sentence when asked, and only when asked", () => {
    const text = "I cannot settle this. What's your call?";
    const index = text.indexOf("What's your call");
    const len = "What's your call".length;

    expect(extractMatchContext(text, index, len)).toBe("What's your call?");
    expect(extractMatchContext(text, index, len, { leadSentences: 1 })).toBe(
      "I cannot settle this. What's your call?"
    );
  });

  it("caps the context at the documented bound", () => {
    const filler = "y".repeat(MATCH_CONTEXT_MAX_CHARS * 2);
    const text = `${filler} needs your call`;
    const index = text.indexOf("needs your call");
    const context = extractMatchContext(text, index, "needs your call".length);

    expect(context.length).toBeLessThanOrEqual(MATCH_CONTEXT_MAX_CHARS);
  });
});

describe("test-first calibration record — retrospective re-derivation (mt#3607)", () => {
  // AT1 — write a record from a known input; re-derive the verdict from the
  // record alone, with no fetch, and assert it matches what the record carries.
  it("AT1: the recorded verdict re-derives from the record with no fetch", () => {
    const run = runTestFirstCalibration(
      "mt#1234",
      2531,
      BUGFIX_FILES,
      BUGFIX_TITLE,
      BODY_LABEL_REMOVED,
      null
    );

    const record = run.calibrationRecord;
    expect(record).not.toBeNull();
    if (!record) return;

    const rederived = rederiveFromRecord(record);

    expect(rederived.negativeControlPresent).toBe(record.negativeControlPresent);
    expect(rederived.negativeControlUnmatched).toBe(record.negativeControlUnmatched);
    expect(rederived.bugfixShaped).toBe(record.bugfixShaped);
    expect(rederived.deferralMarker).toBe(record.deferralMarker);
    expect(rederived.modifiedTestFiles).toEqual(record.modifiedTestFiles);
    // The record only exists because the check fired, so the re-derivation must
    // reproduce the fire — a re-derivation that says "clean" is the mt#3584 bug.
    expect(rederived.flagged).toBe(true);
  });

  // AT2 — mutate the source artifact (simulate a PR-body edit) and re-run AT1.
  // The re-derivation from the RECORD still matches; the re-derivation from the
  // mutated artifact does not. That divergence is the property that fails today.
  it("AT2: an edit to the PR body cannot change what the record re-derives to", () => {
    const run = runTestFirstCalibration(
      "mt#1234",
      2531,
      BUGFIX_FILES,
      BUGFIX_TITLE,
      BODY_LABEL_REMOVED,
      null
    );
    const record = run.calibrationRecord;
    expect(record).not.toBeNull();
    if (!record) return;

    // The author edits the body afterwards, adding the label that was missing.
    const mutated = BODY_LABEL_ABOVE;
    const fromMutatedArtifact = checkTestFirstEvidence(BUGFIX_FILES, BUGFIX_TITLE, mutated, null);
    const fromRecord = rederiveFromRecord(record);

    // Re-checking the CURRENT artifact reports clean — this is exactly how
    // mt#3584 lost PR #2531's false positive.
    expect(fromMutatedArtifact.flagged).toBe(false);
    // Re-deriving from the record still reports the fire it recorded.
    expect(fromRecord.flagged).toBe(true);
    expect(fromRecord.flagged).toBe(record.decision === "warn");
    // And the mutation is DETECTABLE rather than merely survivable.
    expect(hashJudgedText(mutated)).not.toBe(record.judgedPrBody.hash);
  });

  it("captures the spec too, so the bugfix-shaped half re-derives from a spec-only trigger", () => {
    // Title is NOT bugfix-shaped; the spec is what makes this fire.
    const run = runTestFirstCalibration(
      "mt#1234",
      2531,
      BUGFIX_FILES,
      "chore(mt#1234): tidy",
      BODY_LABEL_REMOVED,
      "This is a bug: the parser drops the final row."
    );
    const record = run.calibrationRecord;
    expect(record).not.toBeNull();
    if (!record) return;

    expect(record.bugfixShaped).toBe(true);
    expect(record.judgedSpec).not.toBeNull();
    // Without the captured spec the re-derivation would read `bugfixShaped:
    // false` and disagree with the record it came from.
    expect(rederiveFromRecord(record).bugfixShaped).toBe(true);
  });
});

describe("capture-schema marker (mt#3607 criterion 4)", () => {
  // AT3 — a record written before the cutover is distinguishable from one
  // written after by a mechanical check, not by inspection date.
  it("AT3: pre-capture and post-capture records are mechanically distinguishable", () => {
    // Verbatim shape of a real pre-capture record, from
    // `.minsky/execution-evidence-test-first-calibration.jsonl`.
    const preCapture = {
      timestamp: "2026-07-30T12:00:00.000Z",
      task: "mt#1234",
      prNumber: 2400,
      decision: "warn",
      modifiedTestFiles: ["src/domain/thing.test.ts"],
      bugfixShaped: true,
      negativeControlPresent: false,
      negativeControlUnmatched: false,
      deferralMarker: null,
    };

    const run = runTestFirstCalibration(
      "mt#1234",
      2531,
      BUGFIX_FILES,
      BUGFIX_TITLE,
      BODY_LABEL_REMOVED,
      null
    );
    const postCapture = run.calibrationRecord as unknown as Record<string, unknown>;

    expect(hasJudgedInputCapture(preCapture)).toBe(false);
    expect(hasJudgedInputCapture(postCapture)).toBe(true);
    expect(postCapture[CAPTURE_SCHEMA_FIELD]).toBe(CAPTURE_SCHEMA_VERSION);

    // The distinction survives a round-trip through the log's own encoding —
    // the check a `/calibration-review` sweep actually performs.
    const reparsed = JSON.parse(JSON.stringify(postCapture)) as Record<string, unknown>;
    expect(hasJudgedInputCapture(reparsed)).toBe(true);
  });
});

describe("the marker is bookkeeping, not evidence", () => {
  it("does not make an otherwise evidence-free record report classifiable", () => {
    // `assessClassifiability` (mt#3610) derives evidence from every non-shared
    // key, so a marker left off its exclusion list would answer "classifiable"
    // on the strength of the marker alone — a log claiming to be reviewable
    // because it says its input was captured, while carrying none of it.
    const markerOnly = assessClassifiability([
      {
        timestamp: "2026-08-05T00:00:00.000Z",
        session_id: "s1",
        captureSchema: CAPTURE_SCHEMA_VERSION,
      } as unknown as Parameters<typeof assessClassifiability>[0][number],
    ]);
    expect(markerOnly.verdict).toBe("not-classifiable");
    expect(markerOnly.evidenceFields).toEqual([]);

    // A real capture IS evidence, and reports as such.
    const withCapture = assessClassifiability([
      {
        timestamp: "2026-08-05T00:00:00.000Z",
        session_id: "s1",
        captureSchema: CAPTURE_SCHEMA_VERSION,
        judgedPrBody: captureArtifact(BODY_LABEL_REMOVED),
      } as unknown as Parameters<typeof assessClassifiability>[0][number],
    ]);
    expect(withCapture.verdict).toBe("classifiable");
    expect(withCapture.evidenceFields).toContain("judgedPrBody");
  });
});

describe("ask-routing-deferral context capture (ask#7052)", () => {
  it("separates a real deferral from a courtesy offer that shares the phrase", () => {
    const realDeferral = "I can't settle the naming here. What's your call?";
    const courtesyOffer =
      "I shipped the fix and filed the follow-up. Want the docs too? What's your call?";

    const fromReal = detectDeferralPhrases(realDeferral);
    const fromCourtesy = detectDeferralPhrases(courtesyOffer);

    expect(fromReal.length).toBeGreaterThan(0);
    expect(fromCourtesy.length).toBeGreaterThan(0);

    // The matched phrase is identical in both — the bare record ask#7052 called
    // unratable.
    expect(fromReal[0]?.matchedPhrase).toBe(fromCourtesy[0]?.matchedPhrase);
    // The context is what tells them apart.
    expect(fromReal[0]?.context).not.toBe(fromCourtesy[0]?.context);
    expect(fromReal[0]?.context).toContain("can't settle the naming");
    expect(fromCourtesy[0]?.context).toContain("Want the docs too");
  });

  it("captures from the ELIDED text, so fenced content cannot reach the log", () => {
    const text = [
      "Here is the output:",
      "",
      "```",
      "AWS_SECRET_ACCESS_KEY=not-a-real-secret-abcdef",
      "```",
      "",
      "Which one do you want? That decision is yours.",
    ].join("\n");

    const matches = detectDeferralPhrases(text);
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m.context).not.toContain("AWS_SECRET_ACCESS_KEY");
      expect(m.context).not.toContain("not-a-real-secret");
    }
  });
});
