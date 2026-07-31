/**
 * `validateFormLintNotViolated` — form-lint hard-reject at the `asks.create`
 * boundary (mt#3326).
 *
 * Split out of `./asks.test.ts` (already at its max-lines ceiling), mirroring
 * the existing split for `./asks.form-lint-options.test.ts`.
 *
 * Scope: this file tests the BOUNDARY function directly (mirroring how
 * `validateAuthorizationApproveOptions` is tested in `asks.test.ts`) — it
 * does not exercise the full registered `asks.create` command through
 * `sharedCommandRegistry`, since none of the sibling `validate`-hook checks
 * are tested that way either. `asks.test.ts`'s `createAskWithFormLint`
 * block (and `./asks.form-lint-options.test.ts`) already cover that the
 * LOWER-level `createAskWithFormLint` wrapper stays unconditionally
 * non-blocking — this file covers the layer ABOVE it that mt#3326 added.
 *
 * Evidence base for "all five checks are blocking, not just the two the
 * retro named": `.minsky/ask-form-lint-calibration.jsonl` shows every one of
 * internal-tool-id / over-word-budget / portal-no-link / long-option-label /
 * letter-prefixed-option-label firing at least once in production.
 */
import { describe, expect, test } from "bun:test";
import { ValidationError } from "@minsky/domain/errors/index";
import { OPTION_LABEL_BUDGET } from "@minsky/shared/ask-option-label";
import { filterBlockingFormLintMatches, validateFormLintNotViolated } from "./asks";

const KIND_DIRECTION_DECIDE = "direction.decide" as const;
const KIND_AUTHORIZATION_APPROVE = "authorization.approve" as const;

const CHECK_INTERNAL_TOOL_ID = "internal-tool-id" as const;
const CHECK_MISSING_FORCE_IMMEDIATE = "missing-force-immediate" as const;
const CHECK_MISSING_DECISION_OPTIONS = "missing-decision-options" as const;

const WELL_FORMED_QUESTION =
  "Pick the replacement mechanism for boot-time auto-migrate. Two options below.";

/** A decision-shaped ask needs these to pass mt#3477's presence check. */
const WELL_FORMED_OPTIONS = [
  { label: "GitHub Actions migrate-on-merge" },
  { label: "Railway pre-deploy command" },
];

