/**
 * Ask → principal page (mt#3595) — the SECONDARY transport that carries
 * attention when an ask carries an operator-only severity event.
 *
 * ## Why this exists
 *
 * `communication-contract.mdc §Severity transport binding` tells the agent to
 * do two things for an operator-only severity event: create the ask with
 * `forceImmediate`, and send a `principal_notify` page pointing at it. The
 * second half is a separate remembered tool call, and it was dropped in both
 * recorded occurrences of this failure (mem#779) — including one three days
 * after the rule shipped as always-loaded text, with that text verbatim in the
 * agent's context.
 *
 * The structural read: the failure is not recognizing severity (both agents
 * recognized it correctly) but that discharging it costs two remembered calls
 * at the moment attention is most degraded. This module removes one of them
 * from the agent entirely — a severity-marked ask pages by itself.
 *
 * ## What it is NOT
 *
 * It is not a replacement for the ask's ADR-008 primary transport. The ask
 * still routes to the inbox exactly as it did; this fires alongside, which is
 * the shape ADR-008's own matrix already uses for `authorization.approve`
 * ("Mesh notify on resolve"). Removing the page changes no ask state. The ask
 * carries the decision; the page carries only the attention.
 *
 * ## Purity
 *
 * Decision and message construction are pure and side-effect free so they are
 * trivially unit-testable; delivery is injected by the caller. That split is
 * also what lets the caller keep a delivery failure from ever failing ask
 * creation.
 *
 * @see docs/architecture/adr-008-attention-allocation-subsystem.md — the
 *       transport-binding matrix this extends with a severity axis
 * @see mem#779 — the two-recurrence record
 * @see mem#268 — match ADR-008 primitives by semantics, not nearest slot
 */

import type { Ask } from "./types";

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Trailing window the page rate limit counts over.
 *
 * 24h is the burst-detection window `decision-defaults.mdc §Thresholds`
 * already fixes for this project; reusing it keeps one number rather than
 * minting a second one for the same job.
 */
export const PAGE_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum pages delivered inside {@link PAGE_RATE_LIMIT_WINDOW_MS}.
 *
 * Grounded in observed cadence rather than a round number, per
 * `decision-defaults.mdc §Thresholds`: the two recorded operator-only incidents
 * (2026-07-31, 2026-08-03) are ~3 days apart, so genuine traffic on this
 * channel runs well under one per day. Three in 24h is roughly an
 * order of magnitude above the observed rate — high enough that a real incident
 * cluster still pages every time, low enough to bound a mis-tagging bug or a
 * loop to three notifications instead of hundreds.
 *
 * The trade is stated plainly because it is real and it cuts the wrong way at
 * the worst moment: if a fourth genuinely-severe incident occurs inside one
 * window, its page IS suppressed. That is why suppression is never silent —
 * {@link PageDecision} carries the dropped count, and the caller is required to
 * log it (`work-completion.mdc` — a silent cap reads as "covered everything").
 */
export const PAGE_RATE_LIMIT_MAX = 3;

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Why a page was or was not sent — carried so callers can log the reason. */
export type PageDecisionReason =
  /** The ask carries no severity marker. The overwhelmingly common case. */
  | "not-severity-marked"
  /** Severity-marked but not bound for the operator, so a page has no reader. */
  | "not-operator-routed"
  /** A page was already sent for this ask; re-sending would double-notify. */
  | "already-paged"
  /** The trailing-window ceiling is reached. */
  | "rate-limited"
  /** All conditions met. */
  | "send";

export interface PageDecision {
  send: boolean;
  reason: PageDecisionReason;
  /**
   * Pages already delivered in the trailing window, present only when the
   * decision was `rate-limited`, so the caller can log what it dropped rather
   * than suppressing silently.
   */
  recentPageCount?: number;
}

/** Inputs the decision needs beyond the Ask itself. */
export interface PageDecisionContext {
  /**
   * How many pages have been delivered inside the trailing window. The caller
   * supplies this (it is a repository query) so the decision stays pure.
   */
  recentPageCount: number;
}

/**
 * Decide whether an Ask should page the principal.
 *
 * Requires BOTH severity and operator routing. Severity alone is insufficient:
 * an `incident`-marked ask routed to a subagent has no human reader on the
 * other end, so a page would spend the principal's attention on something they
 * were never being asked to act on.
 *
 * `routingTarget` is read from the ask AFTER routing has run, so this must be
 * called on the persisted/routed ask rather than on creation input — otherwise
 * the target is not yet known and every ask reads as not-operator-routed.
 */
