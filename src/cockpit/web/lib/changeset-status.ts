/**
 * "Does this need me?" derivation for the changeset detail page (mt#3097).
 *
 * This is the product logic the page's lead strip renders. It is a PURE
 * function so the decision rules are testable without a DOM — the rules are the
 * feature, not the markup.
 *
 * Design (per the product-thinking supervision-loop frame):
 *
 * - **Needs-me over newest.** The ordering below is by what requires the
 *   principal, not by recency or by field order in the payload.
 * - **Anomaly over inventory.** A settled changeset collapses to one calm line;
 *   only a deviation earns the loud treatment.
 * - **Honest over lively.** Unknown CI is NEVER folded into a passing state.
 *   `checks: null` means "could not determine" (see ChangesetChecksSummary),
 *   so a merge-ready verdict that rests on CI says so explicitly rather than
 *   implying a green we did not observe.
 *
 * Lives in web/lib (not session-detail.ts) because web files cannot import a
 * runtime value from that server module — see changeset-title.ts.
 */
import type { ChangesetChecksSummary } from "../../session-detail";

/**
 * How much this changeset wants from the principal right now.
 *
 * - `needs-you` — an action or decision is waiting on the principal.
 * - `waiting`   — the system is working; nothing to do but it is not finished.
 * - `settled`   — terminal; nothing to do.
 */
export type NeedsYouLevel = "needs-you" | "settled" | "waiting";

export interface NeedsYouState {
  level: NeedsYouLevel;
  /** One-line lead, e.g. "Awaiting your merge". */
  headline: string;
  /** Optional qualifier, e.g. "CI state unknown" or the failing check names. */
  note?: string;
}

export interface NeedsYouInput {
  /** PR state: "open" | "merged" | "closed" | "draft" | "unknown". */
  state: string;
  /** Reviewer-bot approval: true / false (reviewed, not approved) / null (unknown). */
  approved: boolean | null;
  /** Null when the CI state could not be determined — NOT the same as zero checks. */
  checks: ChangesetChecksSummary | null;
}

/** Names of the checks that are actually failing, for the note line. */
export function failingCheckNames(checks: ChangesetChecksSummary | null): string[] {
  if (!checks) return [];
  return checks.checks
    .filter((c) => c.status === "completed" && c.conclusion !== null)
    .filter((c) => !["success", "neutral", "skipped"].includes(c.conclusion as string))
    .map((c) => c.name);
}

/**
 * Decide what the changeset needs from the principal.
 *
 * Rule order is deliberate — earlier rules win, most-urgent first:
 *
 * 1. Terminal states settle first: a merged/closed PR needs nothing, regardless
 *    of what CI or review say (a red check on an already-merged PR is history,
 *    not a demand).
 * 2. Failing CI outranks review state: it blocks the merge either way, and it
 *    is the more actionable signal.
 * 3. Changes-requested is the principal's cue to route work, not to merge.
 * 4. Draft is explicitly not-ready — never solicit a merge on it.
 * 5. Pending CI is "the system is working" — waiting, not needing.
 * 6. Only then: approved + not-failing → the merge is the principal's move.
 */
export function deriveNeedsYou({ state, approved, checks }: NeedsYouInput): NeedsYouState {
  // 1. Terminal — nothing is owed.
  if (state === "merged") {
    return { level: "settled", headline: "Merged" };
  }
  if (state === "closed") {
    return { level: "settled", headline: "Closed without merging" };
  }

  // 2. Failing CI blocks everything else and is the most actionable signal.
  const failing = failingCheckNames(checks);
  if (failing.length > 0) {
    return {
      level: "needs-you",
      headline: failing.length === 1 ? "CI failing" : `CI failing — ${failing.length} checks`,
      note: failing.slice(0, 3).join(", ") + (failing.length > 3 ? "…" : ""),
    };
  }

  // 3. The reviewer asked for changes — route the work, don't merge.
  if (approved === false) {
    return { level: "waiting", headline: "Awaiting reviewer approval" };
  }

  // 4. A draft is explicitly not ready to merge.
  if (state === "draft") {
    return { level: "waiting", headline: "Draft — not ready for review" };
  }

  // 5. CI still running: the system is working.
  if (checks && checks.pending > 0) {
    return {
      level: "waiting",
      headline: "CI running",
      note: `${checks.passed}/${checks.total} complete`,
    };
  }

  // 6. Approved and nothing failing — the merge is the principal's move.
  if (approved === true) {
    // Honest degradation: when CI could not be determined, say so rather than
    // implying a green we never observed.
    return {
      level: "needs-you",
      headline: "Awaiting your merge",
      note: checks ? undefined : "CI state unknown",
    };
  }

  // Open, no review yet, nothing failing.
  return { level: "waiting", headline: "Awaiting review" };
}
