/**
 * Session PR Wait-For-Review Subcommand (mt#1203)
 *
 * Blocks until a matching review appears on the session's pull request, or
 * a timeout elapses. Uses polling under the hood; the tool is the transport
 * primitive that mt#1180's Ask subsystem composes for its `quality.review`
 * resolution.
 *
 * Resolution criteria: a review on the PR with `submittedAt > since`
 * (strictly after — an exactly-equal `submittedAt` counts as already-seen,
 * mt#2656), optionally filtered by reviewer login. When several reviews pass
 * those filters, the one returned is the reviewer's STANDING VERDICT — their
 * latest decision-bearing review — not the first in listing order
 * (mt#3555); see `findMatchingReview`.
 *
 * `since` default (mt#2043): the PR's `created_at` timestamp, looked up via
 * `ReviewOperations.getPullRequestCreatedAt`. Pre-existing reviews on the
 * PR match by default. Backends that don't implement the lookup fall back
 * to the call's start time (the pre-mt#2043 behavior). Explicit
 * `params.since` continues to take precedence with no backend call.
 *
 * On timeout, the result payload includes `lastSeenReviews` (annotated
 * with per-entry `rejectionReason`) and `sinceUsed` (the resolved
 * threshold) so callers can diagnose the miss class without a separate
 * forensics round-trip (mt#2043).
 *
 * By default (mt#2656) a matched review is returned TRIMMED — state,
 * submittedAt, reviewer, blocking/non-blocking finding counts, and a
 * findings list (severity + file:line + one-sentence summary each) —
 * stripping the raw markdown body (spec-verification tables, the embedded
 * provenance JSON comment, full finding prose), which otherwise runs
 * 5-10KB per review. Pass `params.fullBody: true` to restore the full
 * `ReviewListEntry` (pre-mt#2656 behavior).
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import type { SessionProviderInterface } from "../types";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../errors/index";
import { log } from "@minsky/shared/logger";
import type { RepositoryBackend, ReviewListEntry } from "../../repository/index";
import {
  type ReviewVerdictFields,
  pickLatestDecisionPerReviewer,
  pickLatestSubmitted,
} from "../../repository/review-verdict";
import { createRepositoryBackendFromSession } from "../session-pr-operations";
import type { TokenProvider, TokenRole } from "../../auth/token-provider";
import { withDeadline, DeadlineExceededError } from "../../utils/deadline";
import { DEFAULT_CHECK_RUN_NAME } from "./pr-check-run-submit-subcommand";

export interface SessionPrWaitForReviewDependencies {
  sessionDB: SessionProviderInterface;
  /** Test seam: override backend creation. Defaults to the session-derived backend. */
  createBackend?: (
    sessionRecord: Parameters<typeof createRepositoryBackendFromSession>[0],
    sessionDB: SessionProviderInterface
  ) => Promise<RepositoryBackend>;
  /** Test seam: override the clock. Defaults to Date.now. */
  now?: () => number;
  /** Test seam: override the delay between polls. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Test seam: override the TOTAL budget for the mt#2777 SC#1 final
   * authoritative check. Defaults to `FINAL_CHECK_DEADLINE_MS` (10s).
   *
   * Exists for tests that must run the final check against REAL timers
   * (`now`/`sleep` left un-stubbed, because the point is to prove a real
   * `setTimeout`-based deadline bounds a stalled call). Such a test otherwise
   * has to spend the full production budget in wall-clock time: the mt#3551
   * instance sat at ~11s against bun's 15s per-test ceiling, and already
   * failed outright under bun's 5s DEFAULT — which is what any invocation
   * that omits `--timeout` gets. Shrinking the budget keeps the real timer
   * and drops the cost.
   *
   * Not a production knob: no CLI/MCP parameter maps to it, which is why it
   * lives here rather than on `SessionPrWaitForReviewParams`.
   */
  finalCheckDeadlineMs?: number;
  /**
   * Test seam: override the TokenProvider used for role resolution
   * (`reviewer: "reviewer" | "implementer"`). Defaults to a provider
   * constructed from runtime config the same way `pr-review-context-subcommand`
   * builds one. Pure literal-login filters do not consult this seam.
   */
  getTokenProvider?: () => Promise<TokenProvider>;
  /**
   * mt#2677: optional progress callback, invoked once per poll iteration
   * (right before sleeping, when no match was found on that poll). Lets a
   * long review-wait produce MCP transport activity — via the caller's
   * `context.onProgress` (see `src/mcp/server.ts`'s progress-notification
   * wiring) — so a legitimate multi-minute wait doesn't look identical, from
   * the harness's idle-timeout perspective, to a genuine hang. A no-op when
   * omitted (the CLI interface, or an MCP caller that didn't request
   * progress notifications via `_meta.progressToken`).
   */
  onProgress?: (message: string) => void;
}

export interface SessionPrWaitForReviewParams {
  sessionId?: string;
  task?: string;
  repo?: string;
  /** Max seconds to wait (default 600; capped at 1800 by the parameter schema). */
  timeoutSeconds?: number;
  /** Polling interval in seconds (default 15). Clamped to [5, 60] internally. */
  intervalSeconds?: number;
  /**
   * Optional reviewer filter. Accepts either:
   *
   * - A **TokenRole identifier** (`"reviewer"` or `"implementer"`,
   *   case-insensitive). Resolved at call setup against the configured GitHub
   *   App service-account identity via `TokenProvider.getServiceIdentity`.
   *   When the corresponding role is not configured (e.g. `reviewer` without
   *   `github.reviewer.serviceAccount`), throws a typed error naming the
   *   missing config key — no silent fallback.
   *
   * - A **literal GitHub login** (e.g. `"minsky-reviewer[bot]"` or the bare
   *   `"minsky-reviewer"` form, or any human reviewer's login).
   *   Case-insensitive; a trailing `[bot]` suffix is optional on both sides
   *   of the comparison.
   *
   * Precedence: the exact case-insensitive strings `"reviewer"` and
   *   `"implementer"` are reserved role identifiers. A human reviewer whose
   *   GitHub login happens to be one of those names (extremely unusual) can
   *   disambiguate by passing the `[bot]`-suffixed or owner-prefixed form.
   */
  reviewer?: string;
  /**
   * Optional ISO timestamp; reviews with submittedAt earlier than OR EQUAL
   * TO this are ignored (strictly-after semantics, mt#2656) — passing a
   * prior review's exact `submittedAt` as `since` will not re-match that
   * same review. Defaults to the PR's `created_at` timestamp (mt#2043), so
   * pre-existing reviews on the PR match by default. Pass an explicit value
   * to narrow the window (e.g., wait only for reviews newer than a known
   * stale one — the standard re-invoke pattern after a CHANGES_REQUESTED
   * fix: pass the previous review's `submittedAt` and the wait will not
   * re-match it).
   *
   * Backwards-compat note: prior to mt#2043 the default was the call's
   * start time, which silently excluded reviews posted before the wait was
   * invoked. The new default is structurally more useful for the typical
   * post-PR-create wait pattern. Backends that don't implement
   * `ReviewOperations.getPullRequestCreatedAt` fall back to call-start.
   *
   * Boundary note (mt#2656): prior to mt#2656 the comparison was inclusive
   * (`submittedAt >= since`), so passing a previous review's exact
   * `submittedAt` as `since` re-matched that same review — hit live on
   * PR #1811, worked around with a manual `+1s` adjustment. The comparison
   * is now strictly-after.
   */
  since?: string;
  /**
   * When true, return the full `ReviewListEntry` (raw markdown body,
   * including the spec-verification table and embedded provenance JSON
   * comment) instead of the default trimmed payload (mt#2656). Defaults to
   * false — most callers only need state/counts/findings to decide the next
   * step; use this when you need the full review prose (e.g. to quote it
   * back to a human).
   */
  fullBody?: boolean;
  /**
   * When true (the default), only a review whose commit SHA matches the PR's
   * current HEAD satisfies the wait. A stale review of a superseded commit is
   * skipped, so a re-review cycle (pushing a fix after `CHANGES_REQUESTED`)
   * waits for the fresh verdict instead of immediately returning the pre-fix
   * one (mt#2586). Set `false` to accept any review regardless of commit (the
   * pre-mt#2586 behavior). Ignored on backends that don't implement
   * `getPullRequestHeadSha` (the wait falls back to the `since` filter).
   */
  requireCurrentHead?: boolean;
  /**
   * The commit the caller expects the REMOTE to be serving — normally the
   * `commitHash` that `session_commit` just returned (mt#3877).
   *
   * {@link requireCurrentHead} cannot cover this case, and the reason is worth
   * being precise about: it compares a review against the remote's CURRENT
   * head, so in the window before a push lands, the superseded commit genuinely
   * IS that head and the stale review is admitted by exactly the filter meant
   * to exclude it. The window is routine rather than exotic — `session_commit`
   * runs the full suite in pre-commit and regularly exceeds the 120s MCP tool
   * timeout, at which point it is backgrounded and finishes its push a minute
   * later.
   *
   * When set, no review is considered while the remote head differs from this
   * sha; the wait keeps polling instead. That is deliberately stronger than
   * refusing to match: refusing alone turns a wasted review round into a
   * confusing empty result, whereas waiting turns it into the correct one — the
   * push lands and the real review is what the caller gets. On timeout the
   * diagnostic names the sha the remote never reached, so an exhausted wait is
   * actionable rather than mysterious.
   *
   * Opt-in by design. Local and remote HEAD legitimately differ for waits
   * driven from a different workspace than the one that pushed, so resolving
   * this automatically would hang those waits; the one call site that holds the
   * intent passes it explicitly. Ignored when the backend does not implement
   * `getPullRequestHeadSha`, or when `requireCurrentHead: false` opts out of
   * head resolution entirely — there is no remote head to compare against in
   * either case.
   */
  expectedHeadSha?: string;
}

