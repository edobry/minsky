/**
 * Operator alerting for reviewer failures that never reach submission (mt#4881).
 *
 * ## The gap this closes
 *
 * mt#2363 (Phase 1) and mt#2364 (Phase 2) route reviewer failures to an operator
 * Ask and an external sink, but both hang off ONE emit point:
 * `sweeper.circuit_breaker_tripped`, gated on the `reviewer_submission_failures`
 * circuit breaker from mt#2350. That tracker is written from exactly one place —
 * `guarded-submit.ts`, inside the `catch` around `submitReview` — so a review that
 * dies BEFORE it can submit creates no tracker row, the circuit never opens, and
 * no alert is ever produced.
 *
 * Measured 2026-09-01: 88 `failed_at_reviewer` rows in 30 days against 16 tracker
 * rows EVER, the newest from 2026-08-08. 79 of the 88 never reached submission.
 * mt#1596's Phase-1 section named these emit points explicitly and left them out
 * of MVP scope ("need their own dedup design if added later"); this is that dedup
 * design plus the emit.
 *
 * ## Why this module, and not a hook inside `updateOutcome`
 *
 * There are FOUR `failed_at_reviewer` write sites — `server.ts`'s `.then` and
 * `.catch`, and `boot-recovery.ts`'s `.then` and `.catch` — and all four funnel
 * through `updateOutcome`. But `updateOutcome` receives only a `deliveryId`; it
 * has no PR coordinates to alert with, and `webhook-events.ts` is deliberately
 * pure persistence (its header calls itself "observability infrastructure").
 *
 * So the seam is `recordReviewFailure` below: it pairs the outcome write with the
 * alert in one call, and the four sites call it instead of `updateOutcome`. The
 * pairing is what matters — it is not possible to write a `failed_at_reviewer`
 * row through this function without the alert being considered.
 *
 * ## Dedup and aggregation without a new table
 *
 * `reviewer_webhook_events` already records every failure with a timestamp and a
 * message, so "have I already alerted for this key?" is answerable from the
 * evidence trail rather than from new state: query the prior failures in the
 * window, classify them, and suppress when this (repo, PR, class) already fired.
 * That also yields SC4's aggregation facts for free — the occurrence count and
 * the distinct-PR count are the same query.
 *
 * The window keys on `processed_at`, NOT `received_at`: a boot-recovery failure
 * updates the ORIGINAL webhook row, whose `received_at` can be hours older than
 * the failure it is recording. `processed_at` is set by `updateOutcome` on every
 * terminal outcome, so it is the failure time for all four sites.
 *
 * Fail-open throughout: alerting is best-effort and must never affect a review.
 */

