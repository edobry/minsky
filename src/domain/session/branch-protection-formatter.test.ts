/**
 * Tests for the mt#2007 branch-protection formatter.
 *
 * The regression these tests guard against: the prior `session_pr_merge` CLI
 * line collapsed every protection field to a single boolean keyed off
 * `required_approving_review_count`. Branches with status checks +
 * force-push/deletion blocks but zero required reviewers (Minsky's actual
 * main config) were misreported as "not configured."
 *
 * Success-criteria mapping (from the mt#2007 spec):
 *   - Unit test (configured-but-no-reviews)  → mt#2007 success criterion 4
 *   - Unit test (truly unprotected)          → mt#2007 success criterion 5
 *
 * R1 additions (post-reviewer-bot CHANGES_REQUESTED, 2026-05-21):
 *   - Three-state output: 404 ≠ non-404 error; the formatter must render
 *     non-404 failures as "unknown (API error)" not "not configured."
 *   - `dismiss_stale` emitted only when true (false is non-protection noise).
 */

import { describe, test, expect } from "bun:test";
import {
  formatBranchProtectionLine,
  isBranchProtectionConfigured,
  PROBE_ERROR_OUTPUT,
  type BranchProtectionFields,
} from "./branch-protection-formatter";

const REVIEWS_1_REQUIRED = "reviews=1 required";

describe("formatBranchProtectionLine (mt#2007)", () => {
  test("AC4: configured-but-no-reviews — status checks present, reviews=0 → NOT 'not configured'", () => {
    // This is the exact shape that produced the originating-incident output
    // on PR #1204 (2026-05-21). main had:
    //   required_status_checks.contexts = ["build", "Prevent Placeholder Tests"]
    //   required_pull_request_reviews.required_approving_review_count = 0
    //   required_pull_request_reviews.dismiss_stale_reviews = true
    //   enforce_admins.enabled = false
    //   allow_force_pushes.enabled = false
    //   allow_deletions.enabled = false
    const bp: BranchProtectionFields = {
      requiredReviews: 0,
      dismissStaleReviews: true,
      requireCodeOwnerReviews: false,
      restrictPushes: false,
      statusChecksContexts: ["build", "Prevent Placeholder Tests"],
      enforceAdmins: false,
      allowForcePushes: false,
      allowDeletions: false,
      apiResponded: true,
    };

    const line = formatBranchProtectionLine(bp);

    // The critical regression check: previously this would have been
    // "not configured" because requiredReviews === 0.
    expect(line).not.toBe("not configured");
    expect(line).not.toBe(PROBE_ERROR_OUTPUT);
    expect(isBranchProtectionConfigured(bp)).toBe(true);

    // The line must name each active protection so the operator can read
    // the actual state without running a separate `--check` script.
    expect(line).toContain("status_checks=[build,Prevent Placeholder Tests]");
    expect(line).toContain("reviews=0 required");
    expect(line).toContain("dismiss_stale=true");
    expect(line).toContain("enforce_admins=false");
    expect(line).toContain("force_push=blocked");
    expect(line).toContain("deletion=blocked");
  });

  test("AC5 — truly unprotected (HTTP 404): API responded definitively → 'not configured'", () => {
    // mt#2007 R1: 404 is a definitive API response (apiResponded=true,
    // probeError=false). GitHub's 404 means "branch has no protection rules"
    // — that's a valid answer, not a probe failure. The github-pr-approval
    // populator sets apiResponded=true on 404 to make this state legible.
    const bp: BranchProtectionFields = {
      requiredReviews: 0,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: false,
      restrictPushes: false,
      statusChecksContexts: [],
      enforceAdmins: false,
      allowForcePushes: undefined,
      allowDeletions: undefined,
      apiResponded: true,
      probeError: false,
    };

    expect(formatBranchProtectionLine(bp)).toBe("not configured");
    expect(isBranchProtectionConfigured(bp)).toBe(false);
  });

  test("AC5 variant: API responded with all-default fields → 'not configured'", () => {
    // A second variant: the API responded with a protection object whose
    // every observed value is in the no-protection state.
    const bp: BranchProtectionFields = {
      requiredReviews: 0,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: false,
      restrictPushes: false,
      statusChecksContexts: [],
      enforceAdmins: false,
      allowForcePushes: true, // force-push allowed → no protection
      allowDeletions: true, //   deletion allowed   → no protection
      apiResponded: true,
      probeError: false,
    };

    expect(formatBranchProtectionLine(bp)).toBe("not configured");
    expect(isBranchProtectionConfigured(bp)).toBe(false);
  });

  test("R1: non-404 probe failure → 'unknown (API error)' (distinct from 'not configured')", () => {
    // mt#2007 R1 (reviewer-bot BLOCKING #1): auth / network / 5xx failures
    // are NOT the same as 404. The protection state is undeterminable; the
    // formatter must say so honestly rather than mislead the operator into
    // thinking the branch is unprotected.
    const bp: BranchProtectionFields = {
      requiredReviews: 0,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: false,
      restrictPushes: false,
      statusChecksContexts: [],
      apiResponded: false,
      probeError: true,
    };

    expect(formatBranchProtectionLine(bp)).toBe(PROBE_ERROR_OUTPUT);
  });

  test("R1: probeError takes precedence over field values", () => {
    // Defensive: even if the populator inconsistently sets field values
    // alongside probeError=true, the formatter must surface the probe
    // failure rather than render stale field values as if they were live.
    const bp: BranchProtectionFields = {
      requiredReviews: 1,
      dismissStaleReviews: true,
      requireCodeOwnerReviews: false,
      restrictPushes: false,
      statusChecksContexts: ["build"],
      probeError: true,
    };

    expect(formatBranchProtectionLine(bp)).toBe(PROBE_ERROR_OUTPUT);
  });

  test("undefined input → 'not configured' (no metadata at all)", () => {
    expect(formatBranchProtectionLine(undefined)).toBe("not configured");
    expect(isBranchProtectionConfigured(undefined)).toBe(false);
  });

  test("reviews=2 alone is enough to trigger 'configured' verdict", () => {
    // A repo that requires 2 approving reviews but has no other protection
    // is still "configured" — and the line must say so.
    const bp: BranchProtectionFields = {
      requiredReviews: 2,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: false,
      restrictPushes: false,
      statusChecksContexts: [],
      enforceAdmins: false,
      apiResponded: true,
    };

    const line = formatBranchProtectionLine(bp);
    expect(line).not.toBe("not configured");
    expect(line).toContain("reviews=2 required");
  });

  test("only force_push=blocked active → 'configured'", () => {
    // Even a single protection layer (force-push blocked alone) is enough to
    // count as configured. This is the discrimination point the old code
    // missed entirely.
    const bp: BranchProtectionFields = {
      requiredReviews: 0,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: false,
      restrictPushes: false,
      statusChecksContexts: [],
      allowForcePushes: false,
      apiResponded: true,
    };

    const line = formatBranchProtectionLine(bp);
    expect(line).not.toBe("not configured");
    expect(line).toContain("force_push=blocked");
  });

  test("require_code_owner_reviews=true surfaced when active", () => {
    const bp: BranchProtectionFields = {
      requiredReviews: 1,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: true,
      restrictPushes: false,
      statusChecksContexts: [],
      apiResponded: true,
    };

    const line = formatBranchProtectionLine(bp);
    expect(line).toContain("require_code_owner=true");
  });

  test("restrict_pushes=true surfaced when active", () => {
    const bp: BranchProtectionFields = {
      requiredReviews: 1,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: false,
      restrictPushes: true,
      statusChecksContexts: [],
      apiResponded: true,
    };

    const line = formatBranchProtectionLine(bp);
    expect(line).toContain("restrict_pushes=true");
  });

  test("R1: dismiss_stale=false is OMITTED (noise reduction)", () => {
    // mt#2007 R1 (reviewer-bot BLOCKING #2): `dismiss_stale=false` is the
    // non-protection default; emitting it adds noise without surfacing
    // protection. Only emit when true.
    const bp: BranchProtectionFields = {
      requiredReviews: 1,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: false,
      restrictPushes: false,
      statusChecksContexts: [],
      apiResponded: true,
    };

    const line = formatBranchProtectionLine(bp);
    expect(line).toContain(REVIEWS_1_REQUIRED);
    expect(line).not.toContain("dismiss_stale");
  });

  test("R1: empty statusChecksContexts is OMITTED (only emit when list has entries)", () => {
    // mt#2007 R1 (reviewer-bot BLOCKING #2): an empty status_checks=[] adds
    // noise. Only emit the field when there's at least one required check.
    const bp: BranchProtectionFields = {
      requiredReviews: 1,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: false,
      restrictPushes: false,
      statusChecksContexts: [],
      apiResponded: true,
    };

    const line = formatBranchProtectionLine(bp);
    expect(line).toContain(REVIEWS_1_REQUIRED);
    expect(line).not.toContain("status_checks=");
  });

  test("undefined optional fields are omitted (not rendered as 'unknown')", () => {
    // Older code paths (or future schema additions) may leave fields
    // undefined. The formatter must omit them rather than print
    // "field=undefined" — keeps output stable across API shape variations.
    const bp: BranchProtectionFields = {
      requiredReviews: 1,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: false,
      restrictPushes: false,
      // statusChecksContexts, enforceAdmins, allowForcePushes, allowDeletions
      // all left undefined.
      apiResponded: true,
    };

    const line = formatBranchProtectionLine(bp);
    expect(line).toContain(REVIEWS_1_REQUIRED);
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("status_checks=");
    expect(line).not.toContain("enforce_admins=");
    expect(line).not.toContain("force_push=");
    expect(line).not.toContain("deletion=");
    expect(line).not.toContain("dismiss_stale");
  });
});