/**
 * Git's documented default minimum abbreviation length (`core.abbrev`).
 *
 * A shorter prefix is refused rather than matched: at 4 characters a prefix
 * collides across a real repository's history often enough that "the remote is
 * serving my commit" would stop being a claim about MY commit.
 */
export const MIN_ABBREVIATED_SHA_LENGTH = 7;

/**
 * Does the remote head satisfy the caller's `expectedHeadSha`?
 *
 * PREFIX-anchored, not equality (mt#4039). `session_commit` returns
 * `commitHash` in ABBREVIATED form and `/implement-task` §9 tells callers to
 * pass that value through verbatim — while the remote head is always the full
 * 40 characters. A strict `===` therefore never matched for any caller
 * following the documented flow: every real review was suppressed with
 * `push-not-landed` and the wait ran to timeout, which is the exact wasted
 * round mt#3877 added this filter to prevent. Observed on PR #2914, where two
 * genuine reviews sat unread for 900s and the identical wait matched in 128s
 * once the sha was expanded by hand.
 *
 * Undefined on either side means "no opinion" and matches, preserving the
 * opt-in semantics: no `expectedHeadSha` is no filter, and an unresolved remote
 * head (backend without `getPullRequestHeadSha`, or `requireCurrentHead:
 * false`) has nothing to compare against.
 */
export function headShaMatchesExpected(
  headSha: string | undefined,
  expectedHeadSha: string | undefined
): boolean {
  if (expectedHeadSha === undefined || headSha === undefined) return true;

  const expected = expectedHeadSha.trim().toLowerCase();
  const head = headSha.trim().toLowerCase();

  // Too short to identify a commit — never match. The command layer rejects
  // this up front with a clear error; this branch is the defense in depth, so
  // a caller reaching the matcher by another path cannot match promiscuously.
  if (expected.length < MIN_ABBREVIATED_SHA_LENGTH) return false;
  // A value longer than the head cannot be a prefix of it.
  if (expected.length > head.length) return false;

  return head.startsWith(expected);
}

/**
 * How a FAILED `expectedHeadSha` match should be read (mt#4995).
 *
 * - `push-pending` — the expected sha and the observed head have essentially
 *   nothing in common, which is what a commit still in flight looks like: the
 *   remote is serving some earlier commit and the caller's will arrive. Waiting
 *   resolves it, so the wait keeps polling. This is the case mt#3877 added the
 *   filter for and mt#4039 kept working.
 * - `divergent-prefix` — the two share a long common prefix and then diverge.
 *   A commit still in flight does not do that; a caller who started from a real
 *   ABBREVIATED sha and extended it to look like a full one does exactly that.
 *   Waiting can never resolve it, because the value names no commit.
 */
export type HeadShaMismatchKind = "push-pending" | "divergent-prefix";

/**
 * Length of the common leading run of two normalized shas.
 */
function sharedPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) shared += 1;
  return shared;
}

/**
 * Classify a failed `expectedHeadSha` match, or `null` when there is nothing to
 * classify — the values match, or either side is absent so no comparison is
 * possible (a backend without `getPullRequestHeadSha`, or `requireCurrentHead:
 * false`).
 *
 * WHY A THRESHOLD OF `MIN_ABBREVIATED_SHA_LENGTH` (7), AND WHY THAT IS SAFE.
 * Two UNRELATED commits sharing a 7-hex-character prefix is one chance in
 * 16^7 = 268,435,456. The comparison only ever runs on hexadecimal values —
 * `sessionPrWaitForReview` rejects a non-hex `expectedHeadSha` at its boundary
 * — so the digits really are drawn from that alphabet, and SHA-1 output is
 * uniform enough over a repository's history for the estimate to hold. Reusing
 * git's own abbreviation floor rather than inventing a second constant also
 * keeps one number to reason about: below 7 the matcher refuses to match at
 * all, and at or above 7 a shared prefix is evidence of a shared ORIGIN rather
 * than of coincidence.
 *
 * The residual false NEGATIVE is deliberate and is why the default is the
 * conservative branch: a fabricated sha extending an OLDER head's abbreviation,
 * on a PR whose head has since advanced, shares ~0 characters with the CURRENT
 * head and is therefore reported as `push-pending`. That degrades to exactly
 * today's behaviour (the wait runs its course) rather than to a wrong verdict,
 * and catching it would mean retaining head history this wait does not keep.
 * The same reasoning covers a sha stranded by a rebase (mem#1013): its cause is
 * fixed upstream by mt#4046, and here it is simply not the shared-prefix shape.
 */
export function classifyHeadShaMismatch(
  headSha: string | undefined,
  expectedHeadSha: string | undefined
): HeadShaMismatchKind | null {
  if (headShaMatchesExpected(headSha, expectedHeadSha)) return null;
  // `headShaMatchesExpected` returns true when either side is undefined, so
  // reaching here guarantees both are present; the guards keep that a compile
  // -time fact rather than an inherited assumption.
  if (expectedHeadSha === undefined || headSha === undefined) return null;

  const expected = expectedHeadSha.trim().toLowerCase();
  const head = headSha.trim().toLowerCase();

  return sharedPrefixLength(expected, head) >= MIN_ABBREVIATED_SHA_LENGTH
    ? "divergent-prefix"
    : "push-pending";
}

export interface SessionPrWaitForReviewMatch {
  matched: true;
  /**
   * By default (mt#2656) a `TrimmedReview` — see that type's doc comment.
   * Pass `params.fullBody: true` to get the full `ReviewListEntry` instead.
   * Discriminate the two shapes structurally: `TrimmedReview` has a
   * `findings` array; `ReviewListEntry` has a `body` string. Neither type
   * has both.
   */
  review: ReviewListEntry | TrimmedReview;
  elapsedMs: number;
  pollCount: number;
}

