/**
 * Prior-review summarizer for the reviewer service.
 *
 * Takes the list of prior bot reviews on a PR (fetched from GitHub by
 * github-client.ts) and produces a structured summary ready to inject into
 * the review prompt. The summary tells the model which findings it already
 * raised so it can decide: acknowledge-and-skip (addressed), re-raise-at-same-
 * severity (still open), or raise-new (genuinely new evidence).
 *
 * Pure function — no side effects, no I/O. All tests can run synchronously.
 */

import { safeTruncate } from "./utils/safe-truncate";

/**
 * A single prior review posted by the bot reviewer on this PR.
 * Populated by github-client.ts fetchPriorReviews.
 */
export interface PriorReview {
  id: number;
  /**
   * Review state as returned by the GitHub API.
   * "PENDING" is possible (a draft review not yet submitted) and is filtered
   * out by fetchPriorReviews before it reaches this type in practice, but we
   * include it here for accurate typing.
   */
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt: string;
  commitId: string;
  userLogin: string;
  body: string;
}

/**
 * Structured representation of a single review iteration within the summary.
 */
export interface PriorReviewEntry {
  /** 1-based iteration index, oldest first. */
  iteration: number;
  /** The commit SHA this review was posted against. */
  commitId: string;
  /** Review state as submitted (APPROVED, CHANGES_REQUESTED, COMMENTED). */
  state: string;
  /** ISO timestamp of when the review was submitted. */
  submittedAt: string;
  /** True when review.commitId !== currentHeadSha — implementer may have addressed it since. */
  isStale: boolean;
  /** Verbatim findings block extracted from the review body. */
  findingsMarkdown: string;
}

/**
 * Summarized view of all prior reviews on this PR, ready to inject into the
 * review prompt.
 */
export interface PriorReviewSummary {
  /** Number of prior review iterations found. */
  iterationCount: number;
  /** Per-iteration entries, sorted oldest-first. */
  reviews: PriorReviewEntry[];
  /** Rendered markdown ready to inject into the prompt. Empty string when no reviews. */
  markdown: string;
}

/** Chinese-wall header marker present in all bot reviews. */
export const CHINESE_WALL_MARKER = "Independent adversarial review";

/**
 * The canonical bot login for the minsky-reviewer GitHub App.
 *
 * Hard-coded here rather than resolved dynamically (via getAppIdentity) because
 * this module is pure / side-effect-free and must not import @octokit/* for
 * testability. If the App slug ever changes, update this constant and the test
 * fixture in prior-review-summary.test.ts.
 */
export const MINSKY_REVIEWER_BOT_LOGIN = "minsky-reviewer[bot]";

/**
 * Explicit allowlist of GitHub bot logins trusted as reviewer bots.
 *
 * New reviewer apps must be added here explicitly. Future apps should be
 * added to this set AND must include the Chinese-wall marker in review bodies.
 * Both checks are required for inclusion — the login check alone is not
 * sufficient, because operational notices (skip-notices, CoT leakage notices)
 * are posted under the same bot login but intentionally lack the marker.
 */
export const ALLOWED_REVIEWER_BOT_LOGINS = new Set([
  MINSKY_REVIEWER_BOT_LOGIN,
  // Future reviewer apps must be added here explicitly.
]);

/**
 * Pure predicate that decides whether a raw GitHub review entry should be
 * included in the prior-review summary.
 *
 * Inclusion rule (all conditions must hold):
 *   1. State is not DISMISSED and not PENDING.
 *   2. The login is in ALLOWED_REVIEWER_BOT_LOGINS (explicit allowlist).
 *   3. The body contains CHINESE_WALL_MARKER.
 *
 * Requiring the Chinese-wall marker for ALL inclusions — including the primary
 * `minsky-reviewer[bot]` identity — prevents operational notices posted under
 * the same login from being ingested as prior reviews. Specifically:
 *   - Empty-output skip-notices (buildEmptyOutputSkipNotice) start with
 *     "⚠️ **Automated review skipped**" and lack the marker.
 *   - CoT leakage sanitizer notices start with "**reviewer-service error:**"
 *     and also lack the marker.
 * Both are correctly excluded because neither contains CHINESE_WALL_MARKER.
 *
 * Body-spoof risk: the marker is not cryptographic, so a rogue human or
 * unrelated bot could craft a body that passes. The login allowlist is the
 * primary identity boundary; the marker is a secondary signal that rules out
 * operational notices from the same bot identity.
 *
 * Exported for tests — avoids importing github-client.ts (and its @octokit deps)
 * just to test filter logic.
 */
