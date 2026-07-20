/**
 * Service-layer forcing function for `submit_finding` resolution notes (mt#2863).
 *
 * ## The defect this closes
 *
 * On a re-review round (especially chunked re-verification), the reviewer model
 * sometimes wants to acknowledge that a PRIOR round's BLOCKING finding is now
 * addressed. The prompt tells it to "acknowledge it as addressed and do not
 * re-raise it" but does not name the CHANNEL for that acknowledgment, so the
 * model emits a `submit_finding` whose SEVERITY is `BLOCKING` (reused from the
 * original finding, "to mark the thread for visibility") but whose TEXT is a
 * resolution note ("no action required — the original block is resolved in the
 * current diff"). The severity contradicts the text.
 *
 * That self-contradiction is expensive downstream: `composeReviewBody`'s
 * `reconcileEventWithBlockingCount` (mt#2655) correctly refuses to let an
 * APPROVE coexist with a BLOCKING finding and downgrades the event to
 * REQUEST_CHANGES — which also fails the `minsky-reviewer/findings` required
 * check. The result is an approved-in-substance PR blocked by its own reviewer's
 * bookkeeping, and `forceBypass` cannot clear a failing required check (only a
 * retrigger or `MINSKY_SKIP_REQUIRED_CHECKS` can) — so the bug is
 * disproportionately expensive for subagent-driven convergence.
 *
 * ## Why this lives at emission, not in the aggregator
 *
 * `reconcileEventWithBlockingCount`'s own docstring documents a deliberate
 * invariant: the aggregator NEVER downgrades a finding the model marked
 * BLOCKING, because a post-hoc severity relabel "would require the model's own
 * judgment — not available post-hoc from a deterministic aggregator." A
 * regex-on-finding-text downgrade in the aggregator is exactly the post-hoc
 * judgment that invariant refuses; adding it there would re-open the
 * silent-downgrade hole mt#2655 closed.
 *
 * This guard repairs the SAME class of incoherence but at the emission boundary
 * — the OpenAI tool-use loop in `providers.ts`, the same layer where mt#2828's
 * `conclude-review-guard.ts` rejects an incoherent `conclude_review`. It does
 * NOT substitute the aggregator's judgment for the model's: it detects that the
 * model's OWN finding text ("resolved / no action required") contradicts the
 * severity it stamped, and resolves that self-contradiction in favor of the
 * model's explicit textual disposition — first by rejecting the call so the
 * model re-emits through the correct channel, and only as a bound-exhaust
 * backstop by reclassifying the severity to NON-BLOCKING.
 *
 * ## The fix: reject at the tool-call boundary, then reclassify as backstop
 *
 * Called from the tool-use loop at the moment the model emits a `submit_finding`
 * call. When the call is `severity: "BLOCKING"` and its text is unambiguously a
 * completed-resolution disposition, the decision is `"reject"`: the caller
 * returns a corrective tool-result error naming `submit_thread_resolve` (the
 * proper channel for marking a prior thread resolved) and NON-BLOCKING as the
 * fallback, and the model — still mid-loop — can self-correct.
 *
 * After `maxRejections` (default 2) rejections for the SAME review, the guard
 * stops rejecting and returns `"reclassify"` (BLOCKING → NON-BLOCKING) so the
 * incoherent finding never reaches composition as a blocker. Reclassification is
 * the emission-layer coherence repair of last resort, not the aggregator
 * relabel the mt#2655 invariant forbids — the note is preserved in the review
 * body as NON-BLOCKING rather than dropped.
 *
 * Pure function — no I/O, no async, no model calls, no logging (the caller emits
 * structured log events; see `review-recovery-logging.ts`).
 */

import type { SubmitFindingArgs } from "./output-tools";

/**
 * Default bound on how many times a single review may reject an incoherent
 * BLOCKING resolution-note `submit_finding` call before falling through to
 * severity reclassification. Exported so `providers.ts` and tests share one
 * source of truth.
 */
export const DEFAULT_MAX_RESOLUTION_NOTE_REJECTIONS = 2;

/**
 * Corrective tool-result error returned to the model when its BLOCKING
 * resolution-note `submit_finding` call is rejected. Names the proper channel
 * (`submit_thread_resolve`) and the fallback (NON-BLOCKING) so the retry is
 * actionable in a single turn.
 */
export const RESOLUTION_NOTE_GUARD_CORRECTIVE_MESSAGE =
  "submit_finding rejected: this finding's text states the issue is already resolved / requires " +
  'no action, which is a RESOLUTION NOTE, not a blocking defect — it must not carry severity "BLOCKING". ' +
  "To acknowledge that a prior-round finding is now addressed, call " +
  "submit_thread_resolve(threadId, reason) (the proper channel for marking a prior thread resolved). " +
  'If you must record the acknowledgment as a finding, emit it with severity "NON-BLOCKING". ' +
  "Re-emit through the correct channel.";