/**
 * A single finding extracted from the review body's rendered `## Findings`
 * section (see `services/reviewer/src/compose-review.ts`
 * `composeReviewBody`, which renders each finding as a two-line entry:
 * `- [SEVERITY] file:line — summary` followed by a details line). This
 * module only reads the already-rendered markdown — it does not depend on
 * the reviewer service's output-tools schema (mt#2656 scope: consuming-side
 * payload trimming, not reviewer output format).
 */
export interface TrimmedReviewFinding {
  severity: "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING";
  /** `file:line` (or `file:line-lineEnd`), optionally suffixed ` (LEFT)`. */
  location: string;
  /** One-sentence finding summary (the `submit_finding` tool's `summary` arg). */
  summary: string;
}

/**
 * Trimmed review payload (mt#2656): the default shape `session_pr_wait-for-review`
 * / `session_pr_drive` return in place of the full `ReviewListEntry`. The raw
 * `body` (spec-verification table, embedded `minsky-review-provenance` JSON
 * comment, full finding prose — often 5-10KB) is stripped; the fields below
 * carry everything a caller needs to decide the next step. Pass
 * `params.fullBody: true` to get the full `ReviewListEntry` instead.
 */
export interface TrimmedReview {
  reviewId: number;
  state: ReviewListEntry["state"];
  submittedAt?: string;
  reviewerLogin: string | null;
  htmlUrl?: string;
  commitId?: string;
  blockingCount: number;
  nonBlockingCount: number;
  findings: TrimmedReviewFinding[];
}

/**
 * Matches a rendered finding line from `composeReviewBody`:
 *   `- [SEVERITY] location — summary`
 * Non-greedy on `location` so the ` — ` separator (an em dash, matching the
 * reviewer's exact rendering) anchors correctly even if `summary` itself
 * contains a hyphen or dash. The details line that follows each finding
 * does not start with `- [` and is skipped without needing to be matched.
 */
const FINDING_LINE_RE = /^- \[(BLOCKING|NON-BLOCKING|PRE-EXISTING)\] (.+?) — (.+)$/gm;

/**
 * Parse the finding entries out of a rendered review body. Returns an empty
 * array when the body has no `## Findings` section (e.g. a clean APPROVE
 * with zero findings) or isn't in the expected format (e.g. a legacy/manual
 * review body that predates the structured output-tools format).
 *
 * Exported for unit tests.
 */
export function parseReviewFindings(body: string): TrimmedReviewFinding[] {
  const findings: TrimmedReviewFinding[] = [];
  for (const match of body.matchAll(FINDING_LINE_RE)) {
    const [, severity, location, summary] = match;
    if (severity === undefined || location === undefined || summary === undefined) continue;
    findings.push({
      severity: severity as TrimmedReviewFinding["severity"],
      location,
      summary,
    });
  }
  return findings;
}

/**
 * Trim a full `ReviewListEntry` down to the mt#2656 default payload. Finding
 * counts are derived from the parsed findings list (BLOCKING vs. everything
 * else — NON-BLOCKING + PRE-EXISTING — mirroring the convention already
 * used by `services/reviewer/src/review-provenance.ts`'s
 * `extractProvenance`), not from the embedded provenance JSON comment, so
 * this function works even on review bodies without a provenance block.
 *
 * Exported for unit tests and reuse by `pr-drive-subcommand.ts`.
 */
export function trimReview(review: ReviewListEntry): TrimmedReview {
  const findings = parseReviewFindings(review.body);
  let blockingCount = 0;
  let nonBlockingCount = 0;
  for (const finding of findings) {
    if (finding.severity === "BLOCKING") blockingCount++;
    else nonBlockingCount++;
  }
  return {
    reviewId: review.reviewId,
    state: review.state,
    submittedAt: review.submittedAt,
    reviewerLogin: review.reviewerLogin,
    htmlUrl: review.htmlUrl,
    commitId: review.commitId,
    blockingCount,
    nonBlockingCount,
    findings,
  };
}

/**
 * A review entry annotated with the reason it did not match the filter on
 * the wait tool's most recent poll. Returned in `lastSeenReviews` on
 * timeout so callers can see WHY each review on the PR was rejected without
 * a separate `pull_request_read get_reviews` round-trip.
 *
 * Introduced for mt#2043 (diagnostic visibility into wait-tool timeouts).
 */
export interface AnnotatedReview extends ReviewListEntry {
  /**
   * Why the wait-tool's filter rejected this review on the final poll.
   * One of:
   *   - `"state-pending"` — review is in PENDING (draft) state.
   *   - `"missing-submittedAt"` — review has no `submittedAt` timestamp.
   *   - `"unparseable-submittedAt: <value>"` — `submittedAt` could not be parsed.
   *   - `"since: submittedAt <iso> <relation> threshold <iso>"` — review does not
   *     post-date the `since` filter; `<relation>` is `<` (predates) or `==`
   *     (exact boundary — excluded since mt#2656 made `since` strictly-after).
   *   - `"reviewer-mismatch: reviewerLogin <login> != filter <filter>"` — reviewer filter excluded it.
   *
   * `null` is intentionally not possible here — if a review matched, it would
   * have been returned in the `matched: true` payload instead. This field is
   * only populated on the timeout path.
   */
  rejectionReason: string;
}

/**
 * The reviewer findings check-run's state, as observed by the mt#2777 SC#1
 * final authoritative check performed immediately before a timeout is
 * reported. Distinguishes "no check run posted yet" (`status: "absent"`)
 * from a check run that exists but hasn't completed (`"queued"` /
 * `"in_progress"`) or has (`"completed"`, with a `conclusion`) — the
 * originating incident (mt#2751's near-bypass) saw the check flip from
 * absent to `failure` mid-churn while two 600s `listReviews`-only waits
 * reported bare silence.
 */
export interface ReviewerCheckRunState {
  /** Check-run name matched — the configured findings check name (default `minsky-reviewer/findings`). */
  name: string;
  /**
   * Run lifecycle state, mirroring `CheckRunResult.status`
   * (`"completed"` | `"queued"` | `"in_progress"`), plus `"absent"` when no
   * check run with the matched name exists yet on the PR's current HEAD.
   */
  status: string;
  /** Terminal conclusion when `status === "completed"`, else `null`. */
  conclusion: string | null;
  /** Link to the check-run detail page, when available. */
  url: string | null;
}

