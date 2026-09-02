/**
 * mt#4649 — Rung 2 for operator-deferral's settled-decision suppressor.
 *
 * A sibling file rather than more of `operator-deferral-detector.test.ts`: that
 * file sits ~63 counted lines under the 1500-line `max-lines` ERROR ceiling
 * after mt#4702's split, so the next block added to it breaks the build. The
 * fixtures come from `operator-deferral-fixtures.ts`, the plain module both
 * existing test files already import.
 *
 * **What these can and cannot establish.** The nominator is injected, so these
 * pin the POST-PASS's contract — eligibility, chaining, and every degrade path —
 * without a live embedding provider. They say nothing about whether the
 * threshold separates the two populations; that is a measurement, it needs a
 * corpus, and mt#4920 owns it by the principal's decision. Naming the boundary
 * here so a later reader does not mistake green tests for a validated threshold.
 */
import { describe, expect, test } from "bun:test";
import {
  resolvePermissionSettledRung2,
  createPermissionSettledNominator,
  isPermissionRung2NominationEnabled,
  PERMISSION_RUNG2_NOMINATION_ENV_VAR,
  PERMISSION_SETTLED_RUNG2_THRESHOLD,
  SUPPRESSION_PERMISSION_SETTLED_RUNG2,
} from "./operator-deferral-detector";
import type { SettledDecisionNominator } from "./ask-routing-deferral-detector";

const PERMISSION = "permission-deferral-prose";

/** The one live conditional-mood case from the 2026-09-02 replay (see mt#4911). */
const CONDITIONAL_COMMITMENT = "I'd start with (1) unless you'd rather.";

/** A match on the surface Rung 2 governs. */
const permissionMatch = (context: string, phrase = "offer-shape:unless") =>
  ({ surface: PERMISSION, matchedPhrase: phrase, context }) as Parameters<
    typeof resolvePermissionSettledRung2
  >[0][number];

/** A match on a DIFFERENT surface — Rung 2 must never touch these. */
const otherMatch = (context: string) =>
  ({
    surface: "capability-deferral-prose",
    matchedPhrase: "requires Railway access",
    context,
  }) as Parameters<typeof resolvePermissionSettledRung2>[0][number];

/** A nominator that calls every supplied context settled. */
const alwaysSettled: SettledDecisionNominator = async () => ({ kind: "settled", score: 0.9 });

/** A nominator that never nominates. */
const neverSettled: SettledDecisionNominator = async () => ({ kind: "none" });

/** A nominator that degrades, the way an unconfigured provider does. */
const alwaysDegraded: SettledDecisionNominator = async () => ({
  kind: "degraded",
  reason: "provider-unconfigured",
});

describe("mt#4649 — the Rung-2 post-pass suppresses what Rung 1 left", () => {
  test("a nominated context drops its match", async () => {
    const result = await resolvePermissionSettledRung2(
      [
        permissionMatch(
          "I fixed it and filed mt#4844. If you'd rather that landed inline, say so."
        ),
      ],
      alwaysSettled
    );
    expect(result.remaining).toEqual([]);
    expect(result.suppressedAll).toBe(true);
    expect(result.degradedReason).toBeUndefined();
  });

  test("a context the nominator declines is left alone", async () => {
    const matches = [permissionMatch("Want me to run the dry-run gate?")];
    const result = await resolvePermissionSettledRung2(matches, neverSettled);
    expect(result.remaining).toEqual(matches);
    expect(result.suppressedAll).toBe(false);
  });

  test("suppressedAll is false when only SOME matches are dropped", async () => {
    // The nominator settles one context and not the other, so the turn still
    // fires — `suppressedAll` drives the suppression-reason record, and a
    // partially-suppressed turn has not been suppressed.
    const settle = "I'd start with (1) unless you'd rather go straight at the reviewer alerting.";
    const keep = "Want me to go ahead with that?";
    const nominator: SettledDecisionNominator = async (c) =>
      c === settle ? { kind: "settled", score: 0.9 } : { kind: "none" };

    const result = await resolvePermissionSettledRung2(
      [permissionMatch(settle), permissionMatch(keep)],
      nominator
    );
    expect(result.remaining.map((m) => m.context)).toEqual([keep]);
    expect(result.suppressedAll).toBe(false);
  });
});

