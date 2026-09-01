/**
 * mt#4830 AT1 + AT2 — the labeled fixtures the citation-scope matcher is measured against.
 *
 * AT1 is the discriminating case and the reason this axis looked tractable at all: five success
 * criteria from ONE PR body (mt#4804 / PR #3517), of which exactly one carries the defect. The
 * text is verbatim from the merged body, not paraphrased — a paraphrase would be a fixture for a
 * claim nobody actually made.
 *
 * AT2 is the recall probe, and the spec predicts it FAILS: mem#1087's four instances are
 * symbol-free, and a matcher keyed on a citation cannot see a claim that cites nothing. The
 * spec's instruction is explicit — "record the result rather than tuning to force it" — so these
 * assert the miss rather than working around it.
 */

import { describe, expect, test } from "bun:test";
import { findCitationScopeMatches, tallyByLayer } from "./citation-scope-matcher";

/**
 * Verbatim from PR #3517's body, `## Success criteria` section. SC3 is the defect: its citation
 * is true in every checkable part and its conclusion is about a different module.
 */
const AT1_SC1 = "- **SC1** — met. All 27 declared with guard names.";

const AT1_SC2 = "- **SC2** — met. See the evidence block.";

const AT1_SC3 = [
  "- **SC3** — met by construction, confirmed post-merge. Registering **is** the backfill:",
  "  `ingest-service.ts` reads `hwm[source.stream]?.byteOffset`, `undefined` for a new stream, so it",
  '  reads from offset 0. Authorized by ask#11117 ("Ingest the 5 too").',
].join("\n");

const AT1_SC4 = [
  "- **SC4** — met. Inventory §I. §A/§B are dated 2026-08-12 snapshots and were left intact rather",
  "  than retro-edited.",
].join("\n");

const AT1_SC5 = [
  "- **SC5** — met vacuously, and checked rather than assumed: `RETIRED_CALIBRATION_PRODUCERS` holds",
  "  only `policy-coverage`, already declared and already in the manifest. None of the 27 has a",
  "  retired producer.",
].join("\n");

describe("AT1 — mt#4804 / PR #3517 success criteria", () => {
  test("SC3 is classified positive at the L2 subject-drift layer or deeper", () => {
    const matches = findCitationScopeMatches(AT1_SC3);
    expect(matches.length).toBeGreaterThan(0);

    const deepest = matches.some((m) => m.layer === "L2" || m.layer === "L3");
    expect(deepest).toBe(true);

    // The structure the axis is named for: a real cited symbol, a licensing connective, and a
    // scope assertion whose subject is none of the cited symbols.
    const drifting = matches.flatMap((m) => m.scopeAssertions).filter((a) => a.subjectDrifts);
    expect(drifting.length).toBeGreaterThan(0);
    expect(matches.flatMap((m) => m.citedSymbols)).toContain("ingest-service.ts");
  });

  test.each([
    ["SC1", AT1_SC1],
    ["SC2", AT1_SC2],
    ["SC4", AT1_SC4],
    ["SC5", AT1_SC5],
  ])("%s is classified negative — no L2/L3 match", (_label, body) => {
    const matches = findCitationScopeMatches(body);
    const flagged = matches.filter((m) => m.layer === "L2" || m.layer === "L3");
    expect(flagged).toEqual([]);
  });

  test("SC1's totality claim alone does not fire — a scope marker needs a citation", () => {
    // "All 27 declared with guard names" carries the totality marker and no code citation. This
    // is the discriminator that keeps the matcher from being a totality-word detector.
    const matches = findCitationScopeMatches(AT1_SC1);
    expect(tallyByLayer(matches).L1).toBe(0);
  });
});

/**
 * mem#1087's four instances (2026-08-18). Every one is symbol-free — the property that made them
 * mt#3726's class rather than this one.
 */
const AT2_INSTANCES: readonly (readonly [string, string])[] = [
  ["stale-daemons", "Two of the three cockpit daemons are stale, so the port record is wrong."],
  ["deploy-impact", "This is not a deploy-surface change, so no deploy verification is needed."],
  [
    "severity-ranking",
    "Silent message loss is the worst consequence here, therefore it ranks first.",
  ],
  ["one-line-migration", "This is arguably a one-line migration, so the risk is minimal."],
];

describe("AT2 — mem#1087's symbol-free instances", () => {
  test.each(AT2_INSTANCES)(
    "%s is NOT caught — recorded as a measured miss, not tuned around",
    (_label, prose) => {
      const matches = findCitationScopeMatches(prose);
      // A citation-keyed matcher cannot see a claim that cites nothing. mt#4830 AT2 asks for this
      // result to be RECORDED; mt#3726 closed the symbol-free axis and this is not that axis.
      expect(matches).toEqual([]);
    }
  );
});

describe("claim-window splitting", () => {
  test("a filename's dot is not a sentence boundary", () => {
    const matches = findCitationScopeMatches(
      "The reader `ingest-service.ts` resolves the path, so every stream lands in the state dir."
    );
    expect(matches.length).toBe(1);
    expect(matches[0]?.citedSymbols).toContain("ingest-service.ts");
  });

  test("a fenced block is elided, so pasted output cannot manufacture a match", () => {
    const withFence = [
      "Here is the run:",
      "",
      "```",
      "`resolveStreamPath` returns the state dir, so all 27 streams are covered.",
      "```",
      "",
    ].join("\n");
    expect(findCitationScopeMatches(withFence)).toEqual([]);
  });

  test("separate sentences are separate windows", () => {
    const twoSentences =
      "The module `ingest-service.ts` reads an offset. All 27 streams are covered by construction.";
    // The citation and the totality claim are in DIFFERENT windows, so the join this matcher is
    // about is absent — a deliberate negative, since the axis is the join and not co-occurrence.
    const flagged = findCitationScopeMatches(twoSentences).filter(
      (m) => m.layer === "L2" || m.layer === "L3"
    );
    expect(flagged).toEqual([]);
  });
});
