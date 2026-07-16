/**
 * Service-layer forcing function for `conclude_review` (mt#2828).
 *
 * ## The defect this closes
 *
 * The reviewer model frequently calls `conclude_review(event="REQUEST_CHANGES")`
 * with a prose summary that names concrete blocking issues, but emits ZERO
 * `submit_finding` calls. Prior to this module, that incoherent call was
 * accepted unconditionally by the OpenAI tool-use loop (`providers.ts`) — the
 * structured findings channel silently stayed empty, and the mt#2685
 * "empty-findings coherence recovery pass" (`empty-findings-recovery.ts`) had
 * to synthesize a placeholder finding from the summary AFTER the fact to keep
 * every structured-channel consumer (provenance, the merge gate, the trimmed
 * findings array) coherent. Measured over conversation aa877277 (2026-07-10
 * through 07-13), this fired on roughly half of review rounds — a mitigation
 * firing at that rate is load-bearing, which per `Work Completion §Temporary
 * mechanism budget` means the "recovery" framing has failed: it was doing the
 * job of the missing structured findings, not backstopping an edge case.
 *
 * ## The fix: reject at the tool-call boundary, not after the fact
 *
 * This module is a PURE decision function, called from the OpenAI tool-use
 * loop (`providers.ts`) at the moment the model emits a `conclude_review`
 * call. When the call is `event: "REQUEST_CHANGES"` and no `submit_finding`
 * call with `severity: "BLOCKING"` has been recorded yet, the decision is
 * `"reject"`: the caller returns a corrective tool-result error instead of a
 * success envelope, and the model — still mid-loop, with `submit_finding`
 * available — can self-correct by emitting the findings it already described
 * in prose, then re-calling `conclude_review`. This is a genuine forcing
 * function (the model cannot proceed past an incoherent conclusion without
 * either supplying findings or exhausting the bound), not prose exhortation
 * (the existing prompt instructions in `prompt.ts` already asked nicely and
 * that was insufficient — see the incident evidence above).
 *
 * ## Bounded retries, then fall through to the mt#2685 backstop
 *
 * Rejecting indefinitely risks burning the tool-loop's `MAX_TOOL_ROUNDS`
 * budget on a model that is stuck (e.g., genuinely has no locatable file/line
 * for its concern). After `maxRejections` (default 2) rejections for the SAME
 * review, the guard accepts the call (`decision: "accept", boundExhausted:
 * true`) so the loop can terminate normally. The mt#2685 recovery pass
 * remains wired downstream as the backstop for this residual case AND for
 * the post-loop forced-conclude-review pass (`forceConcludeReview` in
 * `providers.ts`), which this guard does NOT cover — that pass constrains the
 * model via `tool_choice` to emit ONLY `conclude_review`, so there is no
 * `submit_finding` call for the model to make in response to a rejection;
 * the pre-existing recovery-pass backstop is the correct (only) mechanism for
 * that narrower path.
 *
 * Pure function — no I/O, no async, no model calls, no logging (the caller
 * emits structured log events; see `review-recovery-logging.ts`).
 */

import type { ConcludeReviewArgs, ReviewToolCall } from "./output-tools";

/**
 * Default bound on how many times a single review may reject an incoherent
 * `conclude_review(REQUEST_CHANGES)` call before falling through to the
 * mt#2685 recovery pass as backstop. Exported so `providers.ts` and tests
 * share one source of truth.
 */
export const DEFAULT_MAX_CONCLUDE_REVIEW_REJECTIONS = 2;

/**
 * Corrective tool-result error message returned to the model when its
 * `conclude_review(REQUEST_CHANGES)` call is rejected. Written to be
 * actionable in a single retry: names the exact tool + args shape needed and
 * the exact next step (re-call `conclude_review`).
 */
