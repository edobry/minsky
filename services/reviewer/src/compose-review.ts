/**
 * Compose a GitHub review body deterministically from output-tool payloads.
 *
 * Pure function — no I/O, no async, no model calls, no GitHub API.
 * All ordering is deterministic: findings are stable-sorted by severity
 * (BLOCKING → NON-BLOCKING → PRE-EXISTING), with original emit order
 * preserved within each severity bucket.
 */

import type { ReviewToolCall, SubmitFindingArgs, SubmitInlineCommentArgs } from "./output-tools";

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
   * True when `event` was forced to `REQUEST_CHANGES` by
   * {@link reconcileEventWithBlockingCount} because outstanding BLOCKING
   * findings disagreed with the model's own (or the last chunk's) terminal
   * verdict (mt#2655). False when the terminal event needed no correction.
   */
  reconciled: boolean;
}

/**
 * Reconcile a terminal review event against outstanding BLOCKING findings
 * (mt#2655).
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
 * aggregator — so the only reconciled direction is toward REQUEST_CHANGES,
 * never a silent downgrade of the findings themselves.
 */
export function reconcileEventWithBlockingCount(
  rawEvent: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  blockingCount: number
): {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  reconciledFrom: "APPROVE" | "COMMENT" | null;
} {
  if (blockingCount > 0 && rawEvent !== "REQUEST_CHANGES") {
    return { event: "REQUEST_CHANGES", reconciledFrom: rawEvent };
  }
  return { event: rawEvent, reconciledFrom: null };
}

/**
 * Compose the GitHub review body and event from a list of output-tool payloads.
 *
 * @param toolCalls - The ordered list of tool calls emitted by the reviewer model.
 * @returns An object with `body` (Markdown string), `event` (GitHub review event),
 *          `threadResolves` (thread-resolve requests for the worker), and
 *          `inlineComments` (inline comments with optional inReplyTo fields).
 */
export function composeReviewBody(toolCalls: ReviewToolCall[]): ComposeReviewResult {
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
  let event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  if (concludeCall !== undefined) {
    event = concludeCall.args.event;
  } else {
    event = blockingFindingsCount > 0 ? "REQUEST_CHANGES" : "COMMENT";
  }

  // Chunk-review / label reconciliation (mt#2655): a lingering BLOCKING
  // finding forces REQUEST_CHANGES regardless of what conclude_review (or
  // the fallback derivation above, which is already self-consistent) said.
  // See reconcileEventWithBlockingCount's doc comment for the full incident
  // context.
  const reconciliation = reconcileEventWithBlockingCount(event, blockingFindingsCount);
  event = reconciliation.event;

  // ------------------------------------------------------------------
  // Build body sections
  // ------------------------------------------------------------------
  const sections: string[] = [];

  // Section -1: Reconciliation notice (mt#2655) — surfaced FIRST, ahead of
  // the executive summary, so the disagreement between the model's own
  // verdict and the actual finding severities is impossible to miss.
  if (reconciliation.reconciledFrom !== null) {
    sections.push(
      `⚠️ **Event reconciled from \`${reconciliation.reconciledFrom}\` to \`REQUEST_CHANGES\`.** ` +
        `${blockingFindingsCount} outstanding \`[BLOCKING]\` finding(s) remain in this review — ` +
        `possibly emitted by a different chunk than the one that concluded the review. A ` +
        `\`${reconciliation.reconciledFrom}\` event cannot coexist with a BLOCKING finding; see the ` +
        `Findings section below for the finding(s) driving this reconciliation.`
    );
  }

  // Section 0: Warning if no conclude_review was emitted; Section 1: Executive summary
  if (noConclude || concludeCall === undefined) {
    const nonBlockingCount = findings.filter((tc) => tc.args.severity === "NON-BLOCKING").length;
    const preExistingCount = findings.filter((tc) => tc.args.severity === "PRE-EXISTING").length;
    sections.push(
      `⚠️ **Reviewer did not emit a \`conclude_review\` call.** Event derived from severity counts: ${event} (${blockingFindingsCount} BLOCKING / ${nonBlockingCount} NON-BLOCKING / ${preExistingCount} PRE-EXISTING findings). Executive summary unavailable.`
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