export interface SessionPrWaitForReviewTimeout {
  matched: false;
  elapsedMs: number;
  pollCount: number;
  /**
   * Reviews returned by the backend on the most recent poll, each annotated
   * with the rejection reason. Empty array means the backend returned no
   * reviews on the final poll (the PR has no reviews at all, or pagination
   * was empty).
   *
   * Introduced for mt#2043: agents can inspect this to diagnose why the wait
   * timed out — e.g., a reviewer-filter mismatch, an old review that the
   * caller's `since` excluded, or a PENDING draft that hasn't been submitted.
   * Replaces the previous diagnostic gap where `{matched: false, elapsedMs,
   * pollCount}` carried zero signal about which filter criterion fired.
   *
   * As of mt#2777 SC#1, this reflects the FINAL authoritative re-read (see
   * `finalCheckPerformed`) when that re-read succeeded — not necessarily the
   * main poll loop's last iteration.
   */
  lastSeenReviews: AnnotatedReview[];
  /**
   * The `since` threshold actually used for the filter on the final poll.
   * Formatted as ISO-8601 with milliseconds (`YYYY-MM-DDTHH:MM:SS.sssZ`)
   * via `Date.prototype.toISOString` — this is the standard JS form and
   * matches what `Date.parse` round-trips losslessly. Note this is
   * fractionally more precise than GitHub's typical `submittedAt` /
   * `created_at` second-precision form; comparison is by millisecond so
   * the extra digits do not affect filter semantics.
   *
   * When the caller passes `params.since`, this reflects the parsed value
   * (so a caller-supplied `2026-05-21T20:00:00Z` becomes
   * `2026-05-21T20:00:00.000Z` here). When the caller passes no `since`,
   * this shows the resolved default (PR `created_at`, or call start when
   * the backend doesn't support PR-time lookup). Surfacing this lets
   * agents quickly see whether the `since`-default did what they expected.
   */
  sinceUsed: string;
  /**
   * mt#3877: set when the caller passed `expectedHeadSha` and the remote
   * never reached it — the wait spent its whole budget on a PR whose head was
   * still the pre-push commit. Carries the last remote head actually observed
   * (`null` if none was ever resolved), so the timeout distinguishes "no
   * review arrived" from "the push never landed", which call for opposite
   * responses: wait longer versus go find out why the push is stuck.
   *
   * Absent (undefined) whenever `expectedHeadSha` was not passed, so an
   * ordinary timeout payload is unchanged.
   *
   * mt#4995: `classification` says WHICH of the two mismatch causes this is,
   * because they call for opposite responses and were previously reported
   * identically. `push-pending` keeps the historical semantics (the wait ran
   * its full budget). `divergent-prefix` means the caller's sha can never
   * arrive, and the wait returned EARLY rather than burning the budget — so on
   * this value `elapsedMs` is deliberately far below the configured timeout.
   *
   * `classification` is NON-NULLABLE by construction (PR #3641 R1): this whole
   * object is present only when the classifier returned a kind, so a consumer
   * reading it has a reliable discriminator rather than one it must null-check.
   * That also makes it the machine-readable signal for "returned early" — a
   * JSON-mode caller distinguishes an early classified return from a genuine
   * waited-out timeout by this field, without parsing the rendered message.
   */
  expectedHeadShaUnreached?: {
    expected: string;
    lastObservedHeadSha: string | null;
    classification: HeadShaMismatchKind;
  };
  /**
   * mt#2777 SC#1: whether the one-time final authoritative reviews-list
   * re-read (performed immediately before reporting this timeout) actually
   * completed. `false` only when the re-read itself failed (backend I/O
   * error, or exceeded its own short deadline) — distinguishes "we
   * re-checked and it's genuinely still not there" from "we could not
   * re-check." When `true`, `lastSeenReviews` and `sinceUsed` reflect the
   * fresh read, not a poll-loop-stale one.
   */
  finalCheckPerformed: boolean;
  /**
   * mt#2777 SC#1: the `minsky-reviewer/findings` check-run's state on the
   * PR's current HEAD, fetched as part of the final authoritative check.
   * `null` when the backend does not implement `ci.getChecksForPR` (a
   * non-GitHub backend) or the fetch itself failed — this signal is
   * best-effort and its absence must never be read as "no check run
   * exists" (that positive claim is `status: "absent"` instead). A caller
   * seeing `status: "in_progress"` or a `failure` conclusion here — while
   * `matched` is still `false` — should treat the reviewer as actively
   * working or already having posted findings via the check-run surface,
   * NOT as silent.
   */
  reviewerCheckRunState: ReviewerCheckRunState | null;
}

export type SessionPrWaitForReviewResult =
  | SessionPrWaitForReviewMatch
  | SessionPrWaitForReviewTimeout;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Normalize a GitHub login for comparison: lowercase, and strip a trailing
 * `[bot]` suffix. GitHub App identities present their login as `<app>[bot]`
 * on the API but agents/operators frequently write the bare `<app>` form
 * (e.g. `minsky-reviewer` vs `minsky-reviewer[bot]`). Treating the two as
 * equivalent for filter purposes matches the principle of least surprise
 * and the convention used in user-facing skill/memory text.
 *
 * Only the trailing `[bot]` is stripped — a login containing `[bot]`
 * mid-string is not normalized, so substring collisions are avoided.
 */
function normalizeReviewerLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, "");
}

/**
 * Config key documented in the typed-error message when a role identifier
 * is passed but the corresponding service account is not configured. Keeps
 * the user-facing remediation pointer in one place.
 */
const REVIEWER_ROLE_CONFIG_KEYS: Record<TokenRole, string> = {
  implementer: "github.serviceAccount",
  reviewer: "github.reviewer.serviceAccount",
};

/**
 * Recognize a `reviewer` param value as a TokenRole identifier
 * (case-insensitive). The two reserved identifiers (`"implementer"`,
 * `"reviewer"`) shadow GitHub logins of the same exact name — see the
 * `SessionPrWaitForReviewParams.reviewer` JSDoc for the precedence rule.
 */
function asRoleIdentifier(value: string): TokenRole | undefined {
  const lower = value.toLowerCase();
  if (lower === "implementer") return "implementer";
  if (lower === "reviewer") return "reviewer";
  return undefined;
}

/**
 * Resolve a `reviewer` filter input to a concrete GitHub login (or
 * `undefined` for no filter). When the input is a TokenRole identifier,
 * consult the TokenProvider to look up the configured App identity; throw
 * a typed `MinskyError` naming the missing config key when the role is
 * not configured. When the input is a literal login, pass it through
 * unchanged — the downstream `findMatchingReview` handles `[bot]`
 * normalization on its own.
 *
 * Exported for unit tests so the role-resolution branch can be exercised
 * independently of the polling loop.
 */
export async function resolveReviewerFilter(
  reviewer: string | undefined,
  getTokenProvider: () => Promise<TokenProvider>
): Promise<string | undefined> {
  if (reviewer === undefined) return undefined;

  const role = asRoleIdentifier(reviewer);
  if (role === undefined) {
    // Literal-login path — pass through to `findMatchingReview`, which
    // applies `[bot]` normalization symmetrically on both sides.
    return reviewer;
  }

  // Acquire the TokenProvider. Wrap any acquisition failure (e.g.
  // `getConfiguration()` throwing "Configuration not initialized." when
  // invoked outside the normal CLI bootstrap) into a typed MinskyError
  // that names the role context — so the caller sees a role-resolution
  // error message rather than the generic "Failed to wait for PR review"
  // wrapper from the outer try/catch.
  let tokenProvider: TokenProvider;
  try {
    tokenProvider = await getTokenProvider();
  } catch (acquisitionError) {
    throw new MinskyError(
      `Cannot resolve reviewer role "${role}": failed to acquire TokenProvider. ` +
        `${getErrorMessage(acquisitionError)}. ` +
        `Either ensure GitHub config is initialized before calling, or pass a ` +
        `literal GitHub login (e.g. \`minsky-reviewer[bot]\`) to bypass role resolution.`
    );
  }
  if (!tokenProvider.isRoleConfigured(role)) {
    throw new MinskyError(
      `Cannot resolve reviewer role "${role}": required config key ` +
        `\`${REVIEWER_ROLE_CONFIG_KEYS[role]}\` is not configured. ` +
        `Either configure the role's service account or pass a literal ` +
        `GitHub login (e.g. \`minsky-reviewer[bot]\`) to bypass role resolution.`
    );
  }

  const identity = await tokenProvider.getServiceIdentity(role);
  if (!identity) {
    // Defensive: `isRoleConfigured(role)` returned true so a non-null
    // identity is expected. Reaching here indicates a TokenProvider
    // implementation bug, not user error — surface it loudly.
    throw new MinskyError(
      `TokenProvider returned null identity for role "${role}" despite ` +
        `\`isRoleConfigured("${role}")\` reporting it configured. This is a ` +
        `TokenProvider implementation inconsistency.`
    );
  }

  return identity.login;
}

/**
 * Default TokenProvider factory mirroring `pr-review-context-subcommand`'s
 * construction pattern: resolves runtime config and builds the provider
 * lazily so the wait-for-review subcommand stays decoupled from the
 * configuration module at import time.
 */
async function defaultGetTokenProvider(): Promise<TokenProvider> {
  const { createTokenProvider } = await import("../../auth");
  const { getConfiguration } = await import("../../configuration/index");
  const cfg = getConfiguration();
  const userToken = cfg.github?.token ?? "";
  return createTokenProvider(cfg.github ?? {}, userToken);
}

