// Tests for the `guard` predicate's noun/verb disambiguation (mt#3876).
//
// Its own file rather than another block in code-mechanism-assertion-detector.
// test.ts, for the same two reasons that file's artifact-surface sibling gives:
// that file is AT the 1500-line ESLint ceiling (adding this block put it at
// 1520 and the build failed), and the corpus literals here duplicate its own
// under custom/no-magic-string-duplication.
//
// The finding (2026-08-09 calibration pass): 6 of 10 injected fires matched the
// predicate `guard`/`Guard`. This corpus writes "the X guard" constantly —
// every hook, rule and task spec is in that register — and `guards?` read it as
// the mechanism claim "X guards".

import { describe, test, expect } from "bun:test";
import {
  detectCodeMechanismAssertion,
  computeSuppressionReasons,
  surfaceOnlyReasons,
} from "./code-mechanism-assertion-detector";
import type { RelayDetectionResult } from "./code-mechanism-assertion-detector";

/** A verification corpus standing in for "this turn Read `tasks_create`". */
const TASKS_CREATE_READ = "export async function tasks_create() { /* read this turn */ }";

const NO_RELAY: RelayDetectionResult = { relayed: false, relayedSymbols: [] };

describe("mt#3876 — `guard` is a noun in this corpus", () => {
  // These sentences are modeled on the (symbol, predicate) pairs the pass
  // logged. They are RECONSTRUCTIONS, not verbatim log text: 0 of 553 records
  // carry `captureSchema`, so the judged sentence is unrecoverable (mt#3649).
  // The reconstruction is faithful to the pair and to the register, which is
  // what the fix turns on; it is not evidence about the original wording, and
  // the spec's 6-of-10 figure stays `inferred` rather than `verified`.
  //
  // Each avoids every OTHER predicate pattern, so a fire can only come from
  // the `guard` rule under test.
  const NOUN_USES = [
    "the `tasks_create` guard denies the call when no duplicate-check line is present",
    "a guard that blocks `ensureHookDomainBootstrap` from running twice",
    "guard-health tracks `standalone-duplicate-matcher` streaks across sessions",
    "the deny-tier sibling guard covers `observability.calibration-review` too",
    "`DISABLE_AUTOUPDATER` — the Guard for the tray auto-update path",
    "the two guards around `registry.test.ts` are independent of each other",
  ];

  test("AT1: no noun use of `guard` produces a claim", () => {
    const fired = NOUN_USES.filter((text) => detectCodeMechanismAssertion(text, "").matched);
    expect(fired).toEqual([]);
  });

  // The tune must NARROW, not disable — a detector that stops firing is
  // indistinguishable from one that was deleted, and the verb form is the
  // whole reason the predicate exists.
  const VERB_USES = [
    "`tasks_create` guards against duplicate specs by matching signature tokens",
    "the parallel-work hook guards the merge path for `session_pr_merge`",
  ];

  test("negative control: the verb form still fires", () => {
    const missed = VERB_USES.filter((text) => !detectCodeMechanismAssertion(text, "").matched);
    expect(missed).toEqual([]);
  });

  test("the verb form is still suppressed by a same-turn read", () => {
    // The tune changes WHAT matches, never the suppression legs — this pins
    // that the narrowed predicate still flows through them.
    const result = detectCodeMechanismAssertion(VERB_USES[0] as string, TASKS_CREATE_READ);
    expect(result.matched).toBe(false);
    expect(result.hadSameTurnRead).toBe(true);
  });

  test("AT2: a genuine mechanism claim on an untouched predicate still fires", () => {
    // mt#3876 SC2 names `UserPromptSubmit`/`skips` as a probable TRUE positive
    // that a tune must not silence. It matches a different pattern entirely,
    // so this is the check that the edit stayed inside its own alternation.
    const result = detectCodeMechanismAssertion(
      "`UserPromptSubmit` skips prompts under 50 characters",
      ""
    );
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("UserPromptSubmit");
  });

  test("the sibling predicates in the old alternation are untouched", () => {
    // `enforces`/`validates`/`requires` were split away from `guard` but not
    // changed. Their noun forms are distinct words (enforcement, validation,
    // requirement), which is why they never had this collision.
    const stillFire = [
      "`sessionSchema` validates the incoming payload",
      "`requireReviewBeforeMerge` enforces the approval check",
    ];
    const missed = stillFire.filter((text) => !detectCodeMechanismAssertion(text, "").matched);
    expect(missed).toEqual([]);
  });
});

// mt#3876 SC3: "The suppression reasons enumerated above still fire at their
// current rates; this change does not touch them. A regression test pins at
// least `same-turn-read` and `artifact-surface-only`."
//
// Neither string was asserted anywhere before this task — `same-turn-read` was
// exercised only through `matched: false` at call sites, and
// `artifact-surface-only` was built inline in `run()`/`main()` where no test
// reached it. The rate half of the criterion is not checkable pre-merge
// (mt#3649: the 553 records carry no input text, so the tuned matcher cannot be
// replayed against them); it is the next calibration pass's job. What is
// checkable is that the labels are still PRODUCED, and that is what this pins.
describe("mt#3876 SC3 — suppression labels are untouched by the tune", () => {
  test("`same-turn-read` is still produced", () => {
    const result = detectCodeMechanismAssertion(
      "`tasks_create` guards against duplicate specs",
      TASKS_CREATE_READ
    );
    expect(result.hadSameTurnRead).toBe(true);

    const { reasons } = computeSuppressionReasons(result, NO_RELAY, undefined, () => true);
    expect(reasons).toContain("same-turn-read");
  });

  test("`artifact-surface-only` is still produced, and only when chat did not match", () => {
    expect(surfaceOnlyReasons(false, false, true)).toEqual(["artifact-surface-only"]);
    expect(surfaceOnlyReasons(false, true, true)).toEqual([
      "comment-surface-only",
      "artifact-surface-only",
    ]);

    // A chat match IS the injection; the non-chat surfaces are log-only riders
    // on it and must not label a record that really fired.
    expect(surfaceOnlyReasons(true, true, true)).toEqual([]);
    expect(surfaceOnlyReasons(false, false, false)).toEqual([]);
  });
});
