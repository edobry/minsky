/**
 * Format the branch-protection summary line for `session_pr_merge`'s CLI output.
 *
 * mt#2007: the previous line was
 *
 *     const branchProtection = required > 0 ? `enabled (requires ${required})` : `not configured`;
 *
 * which collapsed every protection field to a single boolean keyed off
 * `required_approving_review_count`. Branches with status checks + force-push
 * /deletion blocks but zero required reviewers (Minsky's actual main config)
 * were misreported as "not configured."
 *
 * This formatter consumes the per-field observed values now carried in
 * `ApprovalStatus.metadata.github.branchProtection` and emits a single line
 * naming each active protection. It is the operator-visible mirror of
 * `scripts/set-branch-protection.ts --check`.
 *
 * The formatter is a pure function for testability — no I/O, no globals.
 */

/**
 * Subset of `ApprovalStatus.metadata.github.branchProtection` that the
 * formatter reads. Kept structural rather than importing the full
 * `ApprovalStatus` type so the formatter can be unit-tested with synthetic
 * inputs without dragging in the entire metadata shape.
 */
export interface BranchProtectionFields {
  requiredReviews: number;
  dismissStaleReviews: boolean;
  requireCodeOwnerReviews: boolean;
  restrictPushes: boolean;
  statusChecksContexts?: string[];
  enforceAdmins?: boolean;
  allowForcePushes?: boolean;
  allowDeletions?: boolean;
  apiResponded?: boolean;
}

/**
 * Decide whether ANY protection layer is active.
 *
 * Returns `false` when the GitHub API responded 404 (no protection at all,
 * `apiResponded === false`) OR when the API responded with a protection
 * object whose every observed field is in the "no protection" state.
 *
 * The fields considered "protection signals":
 *   - `statusChecksContexts.length > 0` — required checks defined
 *   - `requiredReviews > 0` — required approving reviews
 *   - `dismissStaleReviews === true` — stale-review dismissal active
 *   - `requireCodeOwnerReviews === true` — CODEOWNERS gate active
 *   - `restrictPushes === true` — push restrictions configured
 *   - `enforceAdmins === true` — admin enforcement on
 *   - `allowForcePushes === false` — force-push blocked
 *   - `allowDeletions === false` — branch deletion blocked
 */
export function isBranchProtectionConfigured(bp: BranchProtectionFields | undefined): boolean {
  if (!bp) return false;
  if (bp.apiResponded === false) return false;
  if ((bp.statusChecksContexts?.length ?? 0) > 0) return true;
  if (bp.requiredReviews > 0) return true;
  if (bp.dismissStaleReviews) return true;
  if (bp.requireCodeOwnerReviews) return true;
  if (bp.restrictPushes) return true;
  if (bp.enforceAdmins === true) return true;
  if (bp.allowForcePushes === false) return true;
  if (bp.allowDeletions === false) return true;
  return false;
}

/**
 * Render the per-field summary that follows "Branch protection:" in the
 * merge CLI's output. Matches the format named in mt#2007 success criterion 2:
 *
 *     status_checks=[build,Prevent Placeholder Tests], reviews=0 required,
 *     dismiss_stale=true, enforce_admins=false, force_push=blocked,
 *     deletion=blocked
 *
 * When the protection API responded but no protection is configured, or when
 * the API did not respond (404 / auth failure), returns `"not configured"`.
 *
 * Fields whose observed value is `undefined` (the GitHub API did not carry
 * them, or the older code path that does not populate them) are omitted from
 * the summary rather than rendered as `unknown`. This keeps the output stable
 * across GitHub API shape variations and avoids printing fields the formatter
 * couldn't observe.
 */
export function formatBranchProtectionLine(bp: BranchProtectionFields | undefined): string {
  if (!isBranchProtectionConfigured(bp) || !bp) {
    return "not configured";
  }

  const parts: string[] = [];

  // status_checks=[a,b,c] — always show when there are required checks, even
  // if the list is empty (presence is informative).
  if (bp.statusChecksContexts !== undefined) {
    parts.push(`status_checks=[${bp.statusChecksContexts.join(",")}]`);
  }

  // reviews=N required — the spec calls this `reviews=0 required` form
  // explicitly. Always emit so the operator sees the actual count.
  parts.push(`reviews=${bp.requiredReviews} required`);

  // dismiss_stale — surface as boolean. Skipped when undefined (can't happen
  // with the current populator since the field is non-optional in the shape,
  // but defensive against schema evolution).
  parts.push(`dismiss_stale=${bp.dismissStaleReviews}`);

  // enforce_admins — only emit when observed.
  if (bp.enforceAdmins !== undefined) {
    parts.push(`enforce_admins=${bp.enforceAdmins}`);
  }

  // force_push / deletion — rendered as "blocked" / "allowed" rather than
  // raw booleans because the field semantics invert (allow_force_pushes=false
  // is the safer state).
  if (bp.allowForcePushes !== undefined) {
    parts.push(`force_push=${bp.allowForcePushes ? "allowed" : "blocked"}`);
  }
  if (bp.allowDeletions !== undefined) {
    parts.push(`deletion=${bp.allowDeletions ? "allowed" : "blocked"}`);
  }

  // require_code_owner_reviews — surface only when active (the silent
  // default of false is uninformative in the summary line).
  if (bp.requireCodeOwnerReviews) {
    parts.push("require_code_owner=true");
  }

  // restrict_pushes — surface only when active (same rationale).
  if (bp.restrictPushes) {
    parts.push("restrict_pushes=true");
  }

  return parts.join(", ");
}