/**
 * Bound the mt#2777 SC#1 final-authoritative-check I/O (a `getHeadSha`
 * refresh + a fresh `listReviews` re-read + a `ci.getChecksForPR` fetch) so
 * a stalled call at the very end of a wait cannot hang past a short, fixed
 * budget. This is independent of — and deliberately much smaller than — the
 * caller's own configured `timeoutSeconds`, since the final check runs
 * AFTER that budget has already elapsed.
 *
 * This is a TOTAL budget for the whole final-check sequence, not a per-call
 * cap (PR #1958 R1 BLOCKING finding: applying this value to each of the
 * three sequential calls independently let the aggregate stack to 20-30s+
 * past the caller's timeout). `finalizeTimeout()` computes ONE deadline
 * timestamp from this constant and threads the shrinking remaining budget
 * (`Math.max(0, deadline - now())`) through each subsequent call — the same
 * pattern the main poll loop already uses for `ioDeadlineMs`.
 */
export const FINAL_CHECK_DEADLINE_MS = 10_000;

/**
 * Resolve the reviewer findings check-run name the same way
 * `pr-check-run-submit-subcommand.ts`'s (unexported) `resolveCheckRunName`
 * does — explicit config override (`reviewer.checkRunName`, ← the
 * `MINSKY_REVIEWER_CHECK_RUN_NAME` env var, mt#2392) wins, else the Minsky
 * default. Duplicated here as a small self-contained lookup rather than
 * exporting a new surface from a sibling file this task doesn't otherwise
 * touch; both resolve to the same `DEFAULT_CHECK_RUN_NAME` constant so the
 * default stays a single source of truth.
 */
async function resolveReviewerCheckRunName(): Promise<string> {
  try {
    const { getConfiguration } = await import("../../configuration/index");
    const cfg = getConfiguration() as { reviewer?: { checkRunName?: string } };
    const configured = cfg.reviewer?.checkRunName?.trim();
    if (configured) return configured;
  } catch {
    // Config unavailable (e.g. test contexts) — fall through to the default.
  }
  return DEFAULT_CHECK_RUN_NAME;
}

/**
 * Fetch the reviewer findings check-run's state on the PR's current HEAD,
 * for the mt#2777 SC#1 final authoritative check. Best-effort: returns
 * `null` — never throws — when the backend doesn't implement
 * `ci.getChecksForPR` (a non-GitHub backend, or a test stub that only wires
 * up `review`) or the fetch fails/times out. A `null` here must be read as
 * "this signal is unavailable," not as "no check run exists" — the positive
 * absence claim is `{ status: "absent" }`.
 *
 * `deadlineMs` (PR #1958 R1): the caller's REMAINING budget for this call,
 * not a fresh `FINAL_CHECK_DEADLINE_MS` each time — `finalizeTimeout()`
 * passes what's left of the shared final-check deadline after the
 * `getHeadSha`/`listReviews` steps have already run. Defaults to the full
 * `FINAL_CHECK_DEADLINE_MS` for standalone callers (e.g. these unit tests)
 * that aren't part of a larger budgeted sequence.
 *
 * Exported for unit tests.
 */
export async function fetchReviewerCheckRunState(
  backend: RepositoryBackend,
  prNumber: number,
  deadlineMs: number = FINAL_CHECK_DEADLINE_MS
): Promise<ReviewerCheckRunState | null> {
  const getChecksForPR = backend.ci?.getChecksForPR;
  if (!getChecksForPR) return null;
  try {
    const checkRunName = await resolveReviewerCheckRunName();
    const checksResult = await withDeadline(getChecksForPR(prNumber), deadlineMs);
    const match = checksResult.checks.find((check) => check.name === checkRunName);
    if (!match) {
      return { name: checkRunName, status: "absent", conclusion: null, url: null };
    }
    return {
      name: checkRunName,
      status: match.status,
      conclusion: match.conclusion,
      url: match.url,
    };
  } catch (checkRunError) {
    log.debug(
      `session_pr_wait_for_review: PR #${prNumber} final check-run-state fetch failed ` +
        `(mt#2777 SC#1, best-effort). ${getErrorMessage(checkRunError)}`
    );
    return null;
  }
}

/**
 * Explain why a single review entry did not match the filter, or return
 * `null` if it matches.
 *
 * Exported for unit tests and reused by `findMatchingReview` so the match
 * decision and the rejection-reason explanation are guaranteed to stay in
 * lockstep (one source of truth — no risk of the timeout-path explanation
 * disagreeing with the match-path decision).
 *
 * Reason format (mt#2043): each non-null return value is a structured tag
 * (`state-pending`, `missing-submittedAt`, `unparseable-submittedAt`,
 * `since`, `reviewer-mismatch`) followed by the relevant evidence.
 * Agents can string-match on the tag for programmatic dispatch.
 *
 * `since` comparison is strictly-after (mt#2656): a review whose
 * `submittedAt` exactly equals `since` is rejected as already-seen, not
 * matched. This closes the inclusive-boundary bug where passing a previous
 * review's exact `submittedAt` as `since` re-matched that same review
 * (hit live on PR #1811; the workaround was a manual `+1s` adjustment).
 */
export function explainReviewRejection(
  review: ReviewListEntry,
  since: number,
  reviewer: string | undefined,
  headSha?: string
): string | null {
  // Exclude PENDING — those are draft reviews the reviewer hasn't submitted
  // yet; they don't count as "a review has been posted" for waiter purposes.
  if (review.state === "PENDING") return "state-pending: review is in PENDING (draft) state";
  if (review.submittedAt === undefined) {
    return "missing-submittedAt: review has no submittedAt timestamp";
  }
  const submittedMs = Date.parse(review.submittedAt);
  if (Number.isNaN(submittedMs)) {
    return `unparseable-submittedAt: ${review.submittedAt}`;
  }
  // mt#2656: strictly-after — `<=` (not `<`) so an exactly-equal
  // submittedAt is treated as already-seen rather than re-matched.
  if (submittedMs <= since) {
    const sinceIso = new Date(since).toISOString();
    const relation = submittedMs === since ? "==" : "<";
    return `since: submittedAt ${review.submittedAt} ${relation} threshold ${sinceIso}`;
  }
  // mt#2586: reject a review submitted against a superseded commit. Only
  // enforced when the caller resolved a HEAD sha (the backend supports
  // getPullRequestHeadSha AND requireCurrentHead is not false); an undefined
  // headSha means "no HEAD filter" — the fallback path for backends/opt-outs.
  if (headSha !== undefined && review.commitId !== headSha) {
    return `stale-head: review commit_id ${review.commitId ?? "<none>"} != HEAD ${headSha}`;
  }
  if (reviewer !== undefined) {
    // GitHub logins are case-insensitive at the platform level; the
    // `[bot]` suffix is a presentation-layer artifact of the App identity.
    // Compare on the normalized form so `minsky-reviewer` matches
    // `minsky-reviewer[bot]` and vice versa.
    const normalizedReviewer = normalizeReviewerLogin(reviewer);
    if (normalizeReviewerLogin(review.reviewerLogin ?? "") !== normalizedReviewer) {
      return `reviewer-mismatch: reviewerLogin ${review.reviewerLogin ?? "<null>"} != filter ${reviewer}`;
    }
  }
  return null;
}

/**
 * Projects `ReviewListEntry` onto the fields the shared ordering rule reads
 * (`repository/review-verdict.ts`).
 */
const REVIEW_LIST_ENTRY_FIELDS: ReviewVerdictFields<ReviewListEntry> = {
  reviewerLogin: (review) => review.reviewerLogin,
  submittedAt: (review) => review.submittedAt,
  state: (review) => review.state,
};

