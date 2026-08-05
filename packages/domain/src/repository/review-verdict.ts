/**
 * Review-verdict resolution: which review counts as a reviewer's STANDING
 * verdict when they have posted several.
 *
 * Two call paths ask that question and, before mt#3555, answered it
 * differently:
 *
 *   - The approval path (`getPullRequestApprovalStatus`) reduced per reviewer
 *     to the latest decision-bearing review (mt#1830) — correct in both
 *     directions.
 *   - The wait path (`findMatchingReview`) returned the FIRST review in
 *     listing order that passed its filters. Since `listReviews` returns
 *     GitHub's chronological order, that is the EARLIEST qualifying review:
 *     an APPROVED at 18:59 won over the same reviewer's CHANGES_REQUESTED at
 *     19:07 on the same commit, and the caller read the result as
 *     authorization to merge (mt#3555, observed on PR #2525).
 *
 * The primitives below are the single ordering rule both paths now call, so a
 * future correction lands once rather than per direction.
 *
 * They are deliberately shape-agnostic: the approval path holds Octokit-shaped
 * reviews (`user.login` / `submitted_at`) and the wait path holds
 * `ReviewListEntry` (`reviewerLogin` / `submittedAt`). Accessors are passed in
 * rather than normalizing to a common struct, so neither path pays a mapping
 * pass and neither shape becomes canonical.
 */

/**
 * The review states GitHub treats as decision-bearing for its own
 * `review_decision` field. Only these participate in the per-reviewer
 * latest-wins reduction: COMMENTED and PENDING are informational, so an
 * APPROVED followed by a COMMENTED from the same reviewer is still APPROVED,
 * and a CHANGES_REQUESTED followed by a COMMENTED is still CHANGES_REQUESTED.
 *
 * Module-private, exposed through `isDecisionBearing` — an exported mutable
 * Set is both a shared-state hazard and a `custom/no-domain-singleton`
 * violation.
 */
const DECISION_BEARING_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/** Whether a raw review state carries a verdict (see DECISION_BEARING_STATES). */
export function isDecisionBearing(state: string): boolean {
  return DECISION_BEARING_STATES.has(state);
}

/**
 * Accessors that project an arbitrary review shape onto the three fields the
 * ordering rule needs.
 */
export interface ReviewVerdictFields<T> {
  /** The reviewer's login, or null/undefined when the review is unattributed. */
  reviewerLogin: (review: T) => string | null | undefined;
  /** ISO-8601 submission timestamp, or null/undefined when absent. */
  submittedAt: (review: T) => string | null | undefined;
  /** The raw review state (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, …). */
  state: (review: T) => string;
}

/**
 * Compare two submission timestamps as ISO-8601 lexicographic strings, which
 * matches temporal ordering for valid ISO timestamps. A missing timestamp
 * sorts oldest (empty string < any real timestamp).
 */
function isAtOrAfter<T>(candidate: T, incumbent: T, fields: ReviewVerdictFields<T>): boolean {
  return (fields.submittedAt(candidate) ?? "") >= (fields.submittedAt(incumbent) ?? "");
}

/**
 * Reduce a review list to the latest DECISION-BEARING review per reviewer.
 *
 * `[CHANGES_REQUESTED then APPROVED]` from one reviewer collapses to APPROVED
 * (resolved); `[APPROVED then CHANGES_REQUESTED]` collapses to
 * CHANGES_REQUESTED (re-rejected). An interleaved COMMENTED does not supersede
 * either.
 *
 * Behavior notes (carried over from the mt#1830 implementation this
 * generalizes, since `getPullRequestApprovalStatus` still depends on them —
 * except the login-casing bullet, which corrects it on both paths):
 *   - Non-decision-bearing states are filtered out BEFORE the reduction; they
 *     never appear in the output.
 *   - Reviews with no reviewer login are dropped — there is no key to reduce on.
 *   - Logins are keyed case-INSENSITIVELY (PR #2655 R1). GitHub logins are
 *     case-insensitive at the platform level, so `Alice` and `alice` are one
 *     reviewer; keying on the raw string would split their history in two and
 *     let a superseded verdict survive as if it were a second reviewer's. The
 *     trailing `[bot]` suffix is deliberately NOT stripped here: that is a
 *     FILTER-side equivalence (a caller writing `minsky-reviewer` should match
 *     `minsky-reviewer[bot]`, per `normalizeReviewerLogin` in the wait path),
 *     not an identity rule — a human `foo` and an App `foo[bot]` are two
 *     distinct GitHub accounts and must not collapse into one key.
 *   - On a tie (identical timestamps), the LATER entry in the input array wins,
 *     which matches `listReviews`' chronological ordering.
 *   - The result is in Map insertion order, i.e. arbitrary. Callers needing a
 *     deterministic order sort it themselves (`pickLatestSubmitted` below).
 */
export function pickLatestDecisionPerReviewer<T>(
  reviews: readonly T[],
  fields: ReviewVerdictFields<T>
): T[] {
  const byReviewer = new Map<string, T>();
  for (const review of reviews) {
    if (!isDecisionBearing(fields.state(review))) continue;
    const login = fields.reviewerLogin(review);
    if (!login) continue;
    const key = login.toLowerCase();
    const incumbent = byReviewer.get(key);
    if (!incumbent || isAtOrAfter(review, incumbent, fields)) {
      byReviewer.set(key, review);
    }
  }
  return Array.from(byReviewer.values());
}

/**
 * Pick the single latest review by submission time. On a tie the later entry
 * in the input wins, matching `pickLatestDecisionPerReviewer`'s convention.
 * Returns undefined for an empty list.
 */
export function pickLatestSubmitted<T>(
  reviews: readonly T[],
  fields: ReviewVerdictFields<T>
): T | undefined {
  let latest: T | undefined;
  for (const review of reviews) {
    if (!latest || isAtOrAfter(review, latest, fields)) {
      latest = review;
    }
  }
  return latest;
}