export const CONCLUDE_REVIEW_GUARD_CORRECTIVE_MESSAGE =
  'conclude_review rejected: event="REQUEST_CHANGES" requires at least one BLOCKING ' +
  "submit_finding call recorded first — the structured findings channel cannot be empty " +
  'when concluding REQUEST_CHANGES. Call submit_finding(severity="BLOCKING", file, line, ' +
  "summary, details) for each blocking issue you described, THEN call conclude_review again.";

export interface EvaluateConcludeReviewCallInput {
  /** The parsed, validated args of the model's `conclude_review` call. */
  args: ConcludeReviewArgs;
  /**
   * All output tool calls accumulated so far in this review (across every
   * tool-loop round up to and including any earlier tool calls in the SAME
   * round, but NOT including the `conclude_review` call under evaluation).
   */
  accumulatedToolCalls: ReadonlyArray<ReviewToolCall>;
  /** How many times a `conclude_review(REQUEST_CHANGES)` call has already been rejected this review. */
  rejectionCountSoFar: number;
  /** Override for {@link DEFAULT_MAX_CONCLUDE_REVIEW_REJECTIONS}. Defaults when omitted. */
  maxRejections?: number;
}

export type EvaluateConcludeReviewCallResult =
  | {
      decision: "accept";
      /**
       * True when this call was incoherent (REQUEST_CHANGES + zero BLOCKING
       * findings) but the rejection bound was already exhausted, so the guard
       * let it through for the mt#2685 recovery pass to handle downstream.
       * False for every ordinarily-coherent call (APPROVE, COMMENT, or a
       * REQUEST_CHANGES with BLOCKING findings already recorded).
       */
      boundExhausted: boolean;
    }
  | {
      decision: "reject";
      /** Tool-result error content to return to the model for this call. */
      correctiveMessage: string;
      /** The new rejection count (rejectionCountSoFar + 1) — caller should persist this. */
      rejectionCount: number;
    };

/**
 * Decide whether a `conclude_review` call should be accepted or rejected
 * back to the model.
 *
 * Trigger condition mirrors `empty-findings-recovery.ts`'s own predicate
 * exactly (`event === "REQUEST_CHANGES"` AND zero BLOCKING `submit_finding`
 * calls) so whatever this guard blocks is precisely the condition that would
 * otherwise require recovery — the two mechanisms target the identical
 * incoherence, one pre-emptively (this guard) and one as a backstop
 * (mt#2685). Deliberately keyed on BLOCKING severity specifically (not "any
 * submit_finding call") — a REQUEST_CHANGES conclusion is only incoherent
 * when there is no BLOCKING evidence to justify it; NON-BLOCKING/PRE-EXISTING
 * findings alone don't justify blocking the merge either, so they don't
 * satisfy the check.
 *
 * APPROVE and COMMENT conclusions are never rejected, regardless of finding
 * count — an APPROVE (or COMMENT) with zero findings is a legitimate shape
 * (nothing to report), not an incoherence. See the acceptance test in
 * `conclude-review-guard.test.ts` for the explicit regression coverage.
 */
export function evaluateConcludeReviewCall(
  input: EvaluateConcludeReviewCallInput
): EvaluateConcludeReviewCallResult {
  const { args, accumulatedToolCalls, rejectionCountSoFar } = input;
  const maxRejections = input.maxRejections ?? DEFAULT_MAX_CONCLUDE_REVIEW_REJECTIONS;

  if (args.event !== "REQUEST_CHANGES") {
    return { decision: "accept", boundExhausted: false };
  }

  const hasBlockingFinding = accumulatedToolCalls.some(
    (tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING"
  );

  if (hasBlockingFinding) {
    return { decision: "accept", boundExhausted: false };
  }

  if (rejectionCountSoFar >= maxRejections) {
    // Bound exhausted: accept and let the mt#2685 empty-findings recovery
    // pass synthesize a placeholder finding downstream (backstop).
    return { decision: "accept", boundExhausted: true };
  }

  return {
    decision: "reject",
    correctiveMessage: CONCLUDE_REVIEW_GUARD_CORRECTIVE_MESSAGE,
    rejectionCount: rejectionCountSoFar + 1,
  };
}
