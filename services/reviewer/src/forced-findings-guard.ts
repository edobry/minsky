/**
 * Post-loop forced-findings pass decision function (mt#2926).
 *
 * ## The defect this closes
 *
 * `conclude-review-guard.ts` (mt#2828) rejects an incoherent
 * `conclude_review(event="REQUEST_CHANGES")` — one with zero BLOCKING
 * `submit_finding` calls — at the tool-call boundary, forcing the model to
 * supply the findings it described in prose. That guard is wired into the
 * OpenAI main-loop tool-call parse, gated on
 * `parsed.name === "conclude_review"`, and its own module doc names the two
 * paths it cannot reach. **Both of them still post a REQUEST_CHANGES verdict
 * with an empty structured findings channel:**
 *
 * 1. **The post-loop forced-conclude pass** (`forceConcludeReview` in
 *    `providers.ts`). When the main loop ends without a `conclude_review`
 *    call at all, that pass supplies one with `tool_choice` pinned to
 *    `conclude_review` — so the model emits exactly one call, to that
 *    function, and `submit_finding` is unreachable no matter how wide the
 *    `tools` array is (mt#2722 widened it to `ALL_TOOL_DEFINITIONS`; the pin
 *    is what decides). The in-loop guard never runs, because no in-loop
 *    `conclude_review` call was ever parsed.
 * 2. **The bound-exhausted fall-through.** After
 *    `DEFAULT_MAX_CONCLUDE_REVIEW_REJECTIONS` rejections for one review, the
 *    guard accepts the incoherent call (`boundExhausted: true`).
 *
 * Verified instance of path 1 (2026-09-04, review 5116536812 on PR #3623):
 * the service logged `conclude_review_reminder` with `mode:
 * "post_loop_forced"`, `fired_at_turn: 10`, `gate_branch:
 * "emitted_no_conclude"`, alongside `empty_findings_recovery_summary` with
 * `applied: true`, `concludeReviewGuardRejectionCount: 0` and
 * `concludeReviewGuardBoundExhausted: false` — the zero rejection count is
 * what rules path 2 out for that review. The conclusion prose named two
 * concrete defects, one of them a real data-loss bug the implementer
 * confirmed and fixed, so the model had findings and did not file them.
 *
 * ## The fix: one more forced pass, keyed on final state
 *
 * This module is a PURE decision function. `providers.ts` calls it once,
 * AFTER the post-loop forced passes have run, against the final accumulated
 * tool calls. When the accumulated conclusion is `REQUEST_CHANGES` and no
 * BLOCKING `submit_finding` was recorded, the caller runs a single
 * `tool_choice`-pinned `submit_finding` pass carrying the conclusion summary
 * back to the model, and appends whatever findings it returns.
 *
 * **Keyed on the final accumulated state, not on which path produced it.**
 * The two residual paths above differ in how they got here and not in what
 * they leave behind, so one predicate covers both — and the fix does not
 * depend on the path attribution above generalizing beyond the one review it
 * was measured on.
 *
 * ## What this is NOT
 *
 * - **Not a fabrication.** The trigger requires the model to have ALREADY
 *   concluded REQUEST_CHANGES. The pass asks it to structure a verdict it
 *   reached itself; it does not ask a review with nothing to report to
 *   produce something. `APPROVE` and `COMMENT` conclusions, and any
 *   `REQUEST_CHANGES` that already carries a BLOCKING finding, never trigger
 *   it.
 * - **Not a replacement for the mt#2685 recovery pass.**
 *   `empty-findings-recovery.ts` stays wired downstream as the backstop for
 *   the case where this pass errors, is refused, or returns no parseable
 *   `submit_finding`. This narrows what reaches that backstop; it does not
 *   retire it.
 * - **Not a verdict change.** The pass cannot alter the conclusion — it is
 *   pinned to `submit_finding` — which keeps the mt#2655 "never post-hoc
 *   downgrade" invariant intact.
 *
 * Pure module — no I/O, no async, no model calls, no logging (the caller
 * emits the structured log event).
 */