import { and, eq, gt, ne } from "drizzle-orm";
import { log } from "./logger";
import type { ReviewerDb } from "./db/client";
import { webhookEventsTable } from "./db/schemas/webhook-events-schema";
import { submissionFailuresTable } from "./db/schemas/submission-failures-schema";
import { updateOutcome, type WebhookErrorDetails } from "./webhook-events";
import type { AskEmitter } from "./ask-emitter";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * One alert per (owner, repo, PR, error class) per this window.
 *
 * Grounded in observed cadence per `decision-defaults §Thresholds`, not a round
 * number: the originating occurrence (`edobry/peezombie.me` PR #2, 2026-09-01)
 * produced FOUR failures of one deterministic cause between 17:21 and 18:15 — a
 * 54-minute burst. A 60-minute window collapses that burst into a single ask,
 * which is the SC2 requirement ("a burst of 88 failures must not produce 88
 * asks"). The sweeper's own 5-minute retrigger cycle is the natural sub-unit;
 * 60 minutes is twelve of them.
 */
export const SUPPRESSION_WINDOW_MS = 60 * 60 * 1000;

/**
 * Distinct PRs with the SAME error class inside the window, at or above which the
 * condition is reported as systemic rather than isolated (SC4).
 *
 * Grounded in the measured shape of the two populations rather than picked: the
 * per-day buckets of the 88 split cleanly into single-PR days (2026-08-27: 2
 * failures / 1 PR; 2026-08-31: 1 / 1; 2026-09-01: 4 / 1 — one deterministic
 * cause on one PR) and repo-wide days (2026-08-17: 18 / 11; 2026-08-18: 18 / 13;
 * 2026-08-25: 9 / 6 — a condition affecting every review). Nothing observed sits
 * between 1 and 6 distinct PRs, so 3 separates the two without straddling either.
 */
export const SYSTEMIC_DISTINCT_PR_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Error classes for a pre-submission reviewer failure.
 *
 * Derived from the measured 30-day population rather than invented — every class
 * below except `unclassified` was observed, with its count as of 2026-09-01.
 * mt#1697 records three (now four) unrelated causes collapsing into one identical
 * operator-visible non-signal; carrying the class is what stops this alert from
 * reproducing that (SC3).
 */
export type ReviewFailureClass =
  | "provider_token_limit"
  | "provider_credits_exhausted"
  | "provider_unavailable"
  | "provider_timeout"
  | "github_diff_too_large"
  | "github_submit_rejected"
  | "tls_self_signed"
  | "network_socket_closed"
  | "unclassified_empty"
  | "unclassified";

interface ClassificationRule {
  readonly errorClass: ReviewFailureClass;
  readonly pattern: RegExp;
  /** Operator-facing one-liner: what this is and who can fix it. */
  readonly summary: string;
}

/**
 * Ordered most-specific-first. `provider_timeout` sits after the other provider
 * classes because a credits/limit rejection can also mention a duration.
 */
const CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  {
    errorClass: "provider_token_limit",
    pattern: /input tokens exceed the configured limit/i,
    summary: "The prompt exceeded the model's input-token cap (cause owned by mt#4879).",
  },
  {
    errorClass: "provider_credits_exhausted",
    pattern: /no credits remaining/i,
    summary:
      "The model provider account is out of credits — operator-only remediation (add credits).",
  },
  {
    errorClass: "provider_unavailable",
    pattern: /no server is currently available/i,
    summary: "The model provider reported no capacity — transient, usually self-healing.",
  },
  {
    errorClass: "provider_timeout",
    pattern: /operation timed out after/i,
    summary: "The model call exceeded its timeout (cause owned by mt#1897).",
  },
  {
    errorClass: "github_diff_too_large",
    pattern: /diff exceeded the maximum number of/i,
    summary: "GitHub refused to serve the PR diff as too large (cause owned by mt#4434).",
  },
  {
    errorClass: "github_submit_rejected",
    pattern: /unprocessable entity/i,
    summary: "GitHub rejected the review submission payload (the mt#3852 422 class).",
  },
  {
    errorClass: "tls_self_signed",
    pattern: /self signed certificate/i,
    summary: "A TLS handshake failed on a self-signed certificate.",
  },
  {
    errorClass: "network_socket_closed",
    pattern: /socket connection was closed/i,
    summary: "The upstream connection closed mid-request.",
  },
];

export interface ReviewFailureClassification {
  readonly errorClass: ReviewFailureClass;
  readonly summary: string;
}

/**
 * Classify a failure message into an operator-meaningful class.
 *
 * **An empty message is a real, expected input — not a defect to assert on.**
 * mt#4118's planning pass measured 141 of 143 `failed_at_reviewer` rows carrying
 * a non-empty `error_details.message`; the 2 exceptions are mt#2465's class (an
 * octokit `HttpError` whose `.message` is empty while its stack is present). This
 * pass's own query returned the same 2. So the classifier degrades to
 * `unclassified_empty` rather than assuming a message is present — the alert must
 * still fire for a failure it cannot name, because `outcome` is the signal and the
 * message is best-effort.
 */
export function classifyReviewFailure(
  message: string | null | undefined
): ReviewFailureClassification {
  const text = (message ?? "").trim();
  if (text.length === 0) {
    return {
      errorClass: "unclassified_empty",
      summary:
        "The failure carried no message (the mt#2465 attribute-only-error class); see the row's stack.",
    };
  }

  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(text)) {
      return { errorClass: rule.errorClass, summary: rule.summary };
    }
  }

  return { errorClass: "unclassified", summary: "Unrecognized failure class." };
}

// ---------------------------------------------------------------------------
// Prior-failure aggregation
// ---------------------------------------------------------------------------

/** PR coordinates extracted from a stored webhook body. */
interface PriorFailure {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly errorClass: ReviewFailureClass;
}

/**
 * Read PR coordinates out of a stored webhook body.
 *
 * The PR number lives at a DIFFERENT path per event type — `pull_request.number`
 * for `pull_request` events, `issue.number` for the comment-triggered ones — which
 * is the same event-type dependence mt#4118's spec names as a reason to encode
 * this once rather than re-derive it per caller. Returns null when the body does
 * not carry usable coordinates (a malformed or non-PR payload), so the caller can
 * skip the row instead of counting a bogus key.
 */