/**
 * Pick the review representing the reviewer's STANDING VERDICT among those
 * matching the filter criteria.
 *
 * Before mt#3555 this returned the FIRST match in listing order. Because
 * `listReviews` returns GitHub's chronological (oldest-first) order, that
 * meant the EARLIEST qualifying review won: on PR #2525 an APPROVED at
 * 18:59:48Z beat the same reviewer's CHANGES_REQUESTED at 19:07:55Z **on the
 * same commit**, and `/implement-task` §9 reads an APPROVED on current HEAD as
 * the authorization to merge. `requireCurrentHead` could not disambiguate:
 * both reviews were on HEAD, so the head filter admitted both and scan order
 * decided. The head check answers "is this review about the current code",
 * never "is this the reviewer's current verdict".
 *
 * Resolution order, applied to the reviews that pass the filters:
 *
 *   1. Reduce to the latest DECISION-BEARING review per reviewer
 *      (`pickLatestDecisionPerReviewer`) — the same rule the approval path
 *      uses, correct in both directions: a CHANGES_REQUESTED the reviewer
 *      later resolved does not win, and an APPROVED they later retracted does
 *      not either.
 *   2. If any reviewer's standing verdict is CHANGES_REQUESTED, return the
 *      latest of those. Only reachable without a `reviewer` filter (with one,
 *      there is a single reviewer to reduce). Without it, returning a second
 *      reviewer's later APPROVED while a first reviewer's rejection stands
 *      would reproduce this same defect in multi-reviewer shape.
 *   3. Otherwise return the latest standing verdict.
 *   4. When NO candidate is decision-bearing — a COMMENTED-only wait — return
 *      the latest candidate, so a caller waiting on a COMMENT still resolves.
 *      COMMENTED is informational: it never supersedes a decision (step 1
 *      filters it out), but it is still a review the wait tool must be able to
 *      return, and `pr-drive-subcommand` branches on it.
 *
 * Exported for unit tests — keeps the resolution logic independent of the
 * polling loop so corner cases (missing submittedAt, case-insensitive reviewer
 * match, since boundary, supersession) can be exercised in isolation.
 */
export function findMatchingReview(
  reviews: ReviewListEntry[],
  since: number,
  reviewer: string | undefined,
  headSha?: string
): ReviewListEntry | undefined {
  const candidates = reviews.filter(
    (review) => explainReviewRejection(review, since, reviewer, headSha) === null
  );
  if (candidates.length === 0) return undefined;

  const standing = pickLatestDecisionPerReviewer(candidates, REVIEW_LIST_ENTRY_FIELDS);
  if (standing.length === 0) {
    return pickLatestSubmitted(candidates, REVIEW_LIST_ENTRY_FIELDS);
  }

  const blocking = standing.filter((review) => review.state === "CHANGES_REQUESTED");
  return pickLatestSubmitted(blocking.length > 0 ? blocking : standing, REVIEW_LIST_ENTRY_FIELDS);
}

/**
 * Annotate every review in a list with the reason it did NOT match the
 * filter. Used on the wait-tool's timeout path to surface the most-recent
 * poll's reviews + per-entry rejection reason, replacing the previous
 * "{matched: false, elapsedMs, pollCount}" diagnostic gap.
 *
 * Reviews that WOULD have matched are still annotated with their match
 * status — but those will not appear in the timeout payload because the
 * wait loop returns immediately on the first match. The defensive non-null
 * fallback below covers the edge case where annotation runs on a list
 * containing a matching review (e.g., during testing).
 *
 * `suppressedReason` (mt#3877) covers the one case where that fallback would
 * LIE: with `expectedHeadSha` set and the remote not yet serving it, the wait
 * suppresses matching wholesale, so a review passing every ordinary filter is
 * still not a match. Annotating it "matched" inside a TIMEOUT payload asserts
 * the opposite of what happened, in the field an agent reads to work out why
 * the wait failed. Per-review reasons still win when they apply — they are
 * more specific, and a review can be both stale-by-`since` and suppressed.
 */
export function annotateReviewRejections(
  reviews: ReviewListEntry[],
  since: number,
  reviewer: string | undefined,
  headSha?: string,
  suppressedReason?: string
): AnnotatedReview[] {
  return reviews.map((review) => ({
    ...review,
    rejectionReason:
      explainReviewRejection(review, since, reviewer, headSha) ??
      suppressedReason ??
      "matched: review satisfies all filter criteria (annotation defensive fallback)",
  }));
}

/**
 * Block until a matching review appears, or the timeout elapses.
 *
 * Contract:
 * - Resolves the session's PR via `resolveSessionContextWithFeedback`.
 * - Calls `backend.review.listReviews` at each poll tick.
 * - Returns the standing verdict among the reviews matching `since` and the
 *   optional `reviewer` filter — the reviewer's latest decision-bearing
 *   review, not the first in listing order (mt#3555).
 * - `since` default (mt#2043): when the caller does not pass `since`, the
 *   default is the PR's `created_at` timestamp (looked up via
 *   `backend.review.getPullRequestCreatedAt`). This makes pre-existing
 *   reviews on the PR match by default — the previous "call start" default
 *   silently excluded any review posted before the wait was invoked.
 *   Backends that do not implement `getPullRequestCreatedAt` fall back to
 *   call start (the previous default).
 * - On timeout, returns
 *   `{matched: false, elapsedMs, pollCount, lastSeenReviews, sinceUsed}` —
 *   does not throw. `lastSeenReviews` is the most recent poll's reviews,
 *   each annotated with the rejection reason; `sinceUsed` is the actual
 *   `since` threshold applied. Together they let callers diagnose the miss
 *   without a separate `pull_request_read get_reviews` round-trip
 *   (mt#2043 diagnostic visibility).
 * - Throws MinskyError / ResourceNotFoundError / ValidationError for
 *   structural failures (no PR on session, backend unsupported, auth issue).
 */
