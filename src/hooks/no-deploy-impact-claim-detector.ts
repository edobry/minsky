/**
 * Verify a `[no-deploy-impact]` claim against the predicate that decides the same
 * question (mt#4397).
 *
 * ## Why this exists
 *
 * `[no-deploy-impact]` asserts that `isDeploySurfaceFile` returns false for every
 * changed file. Until this check, nothing verified it — the tag was an author's
 * claim written at a seam where a deterministic predicate answering the identical
 * question already sat in the repo, imported by three other consumers.
 *
 * Four instances in ~17 days, each after the previous fix shipped:
 *
 * - R1 (PR #3104) and R2 (PR #3148) applied a stale pattern LIST. Answered by
 *   mt#4269, which DELETED the stale enumeration from `/implement-task` §10 and
 *   replaced it with a runnable predicate recipe. Correct fix for that cause.
 * - R3 (PR #3203) ran the predicate — over the files the author had EDITED. A
 *   pre-commit step then regenerated and re-staged `src/generated/interceptor-catalog.json`
 *   into the same commit, which IS deploy surface. The check was honest and its
 *   input went stale after it ran.
 * - R4 (PR #3219) did not run the predicate at all.
 *
 * The tier is the finding, not the wording. R3's fix was encoded as a memory
 * (mem#1162) stating the exact procedure that would have prevented R4; ~21 hours
 * later R4 happened, and that record's `accessCount` was still 0. A memory nothing
 * retrieves is not a control. Note the failure got SIMPLER across recurrences —
 * stale list, then stale input, then skipped entirely — which is what a
 * wrong-tier diagnosis looks like from the outside.
 *
 * ## Why `commit-msg` and not `pre-commit`
 *
 * Two reasons, and the second is the one that also closes R3:
 *
 * 1. Git's `pre-commit` hook does not receive the commit message. `commit-msg`
 *    does, as its first argument.
 * 2. `commit-msg` runs AFTER `pre-commit`, so every regeneration-and-re-stage step
 *    has already run. The staged set read here is the set that actually ships —
 *    which is precisely the input R3 could not obtain, because it enumerated
 *    before those steps mutated the commit.
 *
 * ## Scope
 *
 * This checks a claim in a COMMIT MESSAGE, which cannot be edited once pushed.
 * The sibling hole — `require-deploy-verification-before-merge.ts` honoring an
 * unverified `[no-deploy-impact]` tag on the PR TITLE as a bypass — is real and
 * deliberately out of scope; different seam, different failure mode.
 */

import { isDeploySurfaceFile } from "@minsky/domain/deployment/deploy-surface";

/** Operator override, registered in the two conventional places. */
export const NO_DEPLOY_IMPACT_CLAIM_OVERRIDE_ENV = "MINSKY_SKIP_NO_DEPLOY_IMPACT_CHECK";

/**
 * Spans wrapped in backticks are DISCUSSION of the tag, not a claim.
 *
 * A commit message that explains the tag — "the `[no-deploy-impact]` tag was
 * false", "do not write `[no-deploy-impact]` without running the predicate" — is
 * exactly what this task's own commits do, and what any future doc or
 * retrospective commit about this class will do. Matching those would make the
 * check fire hardest on the people writing about it.
 *
 * Deliberately narrow: only backticked spans are exempt. A bare tag in prose is a
 * claim, wherever it appears in the message. This mirrors the conflict-marker
 * detector's fenced-block exemption, which solved the same "documenting the thing
 * you detect" problem.
 */
function stripQuotedSpans(message: string): string {
  return message.replace(/`[^`]*`/g, " ");
}

/** True when the message ASSERTS the tag, as opposed to discussing it. */
export function messageClaimsNoDeployImpact(message: string): boolean {
  return /\[no-deploy-impact\]/i.test(stripQuotedSpans(message));
}

export interface FalseNoDeployImpactClaim {
  /** The staged files for which the predicate returns true — the falsifiers. */
  readonly deploySurfaceFiles: readonly string[];
}

/**
 * Returns the violation when the message claims no deploy impact and the staged
 * set contradicts it; `null` when the claim is absent or true.
 *
 * Pure: the staged list is an argument, so the decision is testable without git.
 * The predicate is imported from `packages/domain/src/deployment/deploy-surface.ts`
 * rather than re-declared — a second pattern list is the mt#3023/mt#3523 drift
 * this class already produced twice (mt#2647 set the precedent of re-exporting
 * rather than copying).
 */
export function evaluateNoDeployImpactClaim(
  message: string,
  stagedFiles: readonly string[]
): FalseNoDeployImpactClaim | null {
  if (!messageClaimsNoDeployImpact(message)) return null;

  const deploySurfaceFiles = stagedFiles.filter((file) => isDeploySurfaceFile(file));
  if (deploySurfaceFiles.length === 0) return null;

  return { deploySurfaceFiles };
}

/**
 * The denial text.
 *
 * Names the uneditability explicitly. The whole point of firing at `commit-msg`
 * rather than at merge is that the author can still fix the message; a denial
 * that does not say so invites the author to push and retract in the PR body,
 * which is what R3 and R4 both had to do.
 */
export function formatFalseNoDeployImpactClaim(violation: FalseNoDeployImpactClaim): string {
  const list = violation.deploySurfaceFiles.map((f) => `     - ${f}`).join("\n");
  return (
    `Commit message claims [no-deploy-impact], but ${violation.deploySurfaceFiles.length} ` +
    `staged file(s) ARE deploy surface:\n${list}\n` +
    `   The tag asserts isDeploySurfaceFile() is false for every changed file; it is not.\n` +
    `   Fix the message now — a pushed commit message cannot be edited, and the only\n` +
    `   remaining remedy is a retraction in the PR body.\n` +
    `   Override (audit-logged): ${NO_DEPLOY_IMPACT_CLAIM_OVERRIDE_ENV}=1`
  );
}
