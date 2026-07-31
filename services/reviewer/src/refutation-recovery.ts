/**
 * Refutation-aware re-assertion recovery (mt#2836).
 *
 * Pure post-process pass over the model's `submit_finding` tool calls that
 * downgrades a BLOCKING finding to NON-BLOCKING when:
 *
 *   1. The finding has been re-asserted at the same location with an
 *      equivalent summary across at least two PRIOR review rounds
 *      (`MIN_REASSERTION_COUNT_FOR_DOWNGRADE`), AND
 *   2. A commit pushed since the last review contains text that plausibly
 *      refutes the finding (topic-level overlap with the finding's own
 *      text), AND
 *   3. The CURRENT round's finding text shows no engagement with that
 *      refutation's DISTINCTIVE content — no quote, no counter-argument,
 *      just a verbatim (or near-verbatim) re-assertion of the original claim.
 *
 * A finding the author never responded to (no commit overlaps its topic at
 * all) never downgrades — only genuine, ignored counter-evidence triggers
 * this pass.
 *
 * ## Origin
 *
 * mt#2789 / PR #1942 (the Postgres `GREATEST` incident, 2026-07-15):
 * `minsky-reviewer[bot]` blocked THREE consecutive rounds on the same
 * factually-incorrect claim — that Postgres `GREATEST` returns NULL when any
 * argument is NULL (MySQL semantics, not Postgres). R1's response added docs
 * citations + regression tests; R2's response added an empirical PG17 psql
 * transcript directly refuting the claim, in the commit message AND a code
 * comment at the SQL call site. R3 re-asserted the identical claim with no
 * counter-evidence and no acknowledgment of the refutation. Convergence
 * required an audited `forceBypass` merge.
 *
 * ## Design decision (settled at plan time, 2026-07-16)
 *
 * DOWNGRADE, not operator escalation. Operator escalation would reinsert the
 * principal into the per-PR loop (contra `decision-defaults.mdc §User does
 * not review PRs`); the observed failure class is model error, not author
 * error. The `disputed` marker keeps the audit signal without blocking
 * convergence.
 *
 * ## Matcher (deliberately simple)
 *
 * Finding identity = same file + line within `LINE_PROXIMITY` of a prior
 * finding's cited line + summary/details token-overlap above
 * `SUMMARY_SIMILARITY_THRESHOLD`. These are plain-text heuristics, not
 * semantic understanding — by design (a structural recovery layer must be
 * auditable and cheap; see severity-recovery.ts's module doc for the same
 * rationale). False negatives (a genuine engagement that happens to share
 * few tokens with the commit message) fail safe: the finding stays BLOCKING.
 *
 * Distinguishing "the commit discusses this finding's topic" (refutation
 * detection) from "the model engaged with the SPECIFIC evidence" (engagement)
 * matters because both checks would otherwise run over the same shared
 * topic vocabulary (e.g. "GREATEST", "NULL") and agree trivially. Engagement
 * is therefore checked against the commit's DISTINCTIVE tokens only — the
 * tokens that appear in the refuting commit but were never part of the
 * finding's own prior-round text. A verbatim re-assertion, by construction,
 * shares none of those distinctive tokens.
 *
 * Pure function — no I/O, no async, no GitHub API.
 */

import { safeTruncate } from "@minsky/shared/safe-truncate";
import type { ReviewToolCall, SubmitFindingArgs } from "./output-tools";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single finding parsed out of a previously-posted review body, with its text. */
export interface FlatFindingWithText {
  file: string;
  severity: "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING";
  line: number;
  lineEnd?: number;
  summary: string;
  /** The finding's `details` line, if present. Empty string when absent. */
  details: string;
}

/** Audit-log entry produced for each finding downgraded by this pass. */
export interface RefutationDowngradeAuditEntry {
  file: string;
  line: number;
  lineEnd?: number;
  fromSeverity: "BLOCKING";
  toSeverity: "NON-BLOCKING";
  /** Number of PRIOR rounds a matching BLOCKING finding was found in. */
  reassertionCount: number;
  /** reassertionCount + 1 (the current round) — the "N rounds" in the marker text. */
  totalRounds: number;
  /** Truncated excerpt of the commit message judged to be the refutation. */
  refutationExcerpt: string;
  reason: string;
}

