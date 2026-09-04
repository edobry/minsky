/**
 * Service-layer emission guard for `submit_finding` resolution notes (mt#2863;
 * extended mt#3300 with argument-naming + untracked-deferral rejection).
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
 * REQUEST_CHANGES. The result is an approved-in-substance PR carrying an
 * outstanding CHANGES_REQUESTED review — so convergence cannot finish until
 * another round clears it, which is disproportionately expensive for
 * subagent-driven convergence.
 *
 * CORRECTION (mt#4897, verified 2026-09-04). This passage previously added
 * "which also fails the `minsky-reviewer/findings` required check" and
 * "`forceBypass` cannot clear a failing required check (only a retrigger or
 * `MINSKY_SKIP_REQUIRED_CHECKS` can)." **Both rest on a false premise.** Branch
 * protection on `main` requires exactly `build`, `Prevent Placeholder Tests`
 * and `cold-start-migrate` (read from the branch-protection API with an admin
 * token); `minsky-reviewer/findings` is not required, so its conclusion blocks
 * nothing. The real cost is the outstanding REVIEW above, not a failing check.
 *
 * This guard's behaviour is unchanged and still correct on its own terms: it
 * prevents the model emitting a finding whose severity contradicts its text,
 * which is a defect regardless of what any check does downstream.
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

// ---------------------------------------------------------------------------
// Resolution-argument classification (mt#3300 SC#2 / SC#4)
// ---------------------------------------------------------------------------

/**
 * The set of arguments a resolution note can name to justify dropping a
 * BLOCKING finding (mt#3300 spec's Success Criterion 2). `"code-fix"` is the
 * ORIGINAL mt#2863 case — the note explicitly claims the finding was
 * addressed BY a code change in the current diff/commit/fix — and is
 * distinct from the three "no code change" arguments (`spec-amendment`,
 * `pre-existence`, `tracked-deferral`) mt#3300 is about. `"untracked-deferral"`
 * and `"none"` are NOT valid resolutions — see `evaluateSubmitFindingCall`
 * and the mt#3300 spec's "Design decisions" section (decision 3) for why
 * they are rejected rather than silently downgraded.
 */
export type ResolutionArgumentKind =
  | "code-fix"
  | "spec-amendment"
  | "pre-existence"
  | "tracked-deferral"
  | "untracked-deferral"
  | "none";

/**
 * mt#3300 R1 non-blocking: locale/phrasing limits. All four pattern constants
 * below (`CODE_FIX_CLAIM_PATTERN`, `SPEC_AMENDMENT_PATTERN`,
 * `PRE_EXISTENCE_PATTERN`, `DEFERRAL_PATTERN`) are English-only, fixed-phrase
 * regexes — they recognize the specific wordings the reviewer model has
 * historically produced (mirroring `RESOLUTION_NOTE_PATTERN` above), not an
 * exhaustive semantic classifier. A genuinely valid argument phrased in
 * unanticipated English wording, or in any non-English text, classifies as
 * `"none"` and is REJECTED (kept BLOCKING) rather than accepted — this is the
 * safe failure direction (a false negative here costs an extra round of
 * iteration; a false positive would let an unaudited resolution through). If
 * this recall gap proves load-bearing in practice, broadening the patterns —
 * or moving to a model-based classification pass — is future work, not done
 * here.
 */

/** Matches a task-id reference in any of this repo's project-code forms. */
const TASK_ID_PATTERN = /\b(?:mt|md|gh)#\d+\b/i;

/**
 * The note explicitly claims the finding was addressed BY a code change —
 * "resolved in the current diff", "fixed by the fix commit", "fix verified".
 * This is the mt#2863 case (a genuine fix, wrong leftover severity), not the
 * mt#3300 "argued out without a code change" case; the independent
 * diff-mining classifier (`resolution-classifier.ts`, SC#1) still verifies
 * this claim at APPROVE time and would classify a FALSE claim as
 * `resolved-without-code-change` regardless of what this emission-time note
 * says.
 */
const CODE_FIX_CLAIM_PATTERN =
  /\b(?:resolved|addressed|fixed|handled)\b(?:\s+\S+){0,4}?\s+(?:in|by)\s+(?:the\s+)?(?:current\s+|latest\s+|updated\s+)?(?:diff|commit|fix|change|pr|pull request)\b|\bfix\s+(?:verified|confirmed)\b/i;

/** The finding's underlying concern was resolved by amending the spec itself. */
const SPEC_AMENDMENT_PATTERN =
  /\bspec\b.{0,40}\b(?:amended|updated|revised|changed)\b|\b(?:amended|updated|revised)\b.{0,40}\bspec\b/i;

/** The finding describes something that predates this PR / was already present. */
const PRE_EXISTENCE_PATTERN =
  /\bpre-existing\b|\bpredates\b|\balready present before\b|\bexisted before this (?:pr|pull request|change|diff)\b/i;

/** The finding's concern is being deferred to follow-up work. */
const DEFERRAL_PATTERN =
  /\bdeferred\b|\btracked (?:as|in|via)\b|\bfollow-?up (?:task|issue)\b|\bout of scope\b/i;

