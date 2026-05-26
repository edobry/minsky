/**
 * Session PR Wait-For-Review Subcommand (mt#1203)
 *
 * Blocks until a matching review appears on the session's pull request, or
 * a timeout elapses. Uses polling under the hood; the tool is the transport
 * primitive that mt#1180's Ask subsystem composes for its `quality.review`
 * resolution.
 *
 * Resolution criteria: a review on the PR with `submittedAt >= since`,
 * optionally filtered by reviewer login.
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
import { createRepositoryBackendFromSession } from "../session-pr-operations";
import type { TokenProvider, TokenRole } from "../../auth/token-provider";

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
   * Test seam: override the TokenProvider used for role resolution
   * (`reviewer: "reviewer" | "implementer"`). Defaults to a provider
   * constructed from runtime config the same way `pr-review-context-subcommand`
   * builds one. Pure literal-login filters do not consult this seam.
   */
  getTokenProvider?: () => Promise<TokenProvider>;
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
   * Optional ISO timestamp; reviews with submittedAt earlier than this are
   * ignored. Defaults to the PR's `created_at` timestamp (mt#2043), so
   * pre-existing reviews on the PR match by default. Pass an explicit value
   * to narrow the window (e.g., wait only for reviews newer than a known
   * stale one).
   *
   * Backwards-compat note: prior to mt#2043 the default was the call's
   * start time, which silently excluded reviews posted before the wait was
   * invoked. The new default is structurally more useful for the typical
   * post-PR-create wait pattern. Backends that don't implement
   * `ReviewOperations.getPullRequestCreatedAt` fall back to call-start.
   */
  since?: string;
}

export interface SessionPrWaitForReviewMatch {
  matched: true;
  review: ReviewListEntry;
  elapsedMs: number;
  pollCount: number;
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
   *   - `"since: submittedAt <iso> < threshold <iso>"` — review predates the `since` filter.
   *   - `"reviewer-mismatch: reviewerLogin <login> != filter <filter>"` — reviewer filter excluded it.
   *
   * `null` is intentionally not possible here — if a review matched, it would
   * have been returned in the `matched: true` payload instead. This field is
   * only populated on the timeout path.
   */
  rejectionReason: string;
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
 */
export function explainReviewRejection(
  review: ReviewListEntry,
  since: number,
  reviewer: string | undefined
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
  if (submittedMs < since) {
    const sinceIso = new Date(since).toISOString();
    return `since: submittedAt ${review.submittedAt} < threshold ${sinceIso}`;
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
 * Pick the first review, in listing order, that matches the filter criteria.
 *
 * Exported for unit tests — keeps the filter logic independent of the polling
 * loop so corner cases (missing submittedAt, case-sensitive reviewer match,
 * since boundary) can be exercised in isolation.
 */
export function findMatchingReview(
  reviews: ReviewListEntry[],
  since: number,
  reviewer: string | undefined
): ReviewListEntry | undefined {
  for (const review of reviews) {
    if (explainReviewRejection(review, since, reviewer) === null) {
      return review;
    }
  }
  return undefined;
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
 */
export function annotateReviewRejections(
  reviews: ReviewListEntry[],
  since: number,
  reviewer: string | undefined
): AnnotatedReview[] {
  return reviews.map((review) => ({
    ...review,
    rejectionReason:
      explainReviewRejection(review, since, reviewer) ??
      "matched: review satisfies all filter criteria (annotation defensive fallback)",
  }));
}

/**
 * Block until a matching review appears, or the timeout elapses.
 *
 * Contract:
 * - Resolves the session's PR via `resolveSessionContextWithFeedback`.
 * - Calls `backend.review.listReviews` at each poll tick.
 * - Returns the first review matching `since` and optional `reviewer` filter.
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
    const deadline = start + timeoutMs;
    let pollCount = 0;
    // Track the most recent poll's reviews so the timeout payload can
    // surface them with per-entry rejection reasons (mt#2043).
    let lastReviews: ReviewListEntry[] = [];

    const buildTimeoutResult = (): SessionPrWaitForReviewTimeout => ({
      matched: false,
      elapsedMs: now() - start,
      pollCount,
      lastSeenReviews: annotateReviewRejections(lastReviews, since, resolvedReviewer),
      sinceUsed: sinceIso,
    });

    while (true) {
      // After the first poll, the sleep may have brought us exactly to (or
      // past) the deadline. Re-check before polling again so we never start
      // an API call that would overshoot the configured timeout. The
      // `pollCount > 0` guard guarantees at least one poll even on zero
      // or sub-interval budgets — the contract is "one check minimum."
      if (pollCount > 0 && now() >= deadline) {
        return buildTimeoutResult();
      }

      pollCount += 1;
      const reviews = await backend.review.listReviews(prNumber);
      lastReviews = reviews;
      const match = findMatchingReview(reviews, since, resolvedReviewer);
      if (match) {
        return {
          matched: true,
          review: match,
          elapsedMs: now() - start,
          pollCount,
        };
      }

      const remaining = deadline - now();
      if (remaining <= 0) {
        return buildTimeoutResult();
      }

      const sleepMs = Math.min(intervalMs, remaining);
      log.debug(
        `session_pr_wait_for_review: PR #${prNumber} poll ${pollCount} no match; ` +
          `sleeping ${Math.round(sleepMs / 1000)}s (${Math.round(remaining / 1000)}s remaining)`
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