export async function sessionPrWaitForReview(
  params: SessionPrWaitForReviewParams,
  deps: SessionPrWaitForReviewDependencies
): Promise<SessionPrWaitForReviewResult> {
  const { sessionDB } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const createBackend = deps.createBackend ?? createRepositoryBackendFromSession;
  const getTokenProvider = deps.getTokenProvider ?? defaultGetTokenProvider;

  // PR #2571 R1 (non-blocking): validate the mt#3551 final-check budget seam
  // eagerly, and THROW rather than clamp. A non-positive budget would make
  // every final-check call exceed its deadline instantly; that error is caught
  // downstream and degrades to `finalCheckPerformed: false` — indistinguishable
  // from a legitimately-unavailable check. Silently accepting a bad value would
  // therefore turn a typo into a test that passes while verifying nothing (the
  // fail-open trap in mem#620). Validated here, at setup, so it lands outside
  // `finalizeTimeout`'s try/catch and cannot be swallowed.
  const finalCheckBudgetMs = deps.finalCheckDeadlineMs ?? FINAL_CHECK_DEADLINE_MS;
  if (!Number.isFinite(finalCheckBudgetMs) || finalCheckBudgetMs <= 0) {
    throw new ValidationError(
      `deps.finalCheckDeadlineMs must be a finite number greater than 0 (got ${String(
        deps.finalCheckDeadlineMs
      )})`
    );
  }

  // Parameter schema enforces the outer cap of 1800s; clamp defensively here.
  const timeoutMs = clamp(params.timeoutSeconds ?? 600, 1, 1800) * 1000;
  // Polling interval: 15s default, clamped [5, 60] so callers can't hammer
  // the API (lower bound) or wait forever between checks (upper bound).
  const intervalMs = clamp(params.intervalSeconds ?? 15, 5, 60) * 1000;

  const start = now();

  // Validate explicit `params.since` up front. The default-`since`
  // resolution (PR `created_at`) happens AFTER backend creation since it
  // requires a backend call (`getPullRequestCreatedAt`). The explicit path
  // is validated here so caller-supplied bad timestamps fail fast.
  if (params.since !== undefined && Number.isNaN(Date.parse(params.since))) {
    throw new ValidationError(`Invalid --since timestamp: ${params.since}`);
  }

  // A too-short `expectedHeadSha` fails LOUDLY here rather than quietly never
  // matching. Same reasoning as the `finalCheckDeadlineMs` validation above:
  // the failure mode of accepting it is a wait that suppresses every review and
  // times out, which reads as reviewer silence rather than as a bad argument
  // (mt#4039). Hex-shape is checked too, since a non-sha value can only ever
  // suppress.
  if (params.expectedHeadSha !== undefined) {
    const candidate = params.expectedHeadSha.trim();
    if (!/^[0-9a-fA-F]+$/.test(candidate)) {
      throw new ValidationError(
        `expectedHeadSha must be a hexadecimal commit sha (got '${params.expectedHeadSha}')`
      );
    }
    if (candidate.length < MIN_ABBREVIATED_SHA_LENGTH) {
      throw new ValidationError(
        `expectedHeadSha must be at least ${MIN_ABBREVIATED_SHA_LENGTH} characters ` +
          `(got '${params.expectedHeadSha}', ${candidate.length}). Pass the commitHash ` +
          `session_commit returned; abbreviated forms are matched as a prefix.`
      );
    }
  }

  try {
    // Resolve the reviewer filter ONCE up front. A TokenRole identifier
    // (`"reviewer"` / `"implementer"`) is converted to the configured App's
    // login here; literal logins pass through unchanged. Role-config errors
    // surface before any session/backend lookups so we fail fast on misconfig.
    const resolvedReviewer = await resolveReviewerFilter(params.reviewer, getTokenProvider);

    const resolvedContext = await resolveSessionContextWithFeedback({
      sessionId: params.sessionId,
      task: params.task,
      repo: params.repo,
      sessionProvider: sessionDB,
      allowAutoDetection: true,
    });

    const sessionRecord = await sessionDB.getSession(resolvedContext.sessionId);
    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionId}' not found`);
    }

    const prNumber = sessionRecord.pullRequest?.number;
    if (!prNumber) {
      throw new ResourceNotFoundError(
        `No pull request found for session '${resolvedContext.sessionId}'. ` +
          `Use 'minsky session pr create' to create a PR first.`
      );
    }

    const backend = await createBackend(sessionRecord, sessionDB);
    if (!backend.review.listReviews) {
      throw new MinskyError(
        `Repository backend does not support listing reviews. ` +
          `session_pr_wait_for_review requires a backend implementing ReviewOperations.listReviews.`
      );
    }
    // Capture a narrowed, non-optional reference now that the guard above
    // has confirmed it's present — avoids a `!` non-null assertion at each
    // later call site (the poll loop and the mt#2777 SC#1 final check).
    const listReviews = backend.review.listReviews;

    // Resolve the `since` threshold (mt#2043):
    //   - explicit `params.since` wins; backend lookup is skipped.
    //   - otherwise look up PR `created_at` via the backend so pre-existing
    //     reviews match by default.
    //   - if the backend doesn't implement `getPullRequestCreatedAt`, fall
    //     back to call start (the previous default — preserves behavior on
    //     non-GitHub backends that haven't implemented the new method yet).
    let since: number;
    if (params.since !== undefined) {
      since = Date.parse(params.since);
    } else if (backend.review.getPullRequestCreatedAt) {
      const createdAt = await backend.review.getPullRequestCreatedAt(prNumber);
      const createdMs = Date.parse(createdAt);
      if (Number.isNaN(createdMs)) {
        // Backend returned a malformed timestamp — surface defensively
        // rather than silently coercing to call start. The agent's spec
        // promise is "default since = PR created_at"; if the backend can't
        // produce a usable value, the caller should know.
        throw new MinskyError(
          `Backend returned unparseable PR created_at: "${createdAt}". ` +
            `Pass an explicit \`since\` to bypass the default lookup.`
        );
      }
      since = createdMs;
    } else {
      // Non-GitHub backend with no PR-creation-time exposure. Falls back to
      // call-start semantics (the pre-mt#2043 default).
      since = start;
    }

    const sinceIso = new Date(since).toISOString();

    // The PR's current HEAD sha (mt#2586), REFRESHED on every poll below — not
    // resolved once — so that if HEAD advances during the wait (a quick
    // re-push in a re-review cycle) a review of the PRIOR head keeps being
    // rejected until a review of the NEW head lands. Declared here so
    // `buildTimeoutResult`'s closure always reflects the latest poll's value.
    // Stays undefined (no HEAD filter, `since`-only) when the caller opts out
    // (requireCurrentHead === false) or the backend lacks getPullRequestHeadSha.
    let headSha: string | undefined;
    // Capture the HEAD-sha resolver (or undefined) so the poll loop can call it
    // without a non-null assertion; requireCurrentHead === false disables it.
    const getHeadSha =
      params.requireCurrentHead !== false ? backend.review.getPullRequestHeadSha : undefined;

    const deadline = start + timeoutMs;
    let pollCount = 0;
    // Track the most recent poll's reviews so the timeout payload can
    // surface them with per-entry rejection reasons (mt#2043).
    let lastReviews: ReviewListEntry[] = [];

    // mt#3877: true once the remote head has been observed to equal the
    // caller's `expectedHeadSha`. Until then no review is considered — the
    // remote is still serving the pre-push tree, and any review of it is
    // about code the caller has already superseded.
    const expectedHeadSha = params.expectedHeadSha;
    const remoteIsServingExpectedHead = (): boolean =>
      headShaMatchesExpected(headSha, expectedHeadSha);

    // mt#4995: read off the SAME `headSha` closure the payload reports, so the
    // classification can never describe a different observation than the
    // `lastObservedHeadSha` printed beside it.
    const mismatchKind = (): HeadShaMismatchKind | null =>
      classifyHeadShaMismatch(headSha, expectedHeadSha);

    const buildTimeoutResult = (
      overrides: Partial<
        Pick<SessionPrWaitForReviewTimeout, "finalCheckPerformed" | "reviewerCheckRunState">
      > = {}
    ): SessionPrWaitForReviewTimeout => {
      // mt#4995 (PR #3641 R1): compute the classification ONCE, and let it
      // decide whether the diagnostic is present at all. `mismatchKind()`
      // returns null in exactly the cases `remoteIsServingExpectedHead()`
      // returns true — both delegate to `headShaMatchesExpected` — so this is
      // the SAME gate the field already carried, re-expressed as the value it
      // reports. Two things follow, and the second is the point: the pair can
      // no longer drift apart, and `classification: null` becomes
      // UNREPRESENTABLE rather than merely unreachable.
      const kind = mismatchKind();
      return {
        matched: false,
        elapsedMs: now() - start,
        pollCount,
        lastSeenReviews: annotateReviewRejections(
          lastReviews,
          since,
          resolvedReviewer,
          headSha,
          remoteIsServingExpectedHead()
            ? undefined
            : `push-not-landed: matching suppressed while remote head ${headSha ?? "<unresolved>"} != expected ${expectedHeadSha}`
        ),
        sinceUsed: sinceIso,
        ...(expectedHeadSha !== undefined && kind !== null
          ? {
              expectedHeadShaUnreached: {
                expected: expectedHeadSha,
                lastObservedHeadSha: headSha ?? null,
                classification: kind,
              },
            }
          : {}),
        finalCheckPerformed: false,
        reviewerCheckRunState: null,
        ...overrides,
      };
    };

    /**
     * mt#2777 SC#1: perform ONE final authoritative check immediately before
     * reporting a timeout — a fresh `listReviews` re-read (bypassing the
     * poll loop's own deadline gate, since a review landing in the gap
     * between the loop's last poll and its deadline check is exactly the
     * false-silence class this closes) plus the `minsky-reviewer/findings`
     * check-run state on the PR's current HEAD. A churn-delayed review that
     * posted just outside the polling window is reported as `matched: true`
     * here instead of bare silence; when it's still genuinely absent, the
     * check-run state lets the caller distinguish "confirmed silent" from
     * "reviewer is still actively working" (originating incident: mt#2751's
     * near-bypass, where the findings check flipped absent → `failure`
     * mid-churn while two 600s waits reported nothing).
     *
     * Best-effort: any failure in the re-read (backend I/O error, exceeded
     * budget) degrades to the ordinary timeout payload with
     * `finalCheckPerformed: false` rather than throwing — a failed
     * diagnostic read must never turn an otherwise-legitimate timeout into
     * a thrown error.
     *
     * Budget (PR #1958 R1 fix): `FINAL_CHECK_DEADLINE_MS` — or the
     * `deps.finalCheckDeadlineMs` test-seam override (mt#3551) — is a TOTAL
     * budget for the whole sequence below, not a per-call cap — a single
     * `finalCheckDeadline` timestamp is computed once, and each of the
     * three sequential calls (`getHeadSha`, `listReviews`,
     * `fetchReviewerCheckRunState`) is bounded to whatever remains of it
     * (`Math.max(0, finalCheckDeadline - now())`), mirroring the main poll
     * loop's own `ioDeadlineMs` pattern. Without this, three independent
     * 10s per-call caps could stack to 20-30s+ past the caller's configured
     * timeout.
     */
    const finalizeTimeout = async (): Promise<SessionPrWaitForReviewResult> => {
      let finalCheckPerformed = false;
      const finalCheckDeadline = now() + finalCheckBudgetMs;
      try {
        if (getHeadSha) {
          headSha = await withDeadline(
            getHeadSha(prNumber),
            Math.max(0, finalCheckDeadline - now())
          );
        }
        const freshReviews = await withDeadline(
          listReviews(prNumber),
          Math.max(0, finalCheckDeadline - now())
        );
        lastReviews = freshReviews;
        finalCheckPerformed = true;

        // mt#3877: the final authoritative re-read refreshes `headSha` above,
        // so a push that landed inside the closing gap is picked up here — but
        // if the remote STILL has not reached the expected sha, the same
        // superseded-tree reasoning applies and this must not match either.
        const finalMatch = remoteIsServingExpectedHead()
          ? findMatchingReview(freshReviews, since, resolvedReviewer, headSha)
          : null;
        if (finalMatch) {
          return {
            matched: true,
            // mt#2656: trimmed by default; params.fullBody: true restores the
            // full ReviewListEntry (raw body, provenance comment, tables).
            review: params.fullBody ? finalMatch : trimReview(finalMatch),
            elapsedMs: now() - start,
            pollCount,
          };
        }
      } catch (finalError) {
        log.debug(
          `session_pr_wait_for_review: PR #${prNumber} final authoritative reviews-list ` +
            `re-read failed (mt#2777 SC#1, best-effort); reporting timeout from the last ` +
            `successful poll instead. ${getErrorMessage(finalError)}`
        );
      }

      const reviewerCheckRunState = await fetchReviewerCheckRunState(
        backend,
        prNumber,
        Math.max(0, finalCheckDeadline - now())
      );
      return buildTimeoutResult({ finalCheckPerformed, reviewerCheckRunState });
    };

    while (true) {
      // After the first poll, the sleep may have brought us exactly to (or
      // past) the deadline. Re-check before polling again so we never start
      // an API call that would overshoot the configured timeout. The
      // `pollCount > 0` guard guarantees at least one poll even on zero
      // or sub-interval budgets — the contract is "one check minimum."
      if (pollCount > 0 && now() >= deadline) {
        return await finalizeTimeout();
      }

      pollCount += 1;

      // mt#2677: bound EVERY async call made within a single poll iteration
      // to the wait's own overall deadline, not just the interval between
      // polls. Without this, a stalled call with no timeout of its own (the
      // token-mint fetch fixed in github-app-token-provider.ts was one
      // instance; any future unbounded call inside listReviews/getHeadSha
      // would be another) hangs the ENTIRE function past its configured
      // timeoutSeconds — the deadline check below only runs BETWEEN
      // iterations, so it never fires while an iteration's own I/O is stuck.
      // DeadlineExceededError is caught below and treated exactly like a
      // normal poll-loop timeout.
      const ioDeadlineMs = Math.max(0, deadline - now());

      try {
        // mt#2586: refresh HEAD each poll so a mid-wait HEAD advance keeps
        // rejecting reviews of the prior head (getHeadSha captured once above).
        if (getHeadSha) {
          headSha = await withDeadline(getHeadSha(prNumber), ioDeadlineMs);

          // mt#4995: the FIRST poll that actually observes a remote head is
          // enough to tell a sha that has not arrived yet from one that never
          // will. Polling on through a `divergent-prefix` mismatch spends the
          // caller's entire budget — up to 1800s — to re-derive, at timeout,
          // the same conclusion available right now; and a wait that returns
          // nothing after its full budget is the documented lead-in to the
          // bypass ladder, so the cost is not merely the wasted time.
          //
          // `finalizeTimeout` rather than a bare `buildTimeoutResult`: it is
          // already bounded by its own short budget, and it attaches the fresh
          // reviews list and `reviewerCheckRunState` a caller needs to see that
          // the reviewer was never the problem. It cannot mis-report a review
          // as a match here, because its `finalMatch` is gated on
          // `remoteIsServingExpectedHead()` — the very predicate that is false.
          if (mismatchKind() === "divergent-prefix") {
            log.debug(
              `session_pr_wait_for_review: PR #${prNumber} poll ${pollCount} expected sha ` +
                `${expectedHeadSha} shares a >=${MIN_ABBREVIATED_SHA_LENGTH}-character prefix ` +
                `with remote head ${headSha} and then diverges; it names no commit, so ` +
                `returning now instead of waiting out the remaining budget`
            );
            return await finalizeTimeout();
          }
        }

        const reviews = await withDeadline(listReviews(prNumber), ioDeadlineMs);
        lastReviews = reviews;
        // mt#3877: while the remote is still serving the pre-push tree, every
        // review on it is about superseded code — including one that
        // `requireCurrentHead` would happily admit, since that commit IS the
        // current head right now. Poll on rather than return it.
        const match = remoteIsServingExpectedHead()
          ? findMatchingReview(reviews, since, resolvedReviewer, headSha)
          : null;
        if (match) {
          return {
            matched: true,
            // mt#2656: trimmed by default; params.fullBody: true restores the
            // full ReviewListEntry (raw body, provenance comment, tables).
            review: params.fullBody ? match : trimReview(match),
            elapsedMs: now() - start,
            pollCount,
          };
        }
      } catch (ioError) {
        if (ioError instanceof DeadlineExceededError) {
          log.debug(
            `session_pr_wait_for_review: PR #${prNumber} poll ${pollCount} I/O exceeded the ` +
              `wait's overall deadline (a stalled fetch with no bound of its own); ` +
              `returning REVIEW_TIMEOUT instead of hanging further`
          );
          return await finalizeTimeout();
        }
        throw ioError;
      }

      const remaining = deadline - now();
      if (remaining <= 0) {
        return await finalizeTimeout();
      }

      const sleepMs = Math.min(intervalMs, remaining);
      const waitingForPush = !remoteIsServingExpectedHead()
        ? ` (remote head ${headSha ?? "<unresolved>"} != expected ${expectedHeadSha}; push not landed yet)`
        : "";
      log.debug(
        `session_pr_wait_for_review: PR #${prNumber} poll ${pollCount} no match${waitingForPush}; ` +
          `sleeping ${Math.round(sleepMs / 1000)}s (${Math.round(remaining / 1000)}s remaining)`
      );
      // mt#2677: once per poll interval so a legitimate long wait produces
      // MCP transport activity — see SessionPrWaitForReviewDependencies.onProgress.
      deps.onProgress?.(
        `Waiting for review on PR #${prNumber} (poll ${pollCount}, ` +
          `${Math.round(remaining / 1000)}s remaining)`
      );
      await sleep(sleepMs);
    }
  } catch (error) {
    if (
      error instanceof ResourceNotFoundError ||
      error instanceof ValidationError ||
      error instanceof MinskyError
    ) {
      throw error;
    }
    throw new MinskyError(`Failed to wait for PR review: ${getErrorMessage(error)}`);
  }
}
