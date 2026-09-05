/**
 * mt#3866 — every writer that CLAIMS capture also carries an identity.
 *
 * PR #3656 R2 (BLOCKING) read SC1's *"every calibration record carries an
 * identifier"* against a change that adopted one writer, and was right to. This
 * test is what makes the answer checkable instead of a claim in a spec.
 *
 * ## The population, and why it is this one
 *
 * `captureSchema` announces "this record's judged text can be re-read". Before
 * mt#3866 a writer could announce that and carry no way to tell its records
 * apart, because the two capture helpers differ: `extractMatchContext` returns a
 * bounded STRING, `captureArtifact` returns `{excerpt, hash}`. `captureFields`
 * removes the choice by stamping both.
 *
 * So the invariant worth pinning is not "every stream has a digest" — that is a
 * ~50-writer adoption campaign, and it belongs to mt#4001. It is the narrower,
 * decidable one: **no writer stamps the marker by hand any more.** A hand-rolled
 * `[CAPTURE_SCHEMA_FIELD]: CAPTURE_SCHEMA_VERSION` is exactly the shape that
 * produced the defect, and it is the shape a future writer would copy from a
 * neighbour.
 *
 * ## Why a source scan rather than a runtime assertion
 *
 * The property is about how a record is BUILT, and the builders sit behind
 * different entry points with different inputs — some need a transcript, some a
 * PR body, some a merge payload. Constructing all of them to inspect one field
 * would test the harness. The written form is what a new writer copies, so the
 * written form is what this guards.
 */
/* eslint-disable custom/no-real-fs-in-tests -- this test's whole subject is the
 * REAL `.minsky/hooks/` tree. An in-memory fake would assert the invariant
 * against a fixture whose contents this file chose, and the failure mode being
 * guarded is "somebody adds a NEW writer that stamps the marker by hand" — a
 * writer a mock tree cannot contain. Same justification as
 * `hook-module-inventory.test.ts` and `self-containment.test.ts`. */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOOKS_DIR = import.meta.dir;

/** A writer stamping the capture marker by hand. */
const HAND_ROLLED = /\[\s*CAPTURE_SCHEMA_FIELD\s*\]\s*:\s*CAPTURE_SCHEMA_VERSION/;

/**
 * Any way a writer supplies an identity: the coupled helper, or its own digest.
 *
 * A first cut of this test asserted that NO writer hand-rolls the marker, and
 * it failed — correctly, and for a reason worth keeping. Six writers stamp the
 * marker by hand AND carry their own digest (`captureArtifact` for an artifact
 * surface, `judged_text_hash` for `retrospective-trigger`). Routing those
 * through `captureFields` would add a SECOND digest field beside the one they
 * already write. The defect was never the hand-rolled marker; it was a marker
 * with no identity anywhere in the record.
 */
const HAS_IDENTITY = /captureFields\(|captureArtifact\(|hashJudgedText\(|judged_text_hash/;

/**
 * `judged-input-capture.ts` DEFINES both constants and is where the coupled
 * helper spells the pair — the one legitimate site, excluded by name rather
 * than by a pattern that could accidentally widen.
 */
const DEFINITION_MODULE = "judged-input-capture.ts";

function hookSources(): string[] {
  return readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== DEFINITION_MODULE)
    .sort();
}

describe("mt#3866 — the capture marker is never stamped without an identity", () => {
  test("a writer that claims capture always carries an identity too", () => {
    const offenders = hookSources().filter((f) => {
      const src = readFileSync(join(HOOKS_DIR, f), "utf-8");
      return HAND_ROLLED.test(src) && !HAS_IDENTITY.test(src);
    });

    // Named rather than counted, so a failure says WHICH writer to fix. The
    // three adopted at mt#3866 were `ask-routing-deferral-detector`,
    // `operator-deferral-detector` and `pre-narration-detector` — the complete
    // set that claimed capture with no identity anywhere in the record.
    expect(offenders).toEqual([]);
  });

  test("the claim-capture population is non-empty — the assertion has something to check", () => {
    // Without this, deleting every marker would make the test above pass while
    // the invariant became untestable. This is the denominator.
    //
    // PR #3656 R3 (non-blocking): the bound was `>= 9`, the population size when
    // this landed. That number is a census, and a census in an assertion goes
    // stale the first time a writer is added or retired — failing for a reason
    // that has nothing to do with the invariant. The floor is now the three
    // writers mt#3866 adopted, which cannot drop without the adoption being
    // reverted, and that is exactly what a vacuity guard needs to catch.
    const claimants = hookSources().filter((f) => {
      const src = readFileSync(join(HOOKS_DIR, f), "utf-8");
      return HAND_ROLLED.test(src) || /captureFields\(/.test(src);
    });
    expect(claimants.length).toBeGreaterThanOrEqual(3);
  });

  test("the three writers mt#3866 adopted still go through captureFields", () => {
    // The named floor behind the count above. A census cannot say WHICH writers
    // matter; these three are the ones that carried the defect, so they are the
    // ones whose regression would be silent.
    const adopted = [
      "ask-routing-deferral-detector.ts",
      "operator-deferral-detector.ts",
      "pre-narration-detector.ts",
    ];
    for (const f of adopted) {
      const src = readFileSync(join(HOOKS_DIR, f), "utf-8");
      expect({ file: f, coupled: /\.\.\.captureFields\(/.test(src) }).toEqual({
        file: f,
        coupled: true,
      });
    }
  });

  test("the scan can actually find the pattern — otherwise the assertion above is vacuous", () => {
    // mem#704: a probe whose result is the same whether or not the thing is
    // present carries no information. If a rename made `HAND_ROLLED` unmatchable
    // the test above would pass forever while the invariant rotted.
    expect(HAND_ROLLED.test("  [CAPTURE_SCHEMA_FIELD]: CAPTURE_SCHEMA_VERSION,")).toBe(true);
    expect(HAND_ROLLED.test("  ...captureFields(assistantText),")).toBe(false);
    expect(HAS_IDENTITY.test("  ...captureFields(assistantText),")).toBe(true);
    expect(HAS_IDENTITY.test("  judged_text_hash: capture.judgedTextHash,")).toBe(true);
    expect(HAS_IDENTITY.test("  matches: [], suppressionReasons: [],")).toBe(false);
  });

  test("the scan reads a non-trivial number of hook sources", () => {
    // The other way this could go vacuous: a glob that matches nothing. A
    // filter typo would yield an empty offender list for the wrong reason.
    expect(hookSources().length).toBeGreaterThan(50);
  });
});