import type { ReviewToolCall } from "./output-tools";
import { truncateSummaryForDetails } from "./empty-findings-recovery";

export interface EvaluateForcedFindingsPassInput {
  /**
   * Every output tool call accumulated for this review, INCLUDING anything
   * the post-loop forced passes appended. This predicate is deliberately
   * evaluated on the final state — see the module doc.
   */
  accumulatedToolCalls: ReadonlyArray<ReviewToolCall>;
}

export type EvaluateForcedFindingsPassResult =
  | {
      decision: "skip";
      /**
       * Why the pass is not needed. Surfaced so the caller's log event can
       * distinguish "nothing was wrong" from "nothing was concluded",
       * which are different review shapes with the same non-action.
       */
      reason: "no-conclude-review" | "not-request-changes" | "blocking-finding-present";
    }
  | {
      decision: "run";
      /**
       * The authoritative conclusion's summary, for the caller to inject
       * into the forced pass's user message. Returned here rather than
       * re-derived by the caller so the "last conclude_review wins" rule is
       * applied in exactly one place.
       */
      conclusionSummary: string;
    };

/**
 * Decide whether the post-loop forced-findings pass should run.
 *
 * The trigger condition mirrors `applyEmptyFindingsRecovery`'s predicate
 * EXACTLY — last `conclude_review` wins, `event === "REQUEST_CHANGES"`, zero
 * BLOCKING `submit_finding` calls — so whatever this pass repairs is
 * precisely what would otherwise reach the mt#2685 synthesis. Keeping the two
 * predicates identical is what makes "this narrows the backstop's input"
 * true rather than approximate; a divergence would leave a shape that
 * triggers one and not the other.
 *
 * Deliberately keyed on BLOCKING severity specifically, matching both sibling
 * mechanisms: a REQUEST_CHANGES conclusion is incoherent only when no
 * BLOCKING evidence justifies it, and NON-BLOCKING / PRE-EXISTING findings do
 * not justify blocking a merge either.
 */
