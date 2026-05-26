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
 * Three-state output (mt#2007 R1):
 *   - "configured" — one or more protection layers active → render per-field summary
 *   - "not configured" — GitHub responded but no protection rules exist (HTTP 404)
 *   - "unknown (API error)" — probe failed for non-404 reasons (auth, network, 5xx)
 *
 * The formatter is a pure function for testability — no I/O, no globals.
 */

/**
 * Output literal for non-404 probe failures. Exported so tests can assert
 * against the same constant rather than duplicating the magic string (and
 * so the eslint magic-string-duplication rule doesn't catch a repeat).
 */
export const PROBE_ERROR_OUTPUT = "unknown (API error)";

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
  probeError?: boolean;
}

/**
 * Decide whether ANY protection layer is active.
 *
 * Returns `false` when the GitHub API responded but no protection rules are
 * configured. Callers must check `probeError` separately if they need to
 * distinguish "no protection" from "probe failed."
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
 * Three terminal outputs:
 *   - "unknown (API error)" when `probeError === true` (non-404 probe failure)
 *   - "not configured" when the API responded but no protection layers are active
 *   - per-field summary otherwise
 *
 * Emission rules per field (mt#2007 R1):
 *   - `status_checks=[...]` — emitted only when the contexts list is non-empty
 *     (the field is informative only as a list of required checks; an empty
 *     list adds noise)
 *   - `reviews=N required` — always emitted (the operator always wants the count)
 *   - `dismiss_stale=true` — emitted only when true (false is the default
 *     non-protection state; emitting `dismiss_stale=false` adds noise)
 *   - `enforce_admins=<bool>` — emitted in both directions when observed
 *     (operator needs to know whether admins can bypass)
 *   - `force_push=<allowed|blocked>` — both directions when observed
 *   - `deletion=<allowed|blocked>` — both directions when observed
 *   - `require_code_owner=true` — only when true
 *   - `restrict_pushes=true` — only when true
 *
 * Fields whose observed value is `undefined` are omitted rather than rendered
 * as `unknown`. This keeps the output stable across GitHub API shape variations
 * and avoids printing fields the formatter couldn't observe.
 */
export function formatBranchProtectionLine(bp: BranchProtectionFields | undefined): string {
  // Probe-error path: distinct from "not configured" because state is unknown.
  if (bp?.probeError === true) {
    return PROBE_ERROR_OUTPUT;
  }

  if (!isBranchProtectionConfigured(bp) || !bp) {
    return "not configured";
  }

  const parts: string[] = [];

  // status_checks=[a,b,c] — emit only when non-empty (informative as a list).
  const contexts = bp.statusChecksContexts;
  if (contexts !== undefined && contexts.length > 0) {
    parts.push(`status_checks=[${contexts.join(",")}]`);
  }

  // reviews=N required — always emit so the operator sees the actual count.
  parts.push(`reviews=${bp.requiredReviews} required`);

  // dismiss_stale — emit only when true (false is the non-protection default).
  if (bp.dismissStaleReviews) {
    parts.push("dismiss_stale=true");
  }

  // enforce_admins — emit in both directions when observed (operator needs to
  // know whether admins can bypass protection).
  if (bp.enforceAdmins !== undefined) {
    parts.push(`enforce_admins=${bp.enforceAdmins}`);
  }

  // force_push / deletion — both directions when observed. Rendered as
  // "blocked" / "allowed" rather than raw booleans because the field
  // semantics invert (allow_force_pushes=false is the safer state).
  if (bp.allowForcePushes !== undefined) {
    parts.push(`force_push=${bp.allowForcePushes ? "allowed" : "blocked"}`);
  }
  if (bp.allowDeletions !== undefined) {
    parts.push(`deletion=${bp.allowDeletions ? "allowed" : "blocked"}`);
  }

  // require_code_owner_reviews — only when active.
  if (bp.requireCodeOwnerReviews) {
    parts.push("require_code_owner=true");
  }

  // restrict_pushes — only when active.
  if (bp.restrictPushes) {
    parts.push("restrict_pushes=true");
  }

  return parts.join(", ");
}
