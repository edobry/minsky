/**
 * Does this deployment carry the build I am verifying? (mt#4583)
 *
 * `notBefore` (mt#3890) bounds a deployment's creation TIME, and time does not
 * identify WHICH change a deployment carries. On a busy main branch a
 * neighbouring merge's deployment lands inside the window and satisfies the
 * bound — observed 2026-08-25, when a deployment created ten seconds after a
 * merge returned SUCCESS and belonged to the PREVIOUS merge's workflow run.
 * The caller had no way to tell from the result.
 *
 * The knowledge was already in the codebase: `WaitForLatestOptions.notBefore`'s
 * own docblock states that the check is on time rather than commit and that
 * commit comparison is unavailable for image-source services. That caveat sat
 * in a docblock the caller does not read while the RETURN VALUE said `SUCCESS`
 * with no qualification. This module moves the caveat into the result.
 *
 * ## Why `indeterminate` is a first-class outcome, not a failure
 *
 * "I could not tell" and "it deployed" must not be the same value — that
 * identity IS the defect. For an image-source service the deployment record
 * carries no commit at all, so no amount of care makes the record answer the
 * question; the honest result is `indeterminate` plus the reason, and the
 * caller escalates to a channel that CAN answer (correlating the deploy
 * workflow run against the merge SHA, which crosses into the forge and is
 * deliberately not done here — see the task's Outcome).
 *
 * A probe that returns the same answer whether or not the thing happened is not
 * verification (mem#704).
 */

import type { DeploymentRecord } from "./types";

/**
 * Whether the deployment is the one carrying a named build.
 *
 * - `confirmed` — the deployment names the expected commit.
 * - `mismatch` — the deployment names a DIFFERENT commit. Positive evidence
 *   that this is someone else's deploy, which is stronger than not knowing.
 * - `indeterminate` — the record cannot answer. NOT a synonym for failure and
 *   NOT a synonym for success.
 */
export type BuildIdentity = "confirmed" | "mismatch" | "indeterminate";

export interface BuildIdentityAssessment {
  identity: BuildIdentity;
  /** Why, in one sentence a caller can surface verbatim. */
  reason: string;
}

/**
 * What a wait returns once identity is part of the answer.
 *
 * The verdict rides ON the result rather than being a separate call, so a
 * caller cannot read the status and skip the identity — reading `status:
 * "SUCCESS"` without `buildIdentity` requires deliberately ignoring a field
 * that is right there, which is a different act from never having been told.
 *
 * Declared here (not in `types.ts`) so the import runs one direction only:
 * this module already depends on `DeploymentRecord`.
 */
export interface DeploymentWaitResult extends DeploymentRecord {
  buildIdentity: BuildIdentity;
  buildIdentityReason: string;
}

/**
 * Shortest prefix treated as a meaningful commit reference.
 *
 * Git's own default abbreviation is 7; anything shorter collides often enough
 * that accepting it would manufacture `confirmed` verdicts. Grounded in git's
 * `core.abbrev` default rather than chosen for roundness.
 */
const MIN_SHA_PREFIX_LENGTH = 7;

/**
 * Prefix-tolerant commit comparison.
 *
 * Callers hold a full 40-char SHA from a merge result; a platform may report an
 * abbreviated one. Either may be the shorter, so the check is symmetric: the
 * shorter must be a prefix of the longer. Below `MIN_SHA_PREFIX_LENGTH` the
 * answer is "cannot tell" rather than a match — a 4-char prefix agreeing proves
 * very little and would be reported as `confirmed`.
 */
function shasReferToSameCommit(a: string, b: string): boolean | null {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left.length < MIN_SHA_PREFIX_LENGTH || right.length < MIN_SHA_PREFIX_LENGTH) return null;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return longer.startsWith(shorter);
}

/**
 * Classify whether `record` carries the build named by `expectCommitSha`.
 *
 * Pure: takes the record's identity fields and the expectation, returns the
 * verdict. No I/O, no clock, no platform call — so the wait loop's behaviour
 * around it is testable without patching anything it reaches.
 */
export function assessBuildIdentity(
  record: Pick<DeploymentRecord, "commitHash" | "imageDigest">,
  expectCommitSha?: string
): BuildIdentityAssessment {
  if (expectCommitSha === undefined || expectCommitSha.trim() === "") {
    return {
      identity: "indeterminate",
      reason:
        "No expected build was named. Pass expectCommitSha (the merge commit) to have this " +
        "call check WHICH change deployed rather than only that A deployment occurred.",
    };
  }

  const expected = expectCommitSha.trim();

  if (record.commitHash === null) {
    const digestNote =
      record.imageDigest === null
        ? "and no image digest either"
        : `(image digest ${record.imageDigest})`;
    return {
      identity: "indeterminate",
      reason:
        `This deployment carries no commit hash ${digestNote}, which is expected for an ` +
        "image-source service — the platform deploys a pushed image and never sees the commit. " +
        `Identity of ${expected} CANNOT be established from the deployment record. Correlate ` +
        "the deploy workflow run against the merge SHA, or assert something the CHANGE itself " +
        "produces (a migrated column, a new route responding).",
    };
  }

  const same = shasReferToSameCommit(record.commitHash, expected);

  if (same === null) {
    return {
      identity: "indeterminate",
      reason:
        `Commit reference too short to compare: deployment ${record.commitHash} against ` +
        `expected ${expected}. At least ${MIN_SHA_PREFIX_LENGTH} characters are needed for a ` +
        "prefix match to mean anything.",
    };
  }

  if (same) {
    return {
      identity: "confirmed",
      reason: `Deployment carries commit ${record.commitHash}, matching the expected ${expected}.`,
    };
  }

  return {
    identity: "mismatch",
    reason:
      `Deployment carries commit ${record.commitHash}, NOT the expected ${expected}. This is a ` +
      "different change's deployment — a deploy occurred, but not yours.",
  };
}

/**
 * True when the assessment is safe to read as "my change is deployed".
 *
 * Only `confirmed` qualifies. Exported so callers state the check once instead
 * of each re-deriving which verdicts count, which is where "indeterminate is
 * probably fine" creeps back in.
 */
export function buildIdentityIsConfirmed(assessment: BuildIdentityAssessment): boolean {
  return assessment.identity === "confirmed";
}
