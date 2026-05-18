/**
 * Session PR Wait-For-Review Subcommand (mt#1203)
 *
 * Blocks until a matching review appears on the session's pull request, or
 * a timeout elapses. Uses polling under the hood; the tool is the transport
 * primitive that mt#1180's Ask subsystem composes for its `quality.review`
 * resolution.
 *
 * Resolution criteria: a review on the PR with `submittedAt >= since` (default
 * = call start), optionally filtered by reviewer login.
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import type { SessionProviderInterface } from "../types";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../../errors/index";
import { log } from "../../../utils/logger";
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
  /** Optional ISO timestamp; reviews with submittedAt earlier than this are ignored. */
  since?: string;
}

export interface SessionPrWaitForReviewMatch {
  matched: true;
  review: ReviewListEntry;
  elapsedMs: number;
  pollCount: number;
}

export interface SessionPrWaitForReviewTimeout {
  matched: false;
  elapsedMs: number;
  pollCount: number;
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

  const tokenProvider = await getTokenProvider();
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
  const normalizedReviewer = reviewer !== undefined ? normalizeReviewerLogin(reviewer) : undefined;
  for (const review of reviews) {
    // Exclude PENDING — those are draft reviews the reviewer hasn't submitted
    // yet; they don't count as "a review has been posted" for waiter purposes.
    if (review.state === "PENDING") continue;
    if (review.submittedAt === undefined) continue;
    const submittedMs = Date.parse(review.submittedAt);
    if (Number.isNaN(submittedMs)) continue;
    if (submittedMs < since) continue;
    if (normalizedReviewer !== undefined) {
      // GitHub logins are case-insensitive at the platform level; the
      // `[bot]` suffix is a presentation-layer artifact of the App identity.
      // Compare on the normalized form so `minsky-reviewer` matches
      // `minsky-reviewer[bot]` and vice versa.
      if (normalizeReviewerLogin(review.reviewerLogin ?? "") !== normalizedReviewer) continue;
    }
    return review;
  }
  return undefined;
}

/**
 * Block until a matching review appears, or the timeout elapses.
 *
 * Contract:
 * - Resolves the session's PR via `resolveSessionContextWithFeedback`.
 * - Calls `backend.review.listReviews` at each poll tick.
 * - Returns the first review matching `since` (default = call start) and
 *   optional `reviewer` filter.
 * - On timeout, returns `{ matched: false, elapsedMs, pollCount }` — does not
 *   throw. Downstream callers differentiate success from timeout on the
 *   `matched` flag, not on exception flow.
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
  // `since` establishes the threshold for "new" reviews. Default is call start;
  // explicit override lets callers watch past a known-stale review.
  const since = params.since !== undefined ? Date.parse(params.since) : start;
  if (Number.isNaN(since)) {
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

    const deadline = start + timeoutMs;
    let pollCount = 0;

    while (true) {
      // After the first poll, the sleep may have brought us exactly to (or
      // past) the deadline. Re-check before polling again so we never start
      // an API call that would overshoot the configured timeout. The
      // `pollCount > 0` guard guarantees at least one poll even on zero
      // or sub-interval budgets — the contract is "one check minimum."
      if (pollCount > 0 && now() >= deadline) {
        return {
          matched: false,
          elapsedMs: now() - start,
          pollCount,
        };
      }

      pollCount += 1;
      const reviews = await backend.review.listReviews(prNumber);
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
        return {
          matched: false,
          elapsedMs: now() - start,
          pollCount,
        };
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