/**
 * Classify what argument (if any) a resolution note names to justify
 * dropping a BLOCKING finding. Pure function — no I/O.
 *
 * Only fires meaningfully on text that has already matched
 * `RESOLUTION_NOTE_PATTERN` (i.e. reads as SOME completed-resolution note);
 * called on other text it simply returns `"none"`.
 *
 * Checked in order: an explicit code-fix claim wins first (mt#2863's
 * original case); then the three "no code change" arguments mt#3300 adds.
 * `"tracked-deferral"` requires BOTH deferral language AND a task-id
 * reference (`mt#123` / `md#123` / `gh#123`) in the same text; deferral
 * language with no task id classifies as `"untracked-deferral"` (mt#3300
 * SC#4 — "a deferral argument that names no tracking task id ... is not
 * accepted as a resolution").
 *
 * Exported for unit testing.
 */
export function classifyResolutionArgument(text: string): ResolutionArgumentKind {
  if (CODE_FIX_CLAIM_PATTERN.test(text)) return "code-fix";
  if (SPEC_AMENDMENT_PATTERN.test(text)) return "spec-amendment";
  if (PRE_EXISTENCE_PATTERN.test(text)) return "pre-existence";
  if (DEFERRAL_PATTERN.test(text)) {
    return TASK_ID_PATTERN.test(text) ? "tracked-deferral" : "untracked-deferral";
  }
  return "none";
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
      /** Which argument kind justified the downgrade (mt#3300 SC#2). */
      argumentKind: Exclude<ResolutionArgumentKind, "untracked-deferral" | "none">;
      /** Human-readable reason, for the caller's structured log line. */
      reason: string;
    }
  | {
      decision: "reject";
      /** Why the resolution note was NOT accepted (mt#3300 SC#4). */
      argumentKind: Extract<ResolutionArgumentKind, "untracked-deferral" | "none">;
      /** Human-readable reason, for the caller's structured log line. */
      reason: string;
    };

/**
 * Decide whether a `submit_finding` call should be accepted as-is, accepted
 * with its severity reclassified from BLOCKING to NON-BLOCKING, or rejected
 * (kept BLOCKING, with a visible marker) because its resolution argument
 * doesn't meet the bar.
 *
 * Fires ONLY on the self-contradiction: `severity === "BLOCKING"` AND the
 * finding text reads as a completed resolution note. Every other call — any
 * NON-BLOCKING or PRE-EXISTING finding, and any BLOCKING finding whose text is
 * NOT a resolution disposition (i.e. a genuine defect) — is accepted unchanged,
 * so genuine BLOCKING findings and the `minsky-reviewer/findings` check mapping
 * are unaffected (mt#2863 SC4).
 *
 * Among resolution notes (mt#3300 SC#2/SC#4): a note naming `spec-amendment`,
 * `pre-existence`, or a task-id-bearing `tracked-deferral` reclassifies to
 * NON-BLOCKING as before. A note naming NO recognized argument (`"none"`) or
 * an `untracked-deferral` (deferral language with no task id) is REJECTED —
 * the finding stays BLOCKING, forcing a genuine fix, a named spec amendment,
 * or a properly tracked deferral. See the mt#3300 spec's "Design decisions"
 * section (decision 3) for why reject was chosen over a silent downgrade.
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

  const argumentKind = classifyResolutionArgument(`${args.summary}\n${args.details}`);

  if (argumentKind === "untracked-deferral" || argumentKind === "none") {
    const reasonDetail =
      argumentKind === "untracked-deferral"
        ? "names a deferral but no tracking task id (mt#/md#/gh#<N>)"
        : "reads as a resolution but names no recognized argument (spec amendment, pre-existence, or a tracked deferral)";
    return {
      decision: "reject",
      argumentKind,
      reason:
        `BLOCKING finding whose text is a completed-resolution note that ${reasonDetail}; ` +
        "untracked/unnamed resolutions are not accepted (mt#3300 SC#2/SC#4) — kept BLOCKING pending " +
        "a genuine fix, a named spec amendment, or a task-id-tracked deferral.",
    };
  }

  return {
    decision: "reclassify",
    newSeverity: "NON-BLOCKING",
    argumentKind,
    reason:
      `BLOCKING finding whose text is a completed-resolution note (${argumentKind}); reclassified ` +
      "BLOCKING to NON-BLOCKING (emission-layer coherence repair, mt#2863/mt#3300)",
  };
}

/**
 * Marker prefix `providers.ts` prepends to a rejected finding's `details`
 * (mt#3300) so the untracked-deferral gap stays visible in the persisted
 * finding body.
 */
export const UNTRACKED_DEFERRAL_MARKER = "[untracked-deferral]";

/**
 * Idempotently prepend `UNTRACKED_DEFERRAL_MARKER` to `details`.
 *
 * A finding can be re-submitted across review rounds carrying its own prior
 * text forward (the model often echoes its earlier wording verbatim on a
 * re-raise) — prepending unconditionally on every `reject` decision would
 * accumulate duplicate markers ("[untracked-deferral] [untracked-deferral]
 * ..."). Exported for unit testing.
 */
export function markUntrackedDeferral(details: string): string {
  if (details.startsWith(UNTRACKED_DEFERRAL_MARKER)) return details;
  return `${UNTRACKED_DEFERRAL_MARKER} ${details}`;
}