export function isBotReviewerEntry(entry: {
  state: string;
  userLogin: string;
  body: string | null;
}): boolean {
  // Filter out non-substantive states.
  if (entry.state === "DISMISSED" || entry.state === "PENDING") return false;

  // Login must be in the explicit allowlist.
  if (!ALLOWED_REVIEWER_BOT_LOGINS.has(entry.userLogin)) return false;

  // The Chinese-wall marker must be present for ALL inclusions — even the
  // primary minsky-reviewer[bot] identity. Operational notices (skip-notices,
  // CoT leakage notices) pass the login check but intentionally lack this
  // marker, so they are correctly excluded here.
  const body = entry.body ?? "";
  return body.includes(CHINESE_WALL_MARKER);
}

/**
 * Extract the findings block from a bot review body.
 *
 * Heuristic: look for a "### Findings" header or lines that start with
 * one of the severity markers **[BLOCKING]** / **[NON-BLOCKING]** / **[PRE-EXISTING]**.
 * Returns the extracted block verbatim, or the full body if extraction fails.
 */
export function extractFindings(body: string): string {
  if (!body.trim()) return "";

  // Strategy 1: look for "### Findings" section header
  const findingsHeaderMatch = body.match(/###\s+Findings\b/i);
  if (findingsHeaderMatch && findingsHeaderMatch.index !== undefined) {
    const afterHeader = body.slice(findingsHeaderMatch.index);
    // PR #921 R7 catch: pre-fix this had a silent-data-loss bug when the
    // `### Findings` line was the last line of the body without a trailing
    // newline. afterHeader.indexOf("\n") returns -1, +1 yields 0, the
    // search starts at offset 0 and matches the same `### Findings` header
    // (nextHeader becomes 0), then slice(0, 0).trim() returns "". Fix:
    // explicitly handle the no-newline case by returning the full
    // afterHeader (header to EOF).
    const headerNewlineIdx = afterHeader.indexOf("\n");
    if (headerNewlineIdx === -1) {
      // Header is on the last line with no trailing newline → no body to
      // extract beyond the header itself. Return the whole afterHeader
      // (which is just the header line at this point).
      return afterHeader.trim();
    }
    // Search for the next ### header strictly AFTER the header line.
    const nextHeader = afterHeader.slice(headerNewlineIdx + 1).search(/^###\s/m);
    if (nextHeader >= 0) {
      const headerLineLen = headerNewlineIdx + 1;
      return afterHeader.slice(0, headerLineLen + nextHeader).trim();
    }
    return afterHeader.trim();
  }

  // Strategy 2: collect lines from the first severity marker onward.
  // Once `inFinding` flips true, every subsequent line is captured to the
  // end of the body. Blank lines within a findings block are common
  // (readability) and have no reliable terminating signal, so we prefer
  // over-capture to truncation — the prompt-budget truncation in
  // renderSummary handles upstream length control.
  const lines = body.split("\n");
  const findingLines: string[] = [];
  let inFinding = false;

  for (const line of lines) {
    // Anchor severity markers to the start of the line (with optional
    // whitespace and bullet/list prefix). Real production review bodies
    // place findings at the start of a list item; mid-line mentions in
    // narrative prose ("the string [BLOCKING] appears in docs") must NOT
    // trigger inFinding (which would over-capture the body to EOF).
    //
    // PR #921 R3 refinements:
    //   - Bullet class broadened to `[-+*•]` plus numeric-ordered lists
    //     (e.g., `1.`, `12.`) for parity with GitHub Markdown.
    //   - Switched bare-branch boundary from consuming `(?:[^*]|$)` to
    //     non-consuming negative lookahead `(?!\*)`. Lookahead is broadly
    //     supported (ES5+), unlike lookbehind, so portability is preserved
    //     while the regex no longer eats the next character. This avoids
    //     subtle slicing bugs if the regex is later used for capture.
    if (
      /^\s*(?:(?:\d+\.|[-+*•])\s+)?(?:\*\*\[(?:BLOCKING|NON-BLOCKING|PRE-EXISTING)\]\*\*|\[(?:BLOCKING|NON-BLOCKING|PRE-EXISTING)\](?!\*))/i.test(
        line
      )
    ) {
      inFinding = true;
    }
    if (inFinding) {
      findingLines.push(line);
    }
  }

  if (findingLines.length > 0) {
    return findingLines.join("\n").trim();
  }

  // Fallback: return full body, truncated to 1000 chars to avoid blowing up
  // the summary budget for an unexpected format.
  return body.length > 1000 ? `${safeTruncate(body, 1000, "head")}\n…(truncated)` : body;
}

/**
 * Count [BLOCKING] findings in a review body.
 *
 * Shared between the current-review blocking count (emitted on every
 * review_result log line) and the per-iteration priorBlockingCounts array
 * (SC-3 convergence metric — "Iter-1 6 blockers → Iter-2 3 blockers").
 * Extraction failure returns 0, matching the non-fatal stance in review-worker.
 */
export function countBlockingFindings(body: string): number {
  // Pattern (must stay in sync with extractFindings strategy 2 above):
  //   - Anchored to start-of-line (multiline g flag) with optional
  //     whitespace and optional bullet/list prefix:
  //       * `1.` `2.` ... (numeric ordered list)
  //       * `-` `+` `*` `•` (unordered list bullets)
  //   - Either balanced bold `**[BLOCKING]**` OR bare `[BLOCKING]` followed
  //     by non-consuming negative lookahead `(?!\*)`. Lookahead-only
  //     (no lookbehind) for broad ES5+ engine compatibility.
  //
  // Iteration history (consolidated per PR #921 R6 cleanup):
  //   - mt#1486: widened from `**[BLOCKING]**`-only to also accept bare
  //     `[BLOCKING]`, matching production reviewer-bot format.
  //   - PR #921 R1: added balance enforcement (reject one-sided wrappers).
  //   - PR #921 R2: switched from negative lookbehind to start-of-line
  //     anchor (broader engine support; eliminates over-permissive
  //     mid-line matching).
  //   - PR #921 R3: broadened bullet class to include ordered lists and
  //     `+`; switched bare-branch boundary to non-consuming lookahead.
  const matches = body.match(
    /^\s*(?:(?:\d+\.|[-+*•])\s+)?(?:\*\*\[BLOCKING\]\*\*|\[BLOCKING\](?!\*))/gim
  );
  return matches?.length ?? 0;
}

/**
 * Best-effort count of prior findings acknowledged as addressed in a review body.
 *
 * Looks for lines or phrases indicating the reviewer acknowledged that a prior
 * finding is now resolved. Matches common patterns the model uses when following
 * the SC-3 convergence-discipline instruction ("use Prior Reviews to bound findings").
 *
 * Heuristic — matches phrases like:
 *   - "previously raised ... now addressed"
 *   - "acknowledged as addressed"
 *   - "prior finding ... resolved"
 *   - "finding from iteration ... has been addressed"
 *   - "concern ... addressed in this commit"
 *
 * Returns 0 on extraction failure. Non-throwing.
 */
export function countAcknowledgedFindings(body: string): number {
  if (!body.trim()) return 0;
  // Match lines or sentence fragments that explicitly acknowledge prior findings as resolved.
  // Uses multiple simpler patterns joined for readability and correctness.
  // Pattern classes:
  //   A) "acknowledged as addressed" (direct acknowledgement phrase)
  //   B) "prior finding[s] ... now resolved/addressed" (with arbitrary words in between)
  //   C) "finding[s] from iteration/prior N has been addressed"
  //   D) "previously raised ... is now resolved/addressed/fixed"
  //   E) "concern ... addressed/resolved/fixed in this/the commit"
  const patterns = [
    /\backnowledge[ds]?\s+as\s+addressed\b/i,
    /\bprior\s+finding[s]?.{0,60}(?:now\s+)?(?:resolved|addressed)\b/i,
    /\bfinding[s]?\s+from\s+(?:iteration|prior|previous)\s+\d+\s+(?:has\s+been|have\s+been|(?:is|are))\s+addressed\b/i,
    /\bpreviously\s+raised\b.{0,80}(?:is\s+now|now\s+)(?:resolved|addressed|fixed)\b/i,
    /\bconcern\b.{0,80}(?:addressed|resolved|fixed)\s+in\s+(?:this|the)\s+commit\b/i,
  ];
  let count = 0;
  for (const pattern of patterns) {
    const matches = body.match(new RegExp(pattern.source, "gi"));
    count += matches?.length ?? 0;
  }
  return count;
}

/**
 * Max total characters the rendered markdown summary may occupy.
 *
 * Sized for ~10 round PRs at ~2.5K chars/iteration without truncation. The
 * original budget was 3000 chars (mt#1189), but the mt#1429 diagnostic showed
 * that long-iteration PRs (5+ rounds, e.g. PR #732) routinely exceeded it,
 * dropping the oldest iterations and leaving the model without the original
 * NON-BLOCKING classifications that the severity-monotonicity rule
 * (prompt.ts Principle 8) is meant to anchor against. gpt-5's 400K-token
 * context makes 30K chars (~7.5K tokens, ~2% of context) a trivial fraction
 * of the prompt budget — far cheaper than the substrate it preserves.
 *
 * The cap is still useful as a runaway guard for pathological cases (100+
 * iterations) but should not bite on normal PR review cycles.
 */
const MAX_SUMMARY_CHARS = 30000;

/**
 * Summarize a list of prior bot reviews for prompt injection.
 *
 * @param reviews   The prior reviews, already filtered to bot reviews and
 *                  sorted ascending by submittedAt (oldest first).
 * @param currentHeadSha  The PR's current HEAD commit SHA, used to determine
 *                        which reviews are stale (posted against an older commit).
 */
export function summarizePriorReviews(
  reviews: PriorReview[],
  currentHeadSha: string
): PriorReviewSummary {
  if (reviews.length === 0) {
    return { iterationCount: 0, reviews: [], markdown: "" };
  }

  const entries: PriorReviewEntry[] = reviews.map((r, idx) => ({
    iteration: idx + 1,
    commitId: r.commitId,
    state: r.state,
    submittedAt: r.submittedAt,
    isStale: r.commitId !== currentHeadSha,
    findingsMarkdown: extractFindings(r.body),
  }));

  const markdown = renderSummary(entries);

  return {
    iterationCount: entries.length,
    reviews: entries,
    markdown,
  };
}

/**
 * Render the summary as markdown for prompt injection.
 * Truncates older iterations first if the total exceeds MAX_SUMMARY_CHARS.
 */
function renderSummary(entries: PriorReviewEntry[]): string {
  // Build each iteration block
  const blocks = entries.map((e) => renderIterationBlock(e));

  // Check if full render fits within the character budget
  const fullRender = buildFullMarkdown(blocks, entries.length);
  if (fullRender.length <= MAX_SUMMARY_CHARS) {
    return fullRender;
  }

  // Truncate older iterations until we fit. Always keep the newest (last) iteration.
  // Work from oldest to newest, dropping blocks until we fit.
  let droppedCount = 0;
  let remaining = [...blocks];

  while (remaining.length > 1) {
    // Drop the oldest remaining block (index 0 in the remaining array)
    remaining = remaining.slice(1);
    droppedCount++;
    const candidate = buildFullMarkdown(remaining, entries.length, droppedCount);
    if (candidate.length <= MAX_SUMMARY_CHARS) {
      return candidate;
    }
  }

  // Even with only the newest block it might still be over budget — truncate the block itself.
  const singleBlock = remaining[0] ?? "";
  const header = `## Prior Reviews (${entries.length} iteration${entries.length !== 1 ? "s" : ""})\n\n`;
  const omitNote =
    droppedCount > 0
      ? `*(${droppedCount} older iteration${droppedCount !== 1 ? "s" : ""} omitted)*\n\n`
      : "";
  const budget = MAX_SUMMARY_CHARS - header.length - omitNote.length - 20; // 20 char margin
  const truncatedBlock =
    singleBlock.length > budget
      ? `${safeTruncate(singleBlock, budget, "head")}\n…(truncated)`
      : singleBlock;

  return `${header}${omitNote}${truncatedBlock}`;
}

function buildFullMarkdown(blocks: string[], totalCount: number, droppedCount: number = 0): string {
  const header = `## Prior Reviews (${totalCount} iteration${totalCount !== 1 ? "s" : ""})\n\n`;
  const omitNote =
    droppedCount > 0
      ? `*(${droppedCount} older iteration${droppedCount !== 1 ? "s" : ""} omitted)*\n\n`
      : "";
  return `${header}${omitNote}${blocks.join("\n\n---\n\n")}`;
}

function renderIterationBlock(entry: PriorReviewEntry): string {
  const staleMarker = entry.isStale ? " *(stale — posted against an older commit)*" : "";
  const lines: string[] = [
    `### Iteration ${entry.iteration}${staleMarker}`,
    `- **State**: ${entry.state}`,
    `- **Commit**: \`${entry.commitId.slice(0, 8)}\``,
    `- **Submitted**: ${entry.submittedAt}`,
    "",
    "**Findings:**",
    "",
    entry.findingsMarkdown || "*(no findings extracted)*",
  ];
  return lines.join("\n");
}