export function extractPrCoordinates(
  body: unknown
): { owner: string; repo: string; prNumber: number } | null {
  if (typeof body !== "object" || body === null) return null;
  const root = body as Record<string, unknown>;

  const repository = root["repository"];
  if (typeof repository !== "object" || repository === null) return null;
  const repoNode = repository as Record<string, unknown>;

  // A real GitHub payload carries BOTH `full_name` and `owner.login` + `name`.
  // Read `full_name` first (it is what the production rows are keyed on — the
  // mt#4881 measurements queried `body->'repository'->>'full_name'`), and fall
  // back to the nested pair so a payload carrying only that shape still yields
  // coordinates rather than silently dropping the row from the aggregation.
  let owner: string | undefined;
  let repo: string | undefined;

  const fullName = repoNode["full_name"];
  if (typeof fullName === "string") {
    [owner, repo] = fullName.split("/");
  }

  if (!owner || !repo) {
    const ownerNode = repoNode["owner"];
    const login =
      typeof ownerNode === "object" && ownerNode !== null
        ? (ownerNode as Record<string, unknown>)["login"]
        : undefined;
    const name = repoNode["name"];
    if (typeof login === "string" && typeof name === "string") {
      owner = login;
      repo = name;
    }
  }

  if (!owner || !repo) return null;

  for (const key of ["pull_request", "issue"] as const) {
    const node = root[key];
    if (typeof node !== "object" || node === null) continue;
    const num = (node as Record<string, unknown>)["number"];
    if (typeof num === "number") return { owner, repo, prNumber: num };
  }

  return null;
}

/** What the prior-failure query tells us about the current failure. */
export interface FailureAggregation {
  /** Prior failures of this class on this PR inside the window (excludes the current one). */
  readonly priorOccurrencesOnPr: number;
  /** Distinct PRs with this class inside the window, INCLUDING this one. */
  readonly distinctPrsWithClass: number;
  /** True when the condition looks repo-wide rather than specific to this PR. */
  readonly systemic: boolean;
}

/**
 * Pure aggregation over already-fetched prior failures. Separated from the query
 * so the counting rules are testable without a database (`testing-standards.mdc`
 * §Testable Design — the decision is a function of its inputs, not of the IO).
 */
export function aggregatePriorFailures(
  priors: readonly PriorFailure[],
  current: { owner: string; repo: string; prNumber: number; errorClass: ReviewFailureClass }
): FailureAggregation {
  const sameClass = priors.filter((p) => p.errorClass === current.errorClass);

  const priorOccurrencesOnPr = sameClass.filter(
    (p) => p.owner === current.owner && p.repo === current.repo && p.prNumber === current.prNumber
  ).length;

  const prKeys = new Set(sameClass.map((p) => `${p.owner}/${p.repo}#${p.prNumber}`));
  prKeys.add(`${current.owner}/${current.repo}#${current.prNumber}`);

  return {
    priorOccurrencesOnPr,
    distinctPrsWithClass: prKeys.size,
    systemic: prKeys.size >= SYSTEMIC_DISTINCT_PR_THRESHOLD,
  };
}

/**
 * Fetch the prior `failed_at_reviewer` rows inside the suppression window.
 *
 * Excludes the current delivery so the caller's own row — already written by the
 * time this runs — cannot count itself as a prior occurrence and suppress its own
 * alert. Windowed on `processed_at` (see the module header).
 */
async function fetchPriorFailures(
  db: ReviewerDb,
  currentDeliveryId: string,
  nowMs: number
): Promise<PriorFailure[]> {
  const cutoff = new Date(nowMs - SUPPRESSION_WINDOW_MS);

  const rows = await db
    .select({
      body: webhookEventsTable.body,
      errorDetails: webhookEventsTable.errorDetails,
    })
    .from(webhookEventsTable)
    .where(
      and(
        eq(webhookEventsTable.outcome, "failed_at_reviewer"),
        gt(webhookEventsTable.processedAt, cutoff),
        ne(webhookEventsTable.deliveryId, currentDeliveryId)
      )
    );

  const priors: PriorFailure[] = [];
  for (const row of rows) {
    const coords = extractPrCoordinates(row.body);
    if (!coords) continue;
    const details = row.errorDetails as { message?: unknown } | null;
    const message = typeof details?.message === "string" ? details.message : null;
    priors.push({ ...coords, errorClass: classifyReviewFailure(message).errorClass });
  }
  return priors;
}

/**
 * Is this failure already owned by the mt#2350 submission circuit breaker?
 *
 * SC8. A submit-path failure writes BOTH a `failed_at_reviewer` row (here) and a
 * `reviewer_submission_failures` row (from `guarded-submit.ts`), so alerting on
 * every `failed_at_reviewer` would double-alert on exactly the one class that is
 * already covered — 9 of the measured 88. This asks the tracker directly rather
 * than pattern-matching the message, because the tracker's own predicate is what
 * decides ownership: it records a failure only when `classifySubmissionError`
 * returns non-retryable, so a RETRYABLE submit failure writes no row and is
 * correctly still ours to alert on.
 */