describe("isBranchProtectionConfigured (mt#2007)", () => {
  test("apiResponded=false short-circuits to false (caller checks probeError separately)", () => {
    expect(
      isBranchProtectionConfigured({
        requiredReviews: 0,
        dismissStaleReviews: false,
        requireCodeOwnerReviews: false,
        restrictPushes: false,
        apiResponded: false,
        probeError: true,
      })
    ).toBe(false);
  });

  test("any single protection signal flips to true", () => {
    const base: BranchProtectionFields = {
      requiredReviews: 0,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: false,
      restrictPushes: false,
      apiResponded: true,
    };

    expect(isBranchProtectionConfigured({ ...base, statusChecksContexts: ["build"] })).toBe(true);
    expect(isBranchProtectionConfigured({ ...base, requiredReviews: 1 })).toBe(true);
    expect(isBranchProtectionConfigured({ ...base, dismissStaleReviews: true })).toBe(true);
    expect(isBranchProtectionConfigured({ ...base, requireCodeOwnerReviews: true })).toBe(true);
    expect(isBranchProtectionConfigured({ ...base, restrictPushes: true })).toBe(true);
    expect(isBranchProtectionConfigured({ ...base, enforceAdmins: true })).toBe(true);
    expect(isBranchProtectionConfigured({ ...base, allowForcePushes: false })).toBe(true);
    expect(isBranchProtectionConfigured({ ...base, allowDeletions: false })).toBe(true);
  });
});