export function evaluateForcedFindingsPass(
  input: EvaluateForcedFindingsPassInput
): EvaluateForcedFindingsPassResult {
  const { accumulatedToolCalls } = input;

  const concludeCalls = accumulatedToolCalls.filter(
    (tc): tc is Extract<ReviewToolCall, { name: "conclude_review" }> =>
      tc.name === "conclude_review"
  );
  // "Last conclude_review call wins" — the same model-self-correction rule
  // composeReviewBody and applyEmptyFindingsRecovery both apply, so all three
  // agree on which conclusion is authoritative.
  const concludeCall =
    concludeCalls.length > 0 ? concludeCalls[concludeCalls.length - 1] : undefined;

  if (concludeCall === undefined) {
    return { decision: "skip", reason: "no-conclude-review" };
  }

  if (concludeCall.args.event !== "REQUEST_CHANGES") {
    return { decision: "skip", reason: "not-request-changes" };
  }

  const hasBlockingFinding = accumulatedToolCalls.some(
    (tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING"
  );

  if (hasBlockingFinding) {
    return { decision: "skip", reason: "blocking-finding-present" };
  }

  return { decision: "run", conclusionSummary: concludeCall.args.summary };
}

/**
 * What the forced pass actually did, as distinct from what was asked of it.
 *
 * `not-attempted` is NOT a variant for tidiness: `forceFindings` returns before
 * making any provider call when `SUBMIT_FINDING_TOOL_DEF` is missing, and the
 * caller cannot tell that apart from "called and got nothing back" if all it
 * receives is a count of zero.
 */
export type ForcedFindingsOutcome =
  | { kind: "not-attempted"; reason: "tool-def-missing" }
  | { kind: "attempted"; emittedCount: number }
  | { kind: "failed"; error: string };

/** The `reviewer.forced_findings_pass` fields that describe one outcome. */
export interface ForcedFindingsLogFields {
  fired: boolean;
  emittedCount: number;
  fellBackToRecoverySynth: boolean;
  skipReason?: string;
  error?: string;
}

/**
 * Map an outcome to its log fields (PR #3627 R1).
 *
 * Extracted as a pure function rather than written inline at the call site
 * because `fired` is a CLAIM, and the branch that gets it wrong is the one no
 * integration test can reach: `SUBMIT_FINDING_TOOL_DEF` is a module-level
 * constant derived from `OUTPUT_TOOL_DEFINITIONS`, so a test cannot make it
 * null without patching the module. Putting the decision here makes it
 * testable by construction, which is what `testing-standards.mdc §Testable
 * Design` asks for when the alternative is patching a collaborator the code
 * reaches itself.
 *
 * Why it matters beyond tidiness: `fired` is the numerator mt#4980 will use to
 * measure this pass's production fire rate against mt#2828's 6.1%
 * REQUEST_CHANGES-denominated baseline. Counting a disabled path as a fire
 * inflates that numerator, and — because the disabled path also emits nothing —
 * inflates the "fired and did not help" bucket specifically, which is the one
 * that would trigger a redesign.
 */
export function describeForcedFindingsOutcome(
  outcome: ForcedFindingsOutcome
): ForcedFindingsLogFields {
  switch (outcome.kind) {
    case "not-attempted":
      // No provider call happened, so this is not a fire. Reported with a
      // skip_reason so it lands in the same bucket as the predicate's skips
      // rather than in a third shape a dashboard has to learn.
      return {
        fired: false,
        emittedCount: 0,
        fellBackToRecoverySynth: true,
        skipReason: outcome.reason,
      };
    case "failed":
      return { fired: true, emittedCount: 0, fellBackToRecoverySynth: true, error: outcome.error };
    case "attempted":
      return {
        fired: true,
        emittedCount: outcome.emittedCount,
        fellBackToRecoverySynth: outcome.emittedCount === 0,
      };
  }
}

/**
 * Build the user message injected before the forced `submit_finding` pass.
 *
 * Mirrors `DOC_IMPACT_REMINDER_USER_MSG`'s shape in `providers.ts`: name the
 * tool, name its required argument shape, and state the constraint the pinned
 * `tool_choice` imposes (no file reads on this call), so the model reports
 * from what it already read rather than asserting a location it never
 * checked.
 *
 * The summary is bounded by {@link truncateSummaryForDetails} — the same cap
 * the mt#2685 synthesis applies to the same unbounded model output
 * (`ConcludeReviewArgsSchema.summary` has no `max()`), reused rather than
 * duplicated so the two paths cannot drift to different budgets.
 */
export function buildForcedFindingsUserMessage(conclusionSummary: string): string {
  return (
    'Your review is incoherent as it stands: you concluded `event="REQUEST_CHANGES"` but ' +
    'emitted no `submit_finding` call with `severity="BLOCKING"`, so the structured findings ' +
    "channel is empty and the issues you described exist only as prose. Emit a `submit_finding` " +
    "call for each blocking issue named in your conclusion below.\n\n" +
    'Each call takes: `severity` (use "BLOCKING" for an issue that must be fixed before merge), ' +
    "`file` (repo-relative path), `line` (1-based, the new-file line number for an addition), " +
    "optional `lineEnd` and `side`, `summary` (one sentence), and `details` (the rationale and " +
    "suggested fix).\n\n" +
    "You cannot read files on this call. Anchor each finding to a file and line you actually " +
    "read during the review — do NOT invent a location to satisfy the schema. If an issue is " +
    "genuinely not locatable in the diff, anchor it to the file it concerns and say so in " +
    "`details`.\n\n" +
    `Your conclusion summary was:\n\n${truncateSummaryForDetails(conclusionSummary)}`
  );
}