export interface RefutationRecoveryResult {
  /** Same length/order as input; only `submit_finding` severities may differ. */
  toolCalls: ReviewToolCall[];
  downgrades: RefutationDowngradeAuditEntry[];
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Max line-number distance for two findings to be considered "the same location". */
export const LINE_PROXIMITY = 5;

/** Min token-overlap ratio for two finding summaries to be considered equivalent. */
export const SUMMARY_SIMILARITY_THRESHOLD = 0.35;

/** Min token-overlap ratio between a finding's text and commit-message text to count as "on topic". */
export const REFUTATION_SIMILARITY_THRESHOLD = 0.12;

/** Min number of the refutation's DISTINCTIVE tokens the current finding text must share to count as "engaged". */
export const ENGAGEMENT_MIN_SHARED_DISTINCTIVE_TOKENS = 2;

/** A finding must recur in at least this many PRIOR rounds before this pass considers downgrading it. */
export const MIN_REASSERTION_COUNT_FOR_DOWNGRADE = 2;

// ---------------------------------------------------------------------------
// Parsing: extract findings-with-text from a posted review body
// ---------------------------------------------------------------------------

/**
 * Parse structured findings (with summary + details text) out of a review
 * body posted by `composeReviewBody` (compose-review.ts). Matches ONLY that
 * module's deterministic own-format:
 *
 * ```
 * - [SEVERITY] file:line[-lineEnd][ (LEFT)] — summary
 *   details
 * ```
 *
 * This module operates exclusively on the bot's own prior review bodies
 * (self-authored, deterministic), so — unlike severity-recovery.ts's
 * `parsePriorBodyFindings` — it does not need to tolerate hand-written or
 * bold-wrapped formats.
 */
export function parseFindingsWithText(body: string): FlatFindingWithText[] {
  if (!body.trim()) return [];

  const lines = body.split("\n");
  const out: FlatFindingWithText[] = [];
  const findingLineRe =
    /^-\s*\[(BLOCKING|NON-BLOCKING|PRE-EXISTING)\]\s+(\S+?):(\d+)(?:-(\d+))?(?:\s+\(LEFT\))?\s+—\s+(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = line.match(findingLineRe);
    if (!match) continue;

    const severityRaw = match[1];
    const file = match[2];
    const lineRaw = match[3];
    const lineEndRaw = match[4];
    const summary = match[5];
    if (!severityRaw || !file || !lineRaw || summary === undefined) continue;

    // compose-review.ts always emits exactly one `  ${details}` line
    // immediately after each finding line.
    const detailsLine = lines[i + 1] ?? "";
    const details = detailsLine.startsWith("  ") ? detailsLine.trim() : "";

    out.push({
      file,
      severity: severityRaw as FlatFindingWithText["severity"],
      line: parseInt(lineRaw, 10),
      ...(lineEndRaw ? { lineEnd: parseInt(lineEndRaw, 10) } : {}),
      summary: summary.trim(),
      details,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Token similarity helpers
// ---------------------------------------------------------------------------

/**
 * Low-value words excluded from token sets so similarity scores reflect
 * substantive overlap rather than shared grammar.
 */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "in",
  "on",
  "for",
  "and",
  "or",
  "but",
  "this",
  "that",
  "it",
  "its",
  "as",
  "at",
  "by",
  "with",
  "from",
  "not",
  "no",
  "when",
  "which",
  "will",
  "would",
  "should",
  "could",
  "must",
  "can",
  "has",
  "have",
  "had",
  "does",
  "do",
  "did",
  "than",
  "then",
  "so",
  "if",
  "into",
  "per",
  "any",
  "all",
  "each",
  "such",
  "here",
  "there",
  "you",
  "your",
  "still",
  "also",
]);

/** Tokenize free text into a lowercase, stopword-filtered set for overlap comparison. */
export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[`*_#[\](){}]/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Intersection size / min(|a|, |b|) — 0 when either set is empty. */
export function tokenOverlapRatio(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / Math.min(a.size, b.size);
}

/** Count of tokens present in both sets. */
function intersectionCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const t of a) if (b.has(t)) count++;
  return count;
}

/** a \ b — tokens present in `a` but not `b`. */
function setDifference(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const t of a) if (!b.has(t)) out.add(t);
  return out;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Finding-identity matching
// ---------------------------------------------------------------------------

/**
 * True when two findings are "the same finding" across rounds: same file,
 * line within `LINE_PROXIMITY`, and summary token-overlap above
 * `SUMMARY_SIMILARITY_THRESHOLD`.
 *
 * Exported for unit testing.
 */
export function matchesFindingIdentity(
  a: { file: string; line: number; summary: string },
  b: { file: string; line: number; summary: string }
): boolean {
  if (normalizePath(a.file) !== normalizePath(b.file)) return false;
  if (Math.abs(a.line - b.line) > LINE_PROXIMITY) return false;
  const similarity = tokenOverlapRatio(tokenize(a.summary), tokenize(b.summary));
  return similarity >= SUMMARY_SIMILARITY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply refutation-aware re-assertion recovery to a list of model tool calls.
 *
 * @param toolCalls                     The current round's raw tool calls.
 * @param priorReviewBodies             Sanitized prior review bodies for this
 *                                       PR, oldest round first.
 * @param commitMessagesSinceLastReview Commit messages pushed since the most
 *                                       recent prior review (empty when none,
 *                                       or when this is the first round).
 */
export function applyRefutationRecovery(
  toolCalls: ReadonlyArray<ReviewToolCall>,
  priorReviewBodies: ReadonlyArray<string>,
  commitMessagesSinceLastReview: ReadonlyArray<string>
): RefutationRecoveryResult {
  const priorRoundFindings = priorReviewBodies.map((body) => parseFindingsWithText(body));

  const combinedCommitText = commitMessagesSinceLastReview.join("\n");
  const commitTokens = tokenize(combinedCommitText);

  const corrected: ReviewToolCall[] = [];
  const downgrades: RefutationDowngradeAuditEntry[] = [];

  for (const tc of toolCalls) {
    if (tc.name !== "submit_finding" || tc.args.severity !== "BLOCKING") {
      corrected.push(tc);
      continue;
    }

    const current = { file: tc.args.file, line: tc.args.line, summary: tc.args.summary };

    // Count DISTINCT prior rounds containing a matching BLOCKING finding, and
    // accumulate the union of those findings' own text (used below to find
    // what's DISTINCTIVE about the refuting commit vs. what's already been
    // said in the finding's own history).
    let reassertionCount = 0;
    let priorFindingTokens = new Set<string>();
    for (const roundFindings of priorRoundFindings) {
      const match = roundFindings.find(
        (f) => f.severity === "BLOCKING" && matchesFindingIdentity(current, f)
      );
      if (match) {
        reassertionCount++;
        const matchTokens = tokenize(`${match.summary} ${match.details}`);
        priorFindingTokens = new Set([...priorFindingTokens, ...matchTokens]);
      }
    }

    if (reassertionCount < MIN_REASSERTION_COUNT_FOR_DOWNGRADE) {
      corrected.push(tc);
      continue;
    }

    // Refutation-in-context: does the commit history since the last review
    // discuss this finding's topic at all?
    const currentTokens = tokenize(`${tc.args.summary} ${tc.args.details}`);
    const refutationScore = tokenOverlapRatio(currentTokens, commitTokens);
    if (
      commitMessagesSinceLastReview.length === 0 ||
      refutationScore < REFUTATION_SIMILARITY_THRESHOLD
    ) {
      // Never responded to (or the commit history is unrelated) — per the
      // settled design decision, this finding never downgrades.
      corrected.push(tc);
      continue;
    }

    // Engagement: does the CURRENT finding's own text reference content that
    // is DISTINCTIVE to the refuting commit (not already part of the
    // finding's own prior-round text)? A verbatim re-assertion shares none
    // of this distinctive vocabulary by construction.
    const distinctiveCommitTokens = setDifference(commitTokens, priorFindingTokens);
    const engagementOverlap = intersectionCount(currentTokens, distinctiveCommitTokens);
    if (
      distinctiveCommitTokens.size > 0 &&
      engagementOverlap >= ENGAGEMENT_MIN_SHARED_DISTINCTIVE_TOKENS
    ) {
      // The model referenced the specific refutation evidence in its own
      // words and (per its own judgment) still disagrees — trust it.
      corrected.push(tc);
      continue;
    }

    // >=2nd re-assertion, refutation was in context, finding text does not
    // engage it — downgrade per the settled design decision (mt#2836).
    const totalRounds = reassertionCount + 1;
    const marker = `disputed — refutation unaddressed after ${totalRounds} rounds`;

    // Pick the individual commit message with the highest topical overlap
    // against the finding for a readable audit excerpt (the gating decision
    // above uses the combined blob; this is presentation only).
    let bestMessage = commitMessagesSinceLastReview[0] ?? "";
    let bestMessageScore = -1;
    for (const message of commitMessagesSinceLastReview) {
      const score = tokenOverlapRatio(currentTokens, tokenize(message));
      if (score > bestMessageScore) {
        bestMessageScore = score;
        bestMessage = message;
      }
    }
    const refutationExcerpt = safeTruncate(bestMessage, 240, "head");

    const downgradedArgs: SubmitFindingArgs = {
      ...tc.args,
      severity: "NON-BLOCKING",
      summary: `${tc.args.summary} [${marker}]`,
      details:
        `${tc.args.details}\n\n_${marker}. Refutation evidence in a commit since the prior ` +
        `review was not engaged in this round's finding text. Commit excerpt: ` +
        `"${refutationExcerpt}"_`,
    };
    corrected.push({ name: "submit_finding", args: downgradedArgs });
    downgrades.push({
      file: tc.args.file,
      line: tc.args.line,
      ...(tc.args.lineEnd !== undefined ? { lineEnd: tc.args.lineEnd } : {}),
      fromSeverity: "BLOCKING",
      toSeverity: "NON-BLOCKING",
      reassertionCount,
      totalRounds,
      refutationExcerpt,
      reason:
        `refutation-recovery: finding at "${tc.args.file}:${tc.args.line}" re-asserted across ` +
        `${totalRounds} rounds; refutation evidence in commit history since the prior review ` +
        `(topical overlap ${refutationScore.toFixed(2)}) was not engaged in this round's finding text`,
    });
  }

  return { toolCalls: corrected, downgrades };
}