/**
 * Matches finding text whose disposition is a COMPLETED resolution — the issue
 * is already handled and needs no action. Deliberately tight: it matches
 * past-tense / completed dispositions ("no action required", "already resolved",
 * "resolved in the current diff", "no longer applies", "fix verified") but NOT
 * imperative language that a genuine BLOCKING finding uses ("must be resolved
 * before merge", "requires action", "unresolved race condition"). The
 * regression suite in `resolution-note-guard.test.ts` pins both directions.
 */
export const RESOLUTION_NOTE_PATTERN = new RegExp(
  [
    "no (?:further )?action (?:is |was )?(?:required|needed)",
    "nothing (?:further )?(?:to (?:do|address|fix)|is (?:required|needed))",
    "(?:already|since) (?:been )?(?:resolved|addressed|fixed|handled)",
    "(?:has|have|had|is|was) (?:been |now |since been )?(?:resolved|addressed|fixed|handled) (?:in|by) " +
      "(?:the )?(?:current |latest |updated )?(?:diff|commit|fix|change|pr|pull request)",
    "(?:the )?(?:original |prior |previous |r\\d+ )?(?:block|blocking finding|finding|issue|concern) " +
      "(?:is|was|has (?:now )?been) (?:now )?(?:resolved|addressed|fixed|handled)",
    "no longer (?:applies|an issue|blocking|relevant|a concern)",
    "fix (?:verified|confirmed)",
  ].join("|"),
  "i"
);

/**
 * True when the combined finding text (summary + details) reads as a completed
 * resolution note. Both fields are checked because the model splits the
 * disposition across `summary` ("Follow-up to R1 block") and `details` ("no
 * action required — resolved in the current diff") unpredictably.
 */
export function isResolutionNoteText(summary: string, details: string): boolean {
  return RESOLUTION_NOTE_PATTERN.test(`${summary}\n${details}`);
}

export interface EvaluateSubmitFindingCallInput {
  /** The parsed, validated args of the model's `submit_finding` call. */
  args: SubmitFindingArgs;
  /**
   * How many times a BLOCKING resolution-note `submit_finding` call has already
   * been rejected this review.
   */
  rejectionCountSoFar: number;
  /** Override for {@link DEFAULT_MAX_RESOLUTION_NOTE_REJECTIONS}. Defaults when omitted. */
  maxRejections?: number;
}

export type EvaluateSubmitFindingCallResult =
  | { decision: "accept" }
  | {
      decision: "reject";
      /** Tool-result error content to return to the model for this call. */
      correctiveMessage: string;
      /** The new rejection count (rejectionCountSoFar + 1) — caller should persist this. */
      rejectionCount: number;
    }
  | {
      decision: "reclassify";
      /** The severity the caller should stamp on the finding before accumulating it. */
      newSeverity: "NON-BLOCKING";
      /** Human-readable reason, for the caller's structured log line. */
      reason: string;
    };

/**
 * Decide whether a `submit_finding` call should be accepted as-is, rejected
 * back to the model, or accepted with its severity reclassified.
 *
 * Fires ONLY on the self-contradiction: `severity === "BLOCKING"` AND the
 * finding text reads as a completed resolution note. Every other call — any
 * NON-BLOCKING or PRE-EXISTING finding, and any BLOCKING finding whose text is
 * NOT a resolution disposition (i.e. a genuine defect) — is accepted unchanged,
 * so genuine BLOCKING findings and the `minsky-reviewer/findings` check mapping
 * are unaffected (mt#2863 SC4).
 */
export function evaluateSubmitFindingCall(
  input: EvaluateSubmitFindingCallInput
): EvaluateSubmitFindingCallResult {
  const { args, rejectionCountSoFar } = input;
  const maxRejections = input.maxRejections ?? DEFAULT_MAX_RESOLUTION_NOTE_REJECTIONS;

  if (args.severity !== "BLOCKING") {
    return { decision: "accept" };
  }

  if (!isResolutionNoteText(args.summary, args.details)) {
    return { decision: "accept" };
  }

  if (rejectionCountSoFar >= maxRejections) {
    return {
      decision: "reclassify",
      newSeverity: "NON-BLOCKING",
      reason: `BLOCKING resolution-note finding after ${maxRejections} rejection(s); reclassified BLOCKING to NON-BLOCKING (emission-layer coherence repair, mt#2863)`,
    };
  }

  return {
    decision: "reject",
    correctiveMessage: RESOLUTION_NOTE_GUARD_CORRECTIVE_MESSAGE,
    rejectionCount: rejectionCountSoFar + 1,
  };
}
