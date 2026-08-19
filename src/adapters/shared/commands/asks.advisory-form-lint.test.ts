/**
 * AT4 (mt#4315) — the advisory form-lint checks never reach the hard-reject set.
 *
 * `filterBlockingFormLintMatches` is what decides whether an `asks.create` is
 * REFUSED or merely warned. Four checks are advisory by deliberate choice, each
 * for a reason recorded at its exclusion in `asks.ts`; the shared shape is that
 * none of them states a condition the author can mechanically satisfy, so
 * blocking would train rewording rather than rethinking.
 *
 * `asserted-not-self-resolving` is the one this file was added for, and its
 * failure direction is the sharpest: it guesses about someone else's
 * infrastructure, so a hard-reject would let a wrong guess withhold a real
 * incident page from the principal. Asserted alongside its three siblings so a
 * future exclusion cannot be dropped silently.
 */
import { describe, test, expect } from "bun:test";
import { filterBlockingFormLintMatches } from "./asks";
import type { FormLintCheck, FormLintMatch } from "@minsky/domain/ask/form-lint";

const ADVISORY: readonly FormLintCheck[] = [
  "missing-force-immediate",
  "unlinkified-reference",
  "unscoped-option-exception",
  "duplicate-open-incident",
  "asserted-not-self-resolving",
];

/** A check that MUST block — the liveness control for the assertions below. */
const BLOCKING: FormLintCheck = "over-word-budget";

const match = (check: FormLintCheck): FormLintMatch => ({ check, message: "…" });

describe("advisory form-lint checks are excluded from the blocking set", () => {
  for (const check of ADVISORY) {
    test(`${check} alone does not block a create`, () => {
      expect(filterBlockingFormLintMatches([match(check)])).toEqual([]);
    });
  }

  test("liveness: a genuinely blocking check DOES survive the filter", () => {
    // Without this, every assertion above would pass against a filter that
    // dropped everything — including the checks that must hard-reject.
    expect(filterBlockingFormLintMatches([match(BLOCKING)]).map((m) => m.check)).toEqual([
      BLOCKING,
    ]);
  });

  test("advisory checks do not suppress a blocking one alongside them", () => {
    const blocking = filterBlockingFormLintMatches([...ADVISORY.map(match), match(BLOCKING)]);
    expect(blocking.map((m) => m.check)).toEqual([BLOCKING]);
  });
});
