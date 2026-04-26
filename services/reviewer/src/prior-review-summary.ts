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
    // Take until the next ### header (or end of string)
    const nextHeader = afterHeader.slice(afterHeader.indexOf("\n") + 1).search(/^###\s/m);
    if (nextHeader >= 0) {
      // +1 for the newline after the header line
      const headerLineLen = afterHeader.indexOf("\n") + 1;
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
    if (/\*\*\[(BLOCKING|NON-BLOCKING|PRE-EXISTING)\]\*\*/i.test(line)) {
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
  return body.length > 1000 ? `${body.slice(0, 1000)}\n…(truncated)` : body;
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
  const matches = body.match(/\*\*\[BLOCKING\]\*\*/gi);
  return matches?.length ?? 0;
}

/** Max total characters the rendered markdown summary may occupy. */
const MAX_SUMMARY_CHARS = 3000;

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
    singleBlock.length > budget ? `${singleBlock.slice(0, budget)}\n…(truncated)` : singleBlock;

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
