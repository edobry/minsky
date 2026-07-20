/**
 * Service-layer emission guard for `submit_finding` resolution notes (mt#2863).
 *
 * ## The defect this closes
 *
 * On a re-review round (especially chunked re-verification), the reviewer model
 * sometimes wants to acknowledge that a PRIOR round's BLOCKING finding is now
 * addressed. The prompt tells it to "acknowledge it as addressed and do not
 * re-raise it"; when the model instead emits a `submit_finding` whose SEVERITY
 * is `BLOCKING` (reused from the original finding, "to mark the thread for
 * visibility") but whose TEXT is a resolution note ("no action required — the
 * original block is resolved in the current diff"), the severity contradicts
 * the text.
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
 * This guard repairs the incoherence at the emission boundary instead — the
 * OpenAI tool-use loop in `providers.ts`, the same layer where mt#2828's
 * `conclude-review-guard.ts` corrects an incoherent `conclude_review`. It does
 * NOT substitute the aggregator's judgment for the model's: it detects that the
 * model's OWN finding text ("resolved / no action required") contradicts the
 * severity it stamped, and resolves that self-contradiction in favor of the
 * model's explicit textual disposition by reclassifying the severity to
 * NON-BLOCKING before the finding is accumulated. The note is preserved in the
 * review body as NON-BLOCKING rather than dropped.
 *
 * ## Stateless, per-finding
 *
 * The decision is a pure function of a SINGLE `submit_finding` call — it holds
 * no cross-finding state. (An earlier draft used a per-review reject-and-retry
 * counter mirroring mt#2828's conclude-review guard, but `conclude_review` is
 * emitted once per review whereas `submit_finding` is emitted many times, so a
 * shared counter let one finding's rejections consume another finding's budget.
 * Reclassifying immediately is deterministic, correct, and free of that
 * cross-finding interference. Teaching the model to use the proper channel —
 * `submit_thread_resolve` or a NON-BLOCKING finding — is handled by the prompt;
 * this guard is the deterministic backstop for when it doesn't.)
 *
 * Pure function — no I/O, no async, no model calls, no logging (the caller emits
 * the structured log event).
 */

import type { SubmitFindingArgs } from "./output-tools";

/**
 * Matches finding text whose disposition is a COMPLETED resolution — the issue
 * is already handled and needs no action. Deliberately tight, and every
 * alternative is wrapped in `\b(?:...)\b` word boundaries so a benign substring
 * cannot trigger a match (e.g. "prefix verified" must not match "fix verified",
 * "unresolved" must not match "resolved"). It matches past-tense / completed
 * dispositions ("no action required", "already resolved", "resolved in the
 * current diff", "no longer applies", "fix verified") but NOT imperative
 * language a genuine BLOCKING finding uses ("must be resolved before merge",
 * "requires action", "unresolved race condition"). The regression suite in
 * `resolution-note-guard.test.ts` pins both directions, including adversarial
 * substrings.
 */
export const RESOLUTION_NOTE_PATTERN = new RegExp(
  [
    "no (?:further )?action (?:is |was )?(?:required|needed)",
    "nothing (?:further )?(?:to (?:do|address|fix)|is (?:required|needed))",
    "(?:already|since) (?:been )?(?:resolved|addressed|fixed|handled)",
    "(?:has|have|had|is|was) (?:been |now |since been )?(?:resolved|addressed|fixed|handled) " +
      "(?:in|by) (?:the )?(?:current |latest |updated )?(?:diff|commit|fix|change|pr|pull request)",
    "(?:the )?(?:original |prior |previous |r\\d+ )?(?:block|blocking finding|finding|issue|concern) " +
      "(?:is|was|has (?:now )?been) (?:now )?(?:resolved|addressed|fixed|handled)",
    "no longer (?:applies|an issue|blocking|relevant|a concern)",
    "fix (?:verified|confirmed)",
  ]
    .map((alt) => `\\b(?:${alt})\\b`)
    .join("|"),
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
}

export type EvaluateSubmitFindingCallResult =
  | { decision: "accept" }
  | {
      decision: "reclassify";
      /** The severity the caller should stamp on the finding before accumulating it. */
      newSeverity: "NON-BLOCKING";
      /** Human-readable reason, for the caller's structured log line. */
      reason: string;
    };

/**
 * Decide whether a `submit_finding` call should be accepted as-is, or accepted
 * with its severity reclassified from BLOCKING to NON-BLOCKING.
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
  const { args } = input;

  if (args.severity !== "BLOCKING") {
    return { decision: "accept" };
  }

  if (!isResolutionNoteText(args.summary, args.details)) {
    return { decision: "accept" };
  }

  return {
    decision: "reclassify",
    newSeverity: "NON-BLOCKING",
    reason:
      "BLOCKING finding whose text is a completed-resolution note; reclassified BLOCKING to NON-BLOCKING (emission-layer coherence repair, mt#2863)",
  };
}