async function isOwnedByCircuitBreaker(
  db: ReviewerDb,
  coords: { owner: string; repo: string; prNumber: number },
  headSha: string
): Promise<boolean> {
  const rows = await db
    .select({ id: submissionFailuresTable.id })
    .from(submissionFailuresTable)
    .where(
      and(
        eq(submissionFailuresTable.owner, coords.owner),
        eq(submissionFailuresTable.repo, coords.repo),
        eq(submissionFailuresTable.prNumber, coords.prNumber),
        eq(submissionFailuresTable.headSha, headSha)
      )
    )
    .limit(1);

  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/** Everything the four write sites know about a failed review. */
export interface ReviewFailureContext {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly deliveryId: string;
  /** "reviewer" (server.ts) or "boot_recovery" (boot-recovery.ts). */
  readonly stage: string;
  readonly message: string;
  readonly stack?: string;
}

export interface RecordReviewFailureDeps {
  readonly askEmitter?: AskEmitter | undefined;
  /** Injected for tests; defaults to the real clock (`testing-standards.mdc` §Testable Design). */
  readonly nowMs?: number;
}

/** Why an alert did or did not fire — returned so callers and tests can assert it. */
export type ReviewFailureAlertOutcome =
  | "emitted"
  | "suppressed_duplicate"
  | "suppressed_circuit_breaker"
  | "no_emitter"
  | "failed";

/**
 * Record a `failed_at_reviewer` outcome AND surface it to the operator.
 *
 * This is the single seam for the pre-submission failure classes. All four
 * `failed_at_reviewer` write sites call it instead of `updateOutcome` so the
 * outcome write and the alert cannot drift apart.
 *
 * Fail-open and never throws: the outcome write is attempted first and its own
 * error handling already swallows (see `webhook-events.ts`), and every step of
 * the alert path is wrapped. A failure to alert must never affect a review.
 */
export async function recordReviewFailure(
  db: ReviewerDb,
  ctx: ReviewFailureContext,
  deps: RecordReviewFailureDeps = {}
): Promise<ReviewFailureAlertOutcome> {
  const errorDetails: WebhookErrorDetails = {
    message: ctx.message,
    stage: ctx.stage,
    ...(ctx.stack !== undefined ? { stack: ctx.stack } : {}),
  };

  // The outcome write is unchanged behavior — it happens whether or not the
  // alert path below can run.
  await updateOutcome(db, ctx.deliveryId, "failed_at_reviewer", errorDetails);

  try {
    const { errorClass, summary } = classifyReviewFailure(ctx.message);
    const coords = { owner: ctx.owner, repo: ctx.repo, prNumber: ctx.prNumber };

    if (await isOwnedByCircuitBreaker(db, coords, ctx.headSha)) {
      log.info("review_failure_alert.skipped_circuit_breaker", {
        event: "review_failure_alert.skipped_circuit_breaker",
        pr: ctx.prNumber,
        headSha: ctx.headSha,
        errorClass,
        message:
          "Submission circuit breaker (mt#2350) already owns this failure; not double-alerting.",
      });
      return "suppressed_circuit_breaker";
    }

    const nowMs = deps.nowMs ?? Date.now();
    const priors = await fetchPriorFailures(db, ctx.deliveryId, nowMs);
    const aggregation = aggregatePriorFailures(priors, { ...coords, errorClass });

    if (aggregation.priorOccurrencesOnPr > 0) {
      log.info("review_failure_alert.suppressed_duplicate", {
        event: "review_failure_alert.suppressed_duplicate",
        pr: ctx.prNumber,
        errorClass,
        priorOccurrencesOnPr: aggregation.priorOccurrencesOnPr,
        windowMinutes: SUPPRESSION_WINDOW_MS / 60_000,
      });
      return "suppressed_duplicate";
    }

    if (!deps.askEmitter) {
      log.warn("review_failure_alert.no_emitter", {
        event: "review_failure_alert.no_emitter",
        pr: ctx.prNumber,
        errorClass,
        message:
          "Reviewer failure not surfaced as an Ask — no ask emitter wired (no domain container / DB).",
      });
      return "no_emitter";
    }

    const emitted = await deps.askEmitter.emitReviewFailureAlert({
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      headSha: ctx.headSha,
      stage: ctx.stage,
      errorClass,
      errorSummary: summary,
      failureMessage: ctx.message,
      occurrencesOnPr: aggregation.priorOccurrencesOnPr + 1,
      distinctPrsWithClass: aggregation.distinctPrsWithClass,
      systemic: aggregation.systemic,
      windowMinutes: SUPPRESSION_WINDOW_MS / 60_000,
    });

    return emitted === "created" ? "emitted" : "failed";
  } catch (err: unknown) {
    // Fail-open: alerting is best-effort and must never affect the review path.
    log.error("review_failure_alert.failed", {
      event: "review_failure_alert.failed",
      pr: ctx.prNumber,
      headSha: ctx.headSha,
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}