describe("validateFormLintNotViolated (mt#3326)", () => {
  test("well-formed question and well-formed options -> does not throw", () => {
    expect(() =>
      validateFormLintNotViolated({
        kind: KIND_DIRECTION_DECIDE,
        question: WELL_FORMED_QUESTION,
        options: WELL_FORMED_OPTIONS,
      })
    ).not.toThrow();
  });

  test("well-formed question and no options -> does not throw for a kind that renders its own buttons", () => {
    // authorization.approve is answerable without options (the surface
    // renders Approve/Deny), so mt#3477's check does not apply to it.
    expect(() =>
      validateFormLintNotViolated({
        kind: KIND_AUTHORIZATION_APPROVE,
        question: WELL_FORMED_QUESTION,
      })
    ).not.toThrow();
  });

  test("over-word-budget question -> throws ValidationError naming the check", () => {
    const question = Array.from({ length: 160 }, () => "word").join(" ");
    expect(() => validateFormLintNotViolated({ kind: KIND_DIRECTION_DECIDE, question })).toThrow(
      ValidationError
    );

    try {
      validateFormLintNotViolated({ kind: KIND_DIRECTION_DECIDE, question });
      throw new Error("expected validateFormLintNotViolated to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const message = (err as Error).message;
      expect(message).toContain("over-word-budget");
      expect(message).toContain("mt#3326");
      expect(message).toContain("acknowledgeFormWarnings");
    }
  });

  test("internal-tool-id + portal-no-link both fire -> throws listing both", () => {
    const question =
      "I'll run mcp__minsky__setup_github-app to update the app settings and grant this " +
      "permission — no link included here.";
    try {
      validateFormLintNotViolated({ kind: KIND_AUTHORIZATION_APPROVE, question });
      throw new Error("expected validateFormLintNotViolated to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const message = (err as Error).message;
      expect(message).toContain("internal-tool-id");
      expect(message).toContain("portal-no-link");
      expect(message).toContain("2 form-lint violations");
    }
  });

  test("long-option-label -> throws (evidence: fired 2026-07-28/29 in the calibration log)", () => {
    const longLabel = "x".repeat(OPTION_LABEL_BUDGET + 10);
    expect(() =>
      validateFormLintNotViolated({
        kind: KIND_DIRECTION_DECIDE,
        question: WELL_FORMED_QUESTION,
        options: [{ label: longLabel }, { label: "Keep the current mechanism" }],
      })
    ).toThrow(ValidationError);
  });

  test("letter-prefixed-option-label -> throws (not left advisory-only)", () => {
    expect(() =>
      validateFormLintNotViolated({
        kind: KIND_DIRECTION_DECIDE,
        question: WELL_FORMED_QUESTION,
        options: [{ label: "A — do the thing" }, { label: "B — do the other thing" }],
      })
    ).toThrow(ValidationError);
  });

  test("acknowledgeFormWarnings: true bypasses the reject even with violations present", () => {
    const question = Array.from({ length: 160 }, () => "word").join(" ");
    expect(() =>
      validateFormLintNotViolated({
        kind: KIND_DIRECTION_DECIDE,
        question,
        acknowledgeFormWarnings: true,
      })
    ).not.toThrow();
  });

  test("missing kind or question does not throw here — required-field validation owns that", () => {
    expect(() => validateFormLintNotViolated({ question: WELL_FORMED_QUESTION })).not.toThrow();
    expect(() => validateFormLintNotViolated({ kind: KIND_DIRECTION_DECIDE })).not.toThrow();
    expect(() => validateFormLintNotViolated({})).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // missing-force-immediate (mt#3436) — deliberately NOT part of this
  // hard-reject boundary. Calibration-first: it warns via the calibration
  // log (asks.ts's execute handler), never here.
  // -------------------------------------------------------------------------

  test("missing-force-immediate alone does not throw (calibration-first, not blocking)", () => {
    expect(() =>
      validateFormLintNotViolated({
        kind: KIND_AUTHORIZATION_APPROVE,
        question: "The service is down and returning 429 errors in production.",
        forceImmediate: false,
      })
    ).not.toThrow();
  });

  test("setting forceImmediate: true also does not throw (no violation at all)", () => {
    expect(() =>
      validateFormLintNotViolated({
        kind: KIND_AUTHORIZATION_APPROVE,
        question: "The service is down and returning 429 errors in production.",
        forceImmediate: true,
      })
    ).not.toThrow();
  });

  test("filterBlockingFormLintMatches drops ONLY missing-force-immediate (PR #2472 R1)", () => {
    // Regression for the R1 finding: an `acknowledged` calibration-log field
    // must never be computed from the raw acknowledgeFormWarnings flag
    // alone — it has to gate on whether a BLOCKING match was actually
    // present. This is the shared helper both validateFormLintNotViolated
    // and the asks.create execute handler now use to decide that.
    const onlyAdvisory = filterBlockingFormLintMatches([
      { check: CHECK_MISSING_FORCE_IMMEDIATE, message: "m" },
    ]);
    expect(onlyAdvisory).toEqual([]);

    const mixed = filterBlockingFormLintMatches([
      { check: CHECK_INTERNAL_TOOL_ID, message: "m1" },
      { check: CHECK_MISSING_FORCE_IMMEDIATE, message: "m2" },
    ]);
    expect(mixed.map((m) => m.check)).toEqual([CHECK_INTERNAL_TOOL_ID]);

    const noMatches = filterBlockingFormLintMatches([]);
    expect(noMatches).toEqual([]);
  });

  test("missing-force-immediate does not count toward the blocking violation total", () => {
    // internal-tool-id (blocking) + missing-force-immediate (advisory) both
    // fire; only the blocking one should surface in the thrown message.
    const question =
      "I'll run mcp__minsky__setup_github-app — production is down and returning 429s.";
    try {
      validateFormLintNotViolated({ kind: KIND_AUTHORIZATION_APPROVE, question });
      throw new Error("expected validateFormLintNotViolated to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const message = (err as Error).message;
      expect(message).toContain(CHECK_INTERNAL_TOOL_ID);
      expect(message).toContain("1 form-lint violation");
      expect(message).not.toContain(CHECK_MISSING_FORCE_IMMEDIATE);
    }
  });

  // -------------------------------------------------------------------------
  // missing-decision-options (mt#3477) — blocking from the start, unlike the
  // mt#3436 check above. It is the one check admitted straight to this
  // boundary: it has no false-positive class (an optionless direction.decide
  // renders zero buttons by construction), and the family's own escalation
  // threshold (mem#760) was already met.
  // -------------------------------------------------------------------------

  test("direction.decide with absent options -> throws ValidationError naming the check", () => {
    try {
      validateFormLintNotViolated({
        kind: KIND_DIRECTION_DECIDE,
        question: WELL_FORMED_QUESTION,
      });
      throw new Error("expected validateFormLintNotViolated to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const message = (err as Error).message;
      expect(message).toContain(CHECK_MISSING_DECISION_OPTIONS);
      expect(message).toContain("options array");
    }
  });

  test("direction.decide with an EMPTY options array -> also throws", () => {
    expect(() =>
      validateFormLintNotViolated({
        kind: KIND_DIRECTION_DECIDE,
        question: WELL_FORMED_QUESTION,
        options: [],
      })
    ).toThrow(ValidationError);
  });

  test("acknowledgeFormWarnings: true lets an optionless direction.decide through", () => {
    expect(() =>
      validateFormLintNotViolated({
        kind: KIND_DIRECTION_DECIDE,
        question: WELL_FORMED_QUESTION,
        acknowledgeFormWarnings: true,
      })
    ).not.toThrow();
  });

  test("filterBlockingFormLintMatches KEEPS missing-decision-options", () => {
    const kept = filterBlockingFormLintMatches([
      { check: CHECK_MISSING_DECISION_OPTIONS, message: "m" },
      { check: CHECK_MISSING_FORCE_IMMEDIATE, message: "m2" },
    ]);
    expect(kept.map((m) => m.check)).toEqual([CHECK_MISSING_DECISION_OPTIONS]);
  });
});
