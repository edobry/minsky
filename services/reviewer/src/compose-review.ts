/**
 * Compose a GitHub review body deterministically from output-tool payloads.
 *
 * Pure function — no I/O, no async, no model calls, no GitHub API.
 * All ordering is deterministic: findings are stable-sorted by severity
 * (BLOCKING → NON-BLOCKING → PRE-EXISTING), with original emit order
 * preserved within each severity bucket.
 */

import type { ReviewToolCall, SubmitFindingArgs, SubmitInlineCommentArgs } from "./output-tools";
import { isResolutionNoteText } from "./resolution-note-guard";
import { SYNTHESIZED_FINDING_FILE } from "./empty-findings-recovery";

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<SubmitFindingArgs["severity"], number> = {
  BLOCKING: 0,
  "NON-BLOCKING": 1,
  "PRE-EXISTING": 2,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape pipe characters in a value destined for a Markdown table cell. */
function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/**
 * Render a location string for a finding.
 * Format: `file:line` or `file:line-lineEnd`, with optional ` (LEFT)` suffix.
 */
function renderLocation(args: SubmitFindingArgs): string {
  const range = args.lineEnd !== undefined ? `${args.line}-${args.lineEnd}` : String(args.line);
  const location = `${args.file}:${range}`;
  return args.side === "LEFT" ? `${location} (LEFT)` : location;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A thread-resolve request extracted from a `submit_thread_resolve` tool call.
 * Passed back to the worker so it can call the GraphQL mutation after posting
 * the review (mt#1345).
 */
export interface ThreadResolveEntry {
  /** GraphQL node ID of the PullRequestReviewThread. */
  threadId: string;
  /** Short justification recorded in the worker log. */
  reason: string;
}

/**
 * A composed inline comment for forwarding to `submitReview`.
 * Includes the optional `inReplyTo` field so reply-thread entries pass
 * through to the Octokit API mapper (mt#1345).
 */
export interface ComposedInlineComment {
  file: SubmitInlineCommentArgs["file"];
  line: SubmitInlineCommentArgs["line"];
  body: SubmitInlineCommentArgs["body"];
  /** Diff side (mt#2350). Threaded through so anchor pre-validation can honor it. */
  side?: SubmitInlineCommentArgs["side"];
  inReplyTo?: number;
}

export interface ComposeReviewResult {
  body: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  /**
   * Thread-resolve requests extracted from `submit_thread_resolve` tool calls.
   * The worker iterates this array and calls the GraphQL mutation for each
   * entry after posting the review. Empty when the model emitted no resolve calls.
   */
  threadResolves: ThreadResolveEntry[];
  /**
   * Inline comments with optional `inReplyTo` fields for reply-thread wiring.
   * Replaces the prior pattern of re-extracting inline comments from toolCalls
   * in the worker — the composed result now carries the full shape.
   */
  inlineComments: ComposedInlineComment[];
  /**
   * True when `event` was forced by {@link reconcileEventWithBlockingCount}:
   * either UP to `REQUEST_CHANGES` because outstanding BLOCKING findings
   * disagreed with the model's own (or the last chunk's) terminal verdict
   * (mt#2655), or DOWN to `APPROVE` because the terminal verdict was
   * `COMMENT` with zero BLOCKING findings (mt#3202 / ask#6013). False when
   * the terminal event needed no correction.
   */
  reconciled: boolean;
}

/**
 * Reconcile a terminal review event against outstanding BLOCKING findings
 * (mt#2655; downward direction added mt#3202 / ask#6013).
 *
 * In chunked-review mode, each chunk emits its own `conclude_review` call and
 * `composeReviewBody` uses only the LAST one to derive the raw event — so an
 * earlier chunk's BLOCKING finding can survive into the aggregated findings
 * list even when the last chunk's own verdict was APPROVE or COMMENT. That
 * produced incoherent terminal states in production: APPROVE events carrying
 * `[BLOCKING]`-labeled findings (#1812 R2, #1819 R2) and COMMENT events whose
 * rendered findings counts disagreed with the embedded provenance blob
 * (#1821 R1).
 *
 * This function is a pure, deterministic function of the finding severities
 * actually present — it does not matter whether the caller is composing the
 * posted review body (`composeReviewBody`) or extracting the provenance blob
 * (`extractProvenance` in `review-provenance.ts`); as long as both are given
 * the same `toolCalls`, they reconcile to the identical event, keeping the
 * posted body and the embedded provenance agreement structural rather than
 * coincidental.
 *
 * Relabeling a lingering BLOCKING finding down to a lower severity ("gets
 * relabeled with stated reason", per the task spec) would require the
 * model's own judgment — not available post-hoc from a deterministic
 * aggregator — so a BLOCKING finding is never silently discarded by this
 * function; the upward direction (below) only ever adds REQUEST_CHANGES, it
 * never removes a finding.
 *
 * ## Downward direction: COMMENT + zero BLOCKING → APPROVE (mt#3202)
 *
 * `minsky-reviewer[bot]` frequently concluded with `event: COMMENT` on
 * reviews that recorded ZERO BLOCKING findings — sometimes zero findings at
 * all — because the model treats COMMENT as "approve with reservations" while
 * the merge gate treats it as "not approved." Every such review cost an extra
 * content-free round (mt#3202's four observed instances, 2026-07-24). ask#6013
 * (operator, 2026-07-25) resolved this: when the trigger is "zero BLOCKING
 * findings" — not "zero findings" — the terminal event must be APPROVE, not
 * COMMENT. Making this a function of `blockingCount` (rather than trusting the
 * model's own COMMENT/APPROVE distinction) is what makes "I have concerns but
 * recorded none as blocking" impossible: if the model wants a review to NOT
 * auto-clear, it must submit a BLOCKING `submit_finding` (or a REQUEST_CHANGES
 * conclusion, which `applyEmptyFindingsRecovery` — mt#2685 — backstops by
 * synthesizing a BLOCKING finding from the summary when none was emitted).
 * `reconciledFrom` reports the same "COMMENT" value for both directions;
 * callers distinguish direction via the returned `event`.
 *
 * `allowApprovePromotion` (default `true`) exists so a caller that has NOT
 * received an explicit model verdict — `composeReviewBody`'s "no
 * `conclude_review` call at all" fallback branch — can opt out. A missing
 * `conclude_review` call is a review-PROCESS anomaly (the model never
 * concluded), not evidence the review is clean; silently auto-approving that
 * case would hide the anomaly rather than surface it. Every caller with an
 * explicit model conclusion (a real `conclude_review` call, including one
 * rewritten by an upstream downgrade-recovery pass) uses the default.
 */
export function reconcileEventWithBlockingCount(
  rawEvent: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  blockingCount: number,
  options?: { allowApprovePromotion?: boolean }
): {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  reconciledFrom: "APPROVE" | "COMMENT" | null;
} {
  if (blockingCount > 0 && rawEvent !== "REQUEST_CHANGES") {
    return { event: "REQUEST_CHANGES", reconciledFrom: rawEvent };
  }
  const allowApprovePromotion = options?.allowApprovePromotion ?? true;
  if (blockingCount === 0 && rawEvent === "COMMENT" && allowApprovePromotion) {
    return { event: "APPROVE", reconciledFrom: "COMMENT" };
  }
  return { event: rawEvent, reconciledFrom: null };
}

export interface ComposeReviewBodyOptions {
  /**
   * Whether a zero-BLOCKING `COMMENT` conclusion may be promoted to `APPROVE`
   * (mt#3202 / ask#6013). Defaults to `true`.
   *
   * Set to `false` when the caller has already forcibly rewritten an
   * incoherent `REQUEST_CHANGES` conclusion down to `COMMENT` via an upstream
   * downgrade-recovery pass (`recovery-compose.ts`'s Step 3 / Step 3d) — that
   * COMMENT reflects a demotion of the RECOVERY LAYER'S judgment, not the
   * model's own COMMENT authorship, and the codebase-wide convention for
   * those passes is demote-only (never promote to APPROVE from a post-hoc
   * structural pass whose input was a model REQUEST_CHANGES verdict). This
   * flag composes with (but is independent of) the internal
   * `concludeCall !== undefined` gate below, which handles the "no
   * conclude_review call at all" case.
   */
  allowApprovePromotion?: boolean;
}

/**
 * Compose the GitHub review body and event from a list of output-tool payloads.
 *
 * @param toolCalls - The ordered list of tool calls emitted by the reviewer model.
 * @param options - See {@link ComposeReviewBodyOptions}.
 * @returns An object with `body` (Markdown string), `event` (GitHub review event),
 *          `threadResolves` (thread-resolve requests for the worker), and
 *          `inlineComments` (inline comments with optional inReplyTo fields).
 */
export function composeReviewBody(
  toolCalls: ReviewToolCall[],
  options?: ComposeReviewBodyOptions
): ComposeReviewResult {
  // ------------------------------------------------------------------
  // Empty-input fast path
  // ------------------------------------------------------------------
  if (toolCalls.length === 0) {
    return {
      body: "The reviewer ran but produced no findings. This is not an approval — the model emitted no submit_finding, submit_inline_comment, or conclude_review calls.",
      event: "COMMENT",
      threadResolves: [],
      inlineComments: [],
      reconciled: false,
    };
  }

  // ------------------------------------------------------------------
  // Partition tool calls by type
  // ------------------------------------------------------------------
  const findings = toolCalls.filter(
    (tc): tc is Extract<ReviewToolCall, { name: "submit_finding" }> => tc.name === "submit_finding"
  );

  const inlineCommentCalls = toolCalls.filter(
    (tc): tc is Extract<ReviewToolCall, { name: "submit_inline_comment" }> =>
      tc.name === "submit_inline_comment"
  );

  const specVerifications = toolCalls.filter(
    (tc): tc is Extract<ReviewToolCall, { name: "submit_spec_verification" }> =>
      tc.name === "submit_spec_verification"
  );

  const documentationImpacts = toolCalls.filter(
    (tc): tc is Extract<ReviewToolCall, { name: "submit_documentation_impact" }> =>
      tc.name === "submit_documentation_impact"
  );

  const adoptionSweepCalls = toolCalls.filter(
    (tc): tc is Extract<ReviewToolCall, { name: "submit_adoption_sweep" }> =>
      tc.name === "submit_adoption_sweep"
  );

  const concludeCalls = toolCalls.filter(
    (tc): tc is Extract<ReviewToolCall, { name: "conclude_review" }> =>
      tc.name === "conclude_review"
  );

  // Extract thread-resolve requests (mt#1345). These are NOT rendered in the
  // review body — they are handled separately by the worker via the GraphQL
  // mutation. We collect them here so callers don't have to re-scan toolCalls.
  const threadResolves: ThreadResolveEntry[] = toolCalls
    .filter(
      (tc): tc is Extract<ReviewToolCall, { name: "submit_thread_resolve" }> =>
        tc.name === "submit_thread_resolve"
    )
    .map((tc) => ({ threadId: tc.args.threadId, reason: tc.args.reason }));

  // Build the composed inline-comments array with optional inReplyTo fields
  // so the worker can pass them directly to submitReview without re-extracting.
  const inlineComments: ComposedInlineComment[] = inlineCommentCalls.map((tc) => ({
    file: tc.args.file,
    line: tc.args.line,
    body: tc.args.body,
    ...(tc.args.side !== undefined ? { side: tc.args.side } : {}),
    ...(tc.args.inReplyTo !== undefined ? { inReplyTo: tc.args.inReplyTo } : {}),
  }));

  // ------------------------------------------------------------------
  // Determine event and summary
  // ------------------------------------------------------------------
  const noConclude = concludeCalls.length === 0;
  // Use the LAST conclude_review call (model self-correction)
  const concludeCall =
    concludeCalls.length > 0 ? concludeCalls[concludeCalls.length - 1] : undefined;

  // When conclude_review is absent, derive the event from severity counts:
  // any BLOCKING finding → REQUEST_CHANGES; otherwise → COMMENT.
  const blockingFindingsCount = findings.filter((tc) => tc.args.severity === "BLOCKING").length;
  // Computed once here (rather than re-derived per notice branch below) so
  // the "no conclude_review" warning, the mt#2655 REQUEST_CHANGES notice, and
  // the mt#3202 APPROVE notice all report identical counts.
  const nonBlockingFindingsCount = findings.filter(
    (tc) => tc.args.severity === "NON-BLOCKING"
  ).length;
  const preExistingFindingsCount = findings.filter(
    (tc) => tc.args.severity === "PRE-EXISTING"
  ).length;
  let event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  if (concludeCall !== undefined) {
    event = concludeCall.args.event;
  } else {
    event = blockingFindingsCount > 0 ? "REQUEST_CHANGES" : "COMMENT";
  }

  // Chunk-review / label reconciliation (mt#2655 upward; mt#3202 downward):
  // a lingering BLOCKING finding forces REQUEST_CHANGES regardless of what
  // conclude_review (or the fallback derivation above, which is already
  // self-consistent) said; a zero-BLOCKING COMMENT forces APPROVE. Promotion
  // to APPROVE is disabled for the "no conclude_review call at all" fallback
  // branch (`concludeCall === undefined`) — a missing conclusion is a
  // review-process anomaly the warning section below surfaces, not evidence
  // the review is clean, so it must not silently clear the gate. See
  // reconcileEventWithBlockingCount's doc comment for the full incident
  // context.
  const reconciliation = reconcileEventWithBlockingCount(event, blockingFindingsCount, {
    allowApprovePromotion: concludeCall !== undefined && (options?.allowApprovePromotion ?? true),
  });
  event = reconciliation.event;

  // ------------------------------------------------------------------
  // Build body sections
  // ------------------------------------------------------------------
  const sections: string[] = [];

  // Section -1: Reconciliation notice (mt#2655 upward; mt#3202 downward) —
  // surfaced FIRST, ahead of the executive summary, so the disagreement
  // between the model's own verdict and the actual finding severities is
  // impossible to miss.
  if (reconciliation.reconciledFrom !== null && event === "REQUEST_CHANGES") {
    // mt#2863 SC2: name any BLOCKING finding whose text reads as a resolution
    // note, so operators can distinguish a genuine block-after-approval from the
    // resolution-note mis-tag bug class. The emission-layer guard normally
    // reclassifies these before composition; this diagnostic covers the residual
    // / legacy / replay case where one still reaches the reconciler.
    // mt#4977: EXCLUDE the mt#2685 synthesized placeholder. Its `details`
    // embeds the model's whole conclusion summary verbatim, so any
    // resolution-flavoured sentence anywhere in that prose makes this predicate
    // true — and the banner then tells the operator the finding is "likely
    // mis-tagged rather than a genuine blocker". For a synthesized finding that
    // is never right: it carries no model severity judgment to be mis-tagged,
    // and the conclusion it quotes is by construction a REQUEST_CHANGES.
    //
    // Found by mt#4977's false-positive sweep, not hypothesised: PR #2448 r2's
    // placeholder quotes "The prior BLOCKING issue was addressed: … However,
    // Success Criterion 6 remains unmet … Please either wire … or update the
    // spec" — a real blocking demand the banner would have invited an operator
    // to dismiss. Pre-existing (the shipped pattern already matched it); fixed
    // here because the sweep surfaced it.
    const resolutionNoteBlockers = findings.filter(
      (tc) =>
        tc.args.severity === "BLOCKING" &&
        tc.args.file !== SYNTHESIZED_FINDING_FILE &&
        isResolutionNoteText(tc.args.summary, tc.args.details)
    );
    const resolutionNoteNote =
      resolutionNoteBlockers.length > 0
        ? ` NOTE (mt#2863): ${resolutionNoteBlockers.length} of the BLOCKING finding(s) listed in the Findings section below read as resolution notes — their text asserts the issue is already resolved / needs no action, so they are likely mis-tagged rather than genuine blockers (${resolutionNoteBlockers.map((tc) => `${tc.args.file}:${tc.args.line}`).join(", ")}).`
        : "";
    sections.push(
      `⚠️ **Event reconciled from \`${reconciliation.reconciledFrom}\` to \`REQUEST_CHANGES\`.** ` +
        `${blockingFindingsCount} outstanding \`[BLOCKING]\` finding(s) remain in this review — ` +
        `possibly emitted by a different chunk than the one that concluded the review. A ` +
        `\`${reconciliation.reconciledFrom}\` event cannot coexist with a BLOCKING finding; see the ` +
        `Findings section below for the finding(s) driving this reconciliation.${resolutionNoteNote}`
    );
  } else if (reconciliation.reconciledFrom !== null && event === "APPROVE") {
    // mt#3202 / ask#6013: the model concluded COMMENT with zero BLOCKING
    // findings. Per the operator's resolution, zero BLOCKING findings clears
    // the review automatically — COMMENT-with-no-blocker is not a distinct
    // "hold for review" state. Surfaced (not silent) so an agent reading the
    // posted review can tell the APPROVE event was reconciled rather than
    // model-authored — the review's own prose (rendered below) may still
    // read as tentative even though the verdict now clears the merge gate.
    sections.push(
      `ℹ️ **Event reconciled from \`COMMENT\` to \`APPROVE\`.** This review recorded 0 BLOCKING / ` +
        `${nonBlockingFindingsCount} NON-BLOCKING / ${preExistingFindingsCount} PRE-EXISTING ` +
        `findings; per the resolved policy on COMMENT-with-zero-blocking-findings (mt#3202 / ` +
        `ask#6013), a review with no blocking findings clears the merge gate automatically rather ` +
        `than requiring a content-free follow-up round. If any finding below is NON-BLOCKING but ` +
        `should have blocked merge, that is a review-quality issue to raise separately — the fix ` +
        `here only affects the mapping from findings to verdict, not what the model classifies as ` +
        `blocking.`
    );
  }

  // Section 0: Warning if no conclude_review was emitted; Section 1: Executive summary
  if (noConclude || concludeCall === undefined) {
    sections.push(
      `⚠️ **Reviewer did not emit a \`conclude_review\` call.** Event derived from severity counts: ${event} (${blockingFindingsCount} BLOCKING / ${nonBlockingFindingsCount} NON-BLOCKING / ${preExistingFindingsCount} PRE-EXISTING findings). Executive summary unavailable.`
    );
  } else {
    sections.push(concludeCall.args.summary);
  }

  // Section 2: Findings list
  if (findings.length > 0) {
    const sortedFindings = findings
      .map((tc, index) => ({ tc, index }))
      .sort((a, b) => {
        const severityDiff =
          SEVERITY_ORDER[a.tc.args.severity] - SEVERITY_ORDER[b.tc.args.severity];
        if (severityDiff !== 0) return severityDiff;
        // Stable sort: preserve original emit order within the same severity
        return a.index - b.index;
      })
      .map(({ tc }) => tc);

    const findingLines: string[] = ["## Findings", ""];
    for (const tc of sortedFindings) {
      const location = renderLocation(tc.args);
      findingLines.push(`- [${tc.args.severity}] ${location} — ${tc.args.summary}`);
      findingLines.push(`  ${tc.args.details}`);
    }

    sections.push(findingLines.join("\n"));
  }

  // Section 3: Inline comments (optional)
  if (inlineCommentCalls.length > 0) {
    const lines: string[] = ["## Inline comments", ""];
    for (const tc of inlineCommentCalls) {
      lines.push(`- ${tc.args.file}:${tc.args.line} — ${tc.args.body}`);
    }
    sections.push(lines.join("\n"));
  }

  // Section 4: Spec verification table (optional)
  if (specVerifications.length > 0) {
    const lines: string[] = [
      "## Spec verification",
      "",
      "| Criterion | Status | Evidence |",
      "| --- | --- | --- |",
    ];
    for (const tc of specVerifications) {
      const criterion = escapeTableCell(tc.args.criterion);
      const status = escapeTableCell(tc.args.status);
      const evidence = escapeTableCell(tc.args.evidence);
      lines.push(`| ${criterion} | ${status} | ${evidence} |`);
    }
    sections.push(lines.join("\n"));
  }

  // Section 4b: Adoption sweep (optional)
  //
  // Emitted when the model calls submit_adoption_sweep. Positioned AFTER
  // spec verification and BEFORE documentation impact. Section is omitted
  // entirely when no submit_adoption_sweep calls were made.
  if (adoptionSweepCalls.length > 0) {
    const lines: string[] = [
      "## Adoption sweep",
      "",
      "| Symbol | Kind | Consumers found | Classification | Notes |",
      "| --- | --- | --- | --- | --- |",
    ];
    let missingConsumersCount = 0;
    for (const tc of adoptionSweepCalls) {
      const symbol = escapeTableCell(tc.args.symbol);
      const kind = escapeTableCell(tc.args.kind);
      const consumers = escapeTableCell(
        tc.args.consumersFound.length > 0 ? tc.args.consumersFound.join(", ") : "—"
      );
      const classification = escapeTableCell(tc.args.classification);
      const notes = escapeTableCell(tc.args.notes ?? "");
      lines.push(`| ${symbol} | ${kind} | ${consumers} | ${classification} | ${notes} |`);
      if (tc.args.classification === "Missing consumers") {
        missingConsumersCount++;
      }
    }
    if (missingConsumersCount > 0) {
      lines.push(
        "",
        `Recommendation: file a follow-up adoption task to wire ${missingConsumersCount} missing consumer${missingConsumersCount === 1 ? "" : "s"}.`
      );
    }
    sections.push(lines.join("\n"));
  }

  // Section 5: Documentation impact (optional)
  //
  // Emitted when the model calls submit_documentation_impact. The merge-gate
  // hook (.claude/hooks/require-review-before-merge.ts) text-matches
  // /documentation[- ]impact/i on the rendered body, so the literal section
  // heading "## Documentation impact" must remain.
  //
  // Multi-call handling: the prompt instructs the model to call this tool
  // exactly once per review. In practice the model may emit more than one
  // (self-correction, retries). Mirror the conclude_review pattern and use
  // the LAST call's args — newer emissions supersede older ones. Single bullet
  // rendered regardless of N to avoid duplicate-content drift.
  const lastDocImpact = documentationImpacts[documentationImpacts.length - 1];
  if (lastDocImpact !== undefined) {
    const lines: string[] = ["## Documentation impact", ""];
    lines.push(`- **${lastDocImpact.args.kind}** — ${lastDocImpact.args.evidence}`);
    if (lastDocImpact.args.affectedDocs && lastDocImpact.args.affectedDocs.length > 0) {
      lines.push(`  Affected: ${lastDocImpact.args.affectedDocs.join(", ")}`);
    }
    sections.push(lines.join("\n"));
  } else {
    sections.push(
      "## Documentation impact\n\n" +
        "- **missing** — `submit_documentation_impact` was not called by the reviewer model. " +
        "The merge gate requires this assessment. This is a reviewer-bot output gap, not a PR defect."
    );
  }

  return {
    body: sections.join("\n\n"),
    event,
    threadResolves,
    inlineComments,
    reconciled: reconciliation.reconciledFrom !== null,
  };
}
