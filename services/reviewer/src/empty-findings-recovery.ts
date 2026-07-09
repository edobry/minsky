/**
 * Empty-findings coherence recovery (mt#2685).
 *
 * Pure post-process pass over the model's raw tool calls that detects the
 * "REQUEST_CHANGES with zero structured findings" incoherence and repairs it
 * by synthesizing a single BLOCKING `submit_finding` from the `conclude_review`
 * summary.
 *
 * ## The defect
 *
 * Observed 2026-07-08 on PR #1832 (review 4650962079) and PR #1837 (review
 * 4651474893), and again 2026-07-08/09 on PR #1850 (review 4657981679) and
 * PR #1858 (review 4658038353): the reviewer model calls `conclude_review`
 * with `event: "REQUEST_CHANGES"` and a summary that names one or more
 * concrete blocking issues in prose, but emits ZERO `submit_finding` calls.
 * `composeReviewBody` renders no `## Findings` section (nothing to render),
 * and `extractProvenance` records `findings: { blocking: 0, nonBlocking: 0 }`
 * — so every consumer that reads the STRUCTURED channel (provenance, the
 * trimmed-review findings array from mt#2656, the merge gate) sees a
 * REQUEST_CHANGES review with nothing actionable in it, even though the
 * review body's prose clearly describes blockers.
 *
 * ## Why synthesis, not a downgrade or an incoherence marker
 *
 * Two other shapes were considered and rejected:
 *
 *   - **Downgrade the event to COMMENT.** This is what mt#1496's Step 3
 *     ("crossed-zero reconciliation" in `applyRecoveryAndCompose`) already
 *     does for the STRUCTURALLY DIFFERENT case where a downgrade recovery
 *     pass (monotonicity / convergence / diff-scope) legitimately reduces an
 *     originally-nonzero BLOCKING count to zero — i.e. the model DID find
 *     real BLOCKING issues, and our own recovery layer determined they no
 *     longer apply. Reusing that path here would DISCARD the model's
 *     REQUEST_CHANGES verdict and its prose-described blockers, silently
 *     downgrading a review that (per its own summary) SHOULD block merge.
 *     That is the wrong direction: it makes the bug's symptom (missing
 *     structured findings) also erase the review's intent.
 *   - **An incoherence marker.** Every consumer of the structured channel
 *     (provenance readers, the mt#2656 trimmed-findings array, the mt#2233
 *     merge gate) would need to learn a brand-new state on top of the
 *     existing severity taxonomy. That is a wider blast radius for a defect
 *     whose root cause is "the model forgot to call a tool" — the fix
 *     belongs in the tool-call stream, not in every downstream reader.
 *
 * Synthesizing a BLOCKING finding from the summary preserves REQUEST_CHANGES
 * semantics for the merge gate (mt#2233) with zero new consumer-side states,
 * and composes cleanly with mt#2655's `reconcileEventWithBlockingCount`: once
 * the synthesized finding exists, `blockingCount > 0` and `event ===
 * "REQUEST_CHANGES"` already agree, so `reconcileEventWithBlockingCount`
 * finds nothing to reconcile (no contradictory double-reconciliation).
 *
 * ## Scope: only the "no findings, ever" case
 *
 * This pass fires ONLY when the finding is computed from the RAW, PRE-RECOVERY
 * tool calls (blocking count over the model's OWN `submit_finding` calls,
 * before monotonicity / convergence / diff-scope-bounded downgrades run). It
 * deliberately does NOT fire when a downgrade recovery pass reduces an
 * originally-nonzero BLOCKING count to zero — that is Step 3's job
 * (`applyRecoveryAndCompose` in review-worker.ts), and firing here too would
 * re-synthesize a finding the recovery layer just determined does not apply,
 * fighting the very convergence those passes exist to enable. Concretely:
 * `originalBlockingCount === 0` is the trigger, not `postRecoveryBlockingCount
 * === 0`. Callers MUST invoke this pass on the raw tool calls, before any
 * downgrade recovery, so the "original" semantics hold.
 *
 * Pure function — no I/O, no async, no model calls.
 */

import type { ReviewToolCall, SubmitFindingArgs } from "./output-tools";

/** The sentinel `file` value used for the synthesized finding's location. */
export const SYNTHESIZED_FINDING_FILE = "(review summary)";

export interface EmptyFindingsRecoveryResult {
  /**
   * The tool calls to use for downstream recovery/composition/provenance.
   * Identical to the input array (same reference) when `applied` is false;
   * otherwise the input array with one synthesized `submit_finding` call
   * appended.
   */
  toolCalls: ReadonlyArray<ReviewToolCall>;
  /** True when the incoherence was detected and a finding was synthesized. */
  applied: boolean;
  /**
   * The synthesized finding's args, present only when `applied` is true.
   * Exposed separately so callers can emit a structured audit-log event
   * without re-deriving it from `toolCalls`.
   */
  synthesizedFinding?: SubmitFindingArgs;
}

/**
 * Detect and repair the "REQUEST_CHANGES with zero structured findings"
 * incoherence (mt#2685).
 *
 * @param toolCalls - The RAW tool calls emitted by the reviewer model for
 *   this round, before any downgrade recovery pass has run.
 */
export function applyEmptyFindingsRecovery(
  toolCalls: ReadonlyArray<ReviewToolCall>
): EmptyFindingsRecoveryResult {
  const concludeCalls = toolCalls.filter(
    (tc): tc is Extract<ReviewToolCall, { name: "conclude_review" }> =>
      tc.name === "conclude_review"
  );
  // Mirror composeReviewBody's own "last conclude_review call wins" rule
  // (model self-correction) so this pass and composition agree on which
  // conclusion is authoritative.
  const concludeCall =
    concludeCalls.length > 0 ? concludeCalls[concludeCalls.length - 1] : undefined;

  if (concludeCall === undefined || concludeCall.args.event !== "REQUEST_CHANGES") {
    return { toolCalls, applied: false };
  }

  const blockingCount = toolCalls.filter(
    (tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING"
  ).length;

  if (blockingCount > 0) {
    return { toolCalls, applied: false };
  }

  const synthesizedFinding: SubmitFindingArgs = {
    severity: "BLOCKING",
    file: SYNTHESIZED_FINDING_FILE,
    line: 1,
    summary: "Reviewer concluded REQUEST_CHANGES but emitted no structured findings",
    details:
      `Synthesized by the empty-findings coherence recovery pass (mt#2685): the reviewer ` +
      `model called conclude_review with event=REQUEST_CHANGES but zero submit_finding calls, ` +
      `so the structured findings channel was empty even though the conclusion summary ` +
      `describes blocking issue(s) in prose. Original conclusion summary:\n\n${
        concludeCall.args.summary
      }`,
  };

  const synthesizedCall: ReviewToolCall = { name: "submit_finding", args: synthesizedFinding };

  return {
    toolCalls: [...toolCalls, synthesizedCall],
    applied: true,
    synthesizedFinding,
  };
}