export function decidePrincipalPage(ask: Ask, ctx: PageDecisionContext): PageDecision {
  if (ask.severity !== "incident") {
    return { send: false, reason: "not-severity-marked" };
  }
  if (ask.routingTarget !== "operator") {
    return { send: false, reason: "not-operator-routed" };
  }
  if (ask.principalPagedAt) {
    return { send: false, reason: "already-paged" };
  }
  if (ctx.recentPageCount >= PAGE_RATE_LIMIT_MAX) {
    return { send: false, reason: "rate-limited", recentPageCount: ctx.recentPageCount };
  }
  return { send: true, reason: "send" };
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

/** Longest question excerpt carried inline before truncation. */
export const PAGE_QUESTION_EXCERPT_CHARS = 300;

export interface PageMessage {
  title: string;
  message: string;
  /** Task to route the page to a bound topic, when the ask names one. */
  taskId?: string;
}

/**
 * Collapse a question body to a single line for the page.
 *
 * The page is a notification on a phone, not the decision surface — the ask
 * itself is that, and the deeplink goes there. So this deliberately carries
 * enough to recognize the incident and no more.
 */
export function excerptQuestion(question: string): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  if (oneLine.length <= PAGE_QUESTION_EXCERPT_CHARS) return oneLine;
  return `${oneLine.slice(0, PAGE_QUESTION_EXCERPT_CHARS - 1).trimEnd()}…`;
}

/**
 * Build the page body.
 *
 * Carries the ask's readable short id when it has one, the full-uuid deeplink
 * (per `cockpit-deeplinks.mdc`: short ids are a LABEL form, the uuid is the
 * sole link target), and a one-line excerpt of the question.
 */
export function buildPageMessage(ask: Ask): PageMessage {
  const label = ask.shortId ? `ask#${ask.shortId}` : ask.id.slice(0, 8);
  const deeplink = `minsky://ask/${ask.id}`;
  const lines = [
    ask.title.trim(),
    "",
    excerptQuestion(ask.question),
    "",
    `Respond: [${label}](${deeplink})`,
  ];
  return {
    title: "Incident — needs you",
    message: lines.join("\n"),
    ...(ask.parentTaskId === undefined ? {} : { taskId: ask.parentTaskId }),
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * The repository surface this needs. Declared structurally rather than
 * importing `AskRepository` so a test can satisfy it with two functions.
 */
export interface PrincipalPageRepo {
  claimPrincipalPage(id: string, at: Date): Promise<{ claimed: boolean; ask: Ask }>;
  countPrincipalPagesSince(since: Date): Promise<number>;
}

/** Delivery + clock, injected so this module imports no transport. */
export interface PrincipalPageDeps {
  /** Deliver the page. MUST NOT throw — report failure in the result. */
  send(message: PageMessage): Promise<{ delivered: boolean; error?: string }>;
  /** Record a delivery failure durably (an event row), never swallow it. */
  recordFailure(ask: Ask, error: string): Promise<void>;
  now(): Date;
}

export interface PageOutcome {
  sent: boolean;
  reason: PageDecisionReason | "delivery-failed";
  /** Present when suppressed by the rate limit, for the caller's log line. */
  recentPageCount?: number;
  /** Present when delivery was attempted and failed. */
  error?: string;
}

/**
 * Page the principal about an Ask, if it warrants one.
 *
 * Never throws. A severity page failing must not fail ask creation — the ask IS
 * the decision record and losing it would be strictly worse than losing the
 * notification. Failures are recorded via `deps.recordFailure` rather than
 * swallowed, so a channel that has been dead for a week is visible rather than
 * inferred from an absence of pages.
 *
 * Order is deliberate: count → decide → CLAIM → send. Claiming before sending
 * means a crash mid-send leaves the page marked rather than re-firing on the
 * next attempt; see `claimPrincipalPage`'s docblock for why that direction is
 * the safer failure.
 */
export async function pagePrincipalForAsk(
  ask: Ask,
  repo: PrincipalPageRepo,
  deps: PrincipalPageDeps
): Promise<PageOutcome> {
  // Cheap structural checks first — they reject the overwhelming majority of
  // asks without touching the DB at all.
  const preCheck = decidePrincipalPage(ask, { recentPageCount: 0 });
  if (!preCheck.send && preCheck.reason !== "rate-limited") {
    return { sent: false, reason: preCheck.reason };
  }

  const now = deps.now();
  const since = new Date(now.getTime() - PAGE_RATE_LIMIT_WINDOW_MS);

  let recentPageCount: number;
  try {
    recentPageCount = await repo.countPrincipalPagesSince(since);
  } catch (err) {
    // Fail OPEN toward sending. A rate limiter that cannot read its own counter
    // must not become a reason the principal is not told about an incident —
    // over-notifying is recoverable, silence is what this whole mechanism
    // exists to prevent.
    const cause = err instanceof Error ? err.message : String(err);
    await deps.recordFailure(ask, `rate-limit count failed, proceeding to page: ${cause}`);
    recentPageCount = 0;
  }

  const decision = decidePrincipalPage(ask, { recentPageCount });
  if (!decision.send) {
    return {
      sent: false,
      reason: decision.reason,
      ...(decision.recentPageCount === undefined
        ? {}
        : { recentPageCount: decision.recentPageCount }),
    };
  }

  const claim = await repo.claimPrincipalPage(ask.id, now);
  if (!claim.claimed) {
    // Lost the race, or already paged. Either way somebody else is delivering.
    return { sent: false, reason: "already-paged" };
  }

  const result = await deps.send(buildPageMessage(claim.ask));
  if (!result.delivered) {
    const error = result.error ?? "delivery reported not-delivered with no error";
    await deps.recordFailure(claim.ask, error);
    return { sent: false, reason: "delivery-failed", error };
  }

  return { sent: true, reason: "send" };
}