describe("mt#4649 — eligibility is bounded to the surface Rung 1 governs", () => {
  test("a match on another surface is never scored, even when the nominator settles everything", async () => {
    // The negative control that matters: `isPermissionAskSuppressed`'s clauses
    // govern the permission surface only, so a Rung-2 widening of that same
    // question must not reach capability, denial, ask-justification or act-path
    // matches. A nominator that settles everything is the strongest form of the
    // test — anything it drops here would be out of scope by construction.
    const other = otherMatch("Deferred to operator: requires Railway access.");
    const result = await resolvePermissionSettledRung2([other], alwaysSettled);
    expect(result.remaining).toEqual([other]);
    expect(result.suppressedAll).toBe(false);
  });

  test("a mixed turn drops only the permission match", async () => {
    const other = otherMatch("Deferred to operator: requires Railway access.");
    const perm = permissionMatch("Proceeding with that unless you'd rather I stop.");
    const result = await resolvePermissionSettledRung2([other, perm], alwaysSettled);
    expect(result.remaining).toEqual([other]);
    expect(result.suppressedAll).toBe(false);
  });
});

describe("mt#4649 — AT4: the degraded path suppresses nothing and still injects", () => {
  test("no nominator (opt-in off) leaves every match untouched", async () => {
    const matches = [permissionMatch(CONDITIONAL_COMMITMENT)];
    const result = await resolvePermissionSettledRung2(matches, undefined);
    expect(result.remaining).toEqual(matches);
    expect(result.suppressedAll).toBe(false);
    expect(result.degradedReason).toBeUndefined();
  });

  test("a degraded nominator records the reason and suppresses nothing", async () => {
    const matches = [permissionMatch(CONDITIONAL_COMMITMENT)];
    const result = await resolvePermissionSettledRung2(matches, alwaysDegraded);
    expect(result.remaining).toEqual(matches);
    expect(result.suppressedAll).toBe(false);
    expect(result.degradedReason).toBe("provider-unconfigured");
  });

  test("a THROWING nominator degrades rather than propagating", async () => {
    // ADR-024's fail-to-Rung-1 invariant is about the hook never crashing, so a
    // throw has to land on the same path an unconfigured provider does.
    const thrower: SettledDecisionNominator = async () => {
      throw new Error("socket hang up");
    };
    const matches = [permissionMatch(CONDITIONAL_COMMITMENT)];
    const result = await resolvePermissionSettledRung2(matches, thrower);
    expect(result.remaining).toEqual(matches);
    expect(result.degradedReason).toContain("socket hang up");
  });

  test("a mid-loop degradation DISCARDS its partial verdict", async () => {
    // The ordering-independence guarantee. The nominator settles the first
    // context and then degrades; keeping that first verdict would make the
    // outcome depend on which match happened to be scored first, and this
    // surface's safe failure is to suppress nothing at all.
    const first = "I fixed it and filed mt#4844. If you'd rather that landed inline, say so.";
    const second = "Want me to go ahead with that?";
    let call = 0;
    const degradesAfterOne: SettledDecisionNominator = async () => {
      call += 1;
      return call === 1 ? { kind: "settled", score: 0.9 } : { kind: "degraded", reason: "timeout" };
    };

    const matches = [permissionMatch(first), permissionMatch(second)];
    const result = await resolvePermissionSettledRung2(matches, degradesAfterOne);
    expect(result.remaining).toEqual(matches);
    expect(result.suppressedAll).toBe(false);
    expect(result.degradedReason).toBe("timeout");
  });
});

describe("mt#4649 — the path ships inert, in two independent ways", () => {
  test("the opt-in is off by default, so no nominator is built", () => {
    const prior = process.env[PERMISSION_RUNG2_NOMINATION_ENV_VAR];
    delete process.env[PERMISSION_RUNG2_NOMINATION_ENV_VAR];
    try {
      expect(isPermissionRung2NominationEnabled()).toBe(false);
      expect(createPermissionSettledNominator()).toBeUndefined();
    } finally {
      if (prior !== undefined) process.env[PERMISSION_RUNG2_NOMINATION_ENV_VAR] = prior;
    }
  });

  test("the threshold is UNMEASURED, and NaN makes that fail-safe rather than arbitrary", () => {
    // mt#4920 owns the measurement. Until it lands, every comparison against the
    // threshold is false, so even an operator who flips the flag on suppresses
    // nothing. This test exists so that replacing NaN with a plausible-looking
    // number is a deliberate act with a red test in front of it, not a tidy-up.
    expect(Number.isNaN(PERMISSION_SETTLED_RUNG2_THRESHOLD)).toBe(true);
    expect(PERMISSION_SETTLED_RUNG2_THRESHOLD >= 0.5).toBe(false);
    expect(PERMISSION_SETTLED_RUNG2_THRESHOLD < 0.5).toBe(false);
  });

  test("the suppression reason is distinct from Rung 1's, so the two stay separable", () => {
    expect(SUPPRESSION_PERMISSION_SETTLED_RUNG2).toBe("permission-settled-decision-rung2");
    expect(SUPPRESSION_PERMISSION_SETTLED_RUNG2).not.toBe("settled-decision");
  });
});
