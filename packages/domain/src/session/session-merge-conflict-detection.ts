/**
 * Session Merge Conflict Detection (mt#2614)
 *
 * Extracted from session-merge-operations.ts, where this was one of three
 * mixed concerns (conflict detection / cleanup / status-update) in a
 * 1,426-line file. This module owns the conflict-detection concern: is a
 * session's PR actually mergeable right now, and if not, does an
 * operator-override waiver or audited bypass apply?
 *
 * Two entry points:
 *   - validateSessionApprovedForMerge: the cheap synchronous precondition
 *     check (has a PR / PR branch, is it approved) run for every merge.
 *   - checkGitHubMergeApprovalBlockers: the GitHub-specific API-backed check
 *     (approval status, branch protection, reviewer-silence waiver, audited
 *     force-bypass) run only for GitHub-backed sessions.
 */

import { log } from "@minsky/shared/logger";
import { ValidationError } from "../errors/index";
import { getErrorMessage } from "../errors";
import type { SessionRecord } from "./types";
import type { RepositoryBackend } from "../repository/index";
import { resolveBotIdentities } from "../configuration/bot-identity";
import { formatBranchProtectionLine } from "./branch-protection-formatter";

/**
 * CRITICAL: Validate that a session is approved before allowing merge
 *
 * This function enforces the approval requirement across all merge operations.
 * NO MERGE SHOULD EVER BYPASS THIS VALIDATION.
 */
export function validateSessionApprovedForMerge(
  sessionRecord: SessionRecord,
  sessionId: string
): void {
  // For GitHub backend, presence of a recorded PR is sufficient for further checks
  if (sessionRecord.backendType === "github") {
    if (!sessionRecord.pullRequest) {
      throw new ValidationError(
        `❌ MERGE REJECTED: Session "${sessionId}" has no GitHub pull request.\n` +
          `   Create a PR with 'minsky session pr create', or if a PR already exists on GitHub,\n` +
          `   repair the linkage with 'minsky session repair --pr-state'`
      );
    }
    // Approval and mergeability are delegated to the GitHub backend in mergeSessionPr()
    return;
  }

  // Non-GitHub sessions require a PR branch and explicit approval flag
  if (!sessionRecord.prBranch) {
    throw new ValidationError(
      `❌ MERGE REJECTED: Session "${sessionId}" has no PR branch.\n` +
        `   Create a PR first with 'minsky session pr create'`
    );
  }

  if (sessionRecord.prApproved !== true) {
    throw new ValidationError(
      `❌ MERGE REJECTED: Invalid approval state for session "${sessionId}". PR must be approved before merging.`
    );
  }

  log.debug("Session approval validation passed", {
    sessionId,
    prBranch: sessionRecord.prBranch,
    prApproved: sessionRecord.prApproved,
  });
}

/**
 * Params checkGitHubMergeApprovalBlockers needs from mergeSessionPr's
 * SessionMergeParams. Declared locally (not imported from
 * session-merge-operations.ts) to avoid a circular import between the two
 * modules.
 */
export interface MergeBlockerCheckParams {
  json?: boolean;
  acceptStaleReviewerSilence?: boolean;
  forceBypass?: boolean;
  bypassReason?: string;
}

export interface MergeBlockerCheckResult {
  /**
   * Canonical audit-trail signature to thread into the merge-commit body
   * when an audited force-bypass (mt#2215) was applied. Undefined otherwise.
   */
  bypassAuditMessage?: string;
}

/**
 * Check GitHub PR approval status and merge blockers before allowing a merge
 * to proceed. This is the conflict-detection concern extracted from
 * mergeSessionPr (mt#2614): is this PR actually mergeable right now, and if
 * not, does an operator-override waiver (acceptStaleReviewerSilence) or an
 * audited reviewer-convergence-failure bypass (forceBypass, mt#2215) apply?
 *
 * No-op (returns {}) when the session isn't a GitHub PR — these are all
 * GitHub-API-backed checks; non-GitHub sessions are covered entirely by
 * validateSessionApprovedForMerge's synchronous precondition check.
 */
export async function checkGitHubMergeApprovalBlockers(
  sessionRecord: SessionRecord,
  repositoryBackend: RepositoryBackend,
  params: MergeBlockerCheckParams
): Promise<MergeBlockerCheckResult> {
  const hasGitHubPr = sessionRecord.pullRequest && sessionRecord.backendType === "github";
  if (!(hasGitHubPr && sessionRecord.pullRequest)) {
    return {};
  }

  // Holds the canonical bypass audit signature when an audited force-bypass (mt#2215) is
  // applied; threaded into the merge commit body by the caller via mergeOptions.
  let bypassAuditMessage: string | undefined;

  if (!params.json) {
    log.cli(`🔍 Checking GitHub PR approval & branch protection...`);
  }

  try {
    const approvalStatus = await repositoryBackend.review.getApprovalStatus(
      sessionRecord.pullRequest.number
    );

    if (!params.json) {
      const approvals = approvalStatus.approvals?.length || 0;
      const required = approvalStatus.requiredApprovals ?? 0;
      // mt#2007: read the full branch-protection shape (status checks,
      // dismiss-stale, enforce_admins, force_push, deletion, etc.) from the
      // metadata block populated in github-pr-approval.ts. The previous
      // "required > 0 ? configured : not configured" collapse misreported
      // every protection state where reviews=0 but other protections were
      // active.
      const bp = approvalStatus.metadata?.github?.branchProtection;
      const branchProtection = formatBranchProtectionLine(bp);
      const approvalLine =
        required > 0
          ? `${approvals}/${required} approvals`
          : approvals > 0
            ? `${approvals} approvals`
            : `no approvals required`;
      log.cli(`• Approval status: ${approvalLine}`);
      log.cli(`• Branch protection: ${branchProtection}`);
    }

    // Track whether the waiver path was taken (used for B1: correct success message)
    let waiverApplied = false;
    // Track whether the audited force-bypass path (mt#2215) was taken.
    let bypassApplied = false;

    if (!approvalStatus.isApproved) {
      // Check whether the operator-override waiver applies before blocking.
      // Waiver conditions (ALL must hold):
      //   1. acceptStaleReviewerSilence flag explicitly set to true.
      //   2. PR author is the configured bot identity (default minsky-ai[bot]).
      //   3. No CHANGES_REQUESTED review (substantive findings unaddressed).
      //   4. No reviewer-bot review (webhook-miss class).
      //   5. At least one COMMENTED review from the SAME identity as the PR author.
      //
      // Bot identities resolve from config (github.botIdentityLogin /
      // reviewer.botLogin) with Minsky's own App logins as defaults (mt#2392),
      // so external projects can satisfy the waiver with their own bots.
      const { botIdentityLogin, reviewerBotLogin } = resolveBotIdentities();
      const rawReviews = approvalStatus.rawReviews ?? [];
      const prAuthor = sessionRecord.pullRequest.github?.author ?? "";
      const isPrAuthorBot = prAuthor.toLowerCase() === botIdentityLogin.toLowerCase();
      // Exclude DISMISSED reviews from CHANGES_REQUESTED check (stale reviews that no longer block)
      const hasChangesRequested = rawReviews
        .filter((r) => r.state !== "DISMISSED")
        .some((r) => r.state === "CHANGES_REQUESTED");
      const hasReviewerBotReview = rawReviews.some(
        (r) => r.reviewerLogin.toLowerCase() === reviewerBotLogin.toLowerCase()
      );
      // Waiver requires COMMENTED review from the SAME identity as the PR author.
      // Normalize both sides to lowercase: GitHub logins are case-insensitive.
      const prAuthorLower = prAuthor.toLowerCase();
      const hasCommentedReview = rawReviews.some(
        (r) => r.state === "COMMENTED" && r.reviewerLogin.toLowerCase() === prAuthorLower
      );

      const waiverEligible =
        params.acceptStaleReviewerSilence === true &&
        isPrAuthorBot &&
        !hasChangesRequested &&
        !hasReviewerBotReview &&
        hasCommentedReview;

      if (params.forceBypass === true) {
        // ── Audited reviewer-convergence-failure bypass (mt#2215) ──────────────
        // The CHANGES_REQUESTED-present path the acceptStaleReviewerSilence waiver refuses.
        const reason = (params.bypassReason ?? "").trim();
        if (!reason) {
          throw new ValidationError(
            `❌ forceBypass requires a non-empty bypassReason explaining why the bypass is ` +
              `justified (e.g. the verified false-positive and its verification, or the ` +
              `reviewer convergence-failure class).`
          );
        }

        // Precondition: at least one prior review round must have occurred.
        if (rawReviews.length < 1) {
          throw new ValidationError(
            `❌ forceBypass requires at least one prior review round to have occurred; none ` +
              `found on PR #${sessionRecord.pullRequest.number}. The bypass is for reviewer ` +
              `convergence FAILURE, not for skipping review entirely.`
          );
        }

        // Precondition: CI must not be failing (checked where status-check data is available).
        const statusChecks = approvalStatus.metadata?.github?.statusChecks ?? [];
        const failingChecks = statusChecks
          .filter((c) => c.state === "failure")
          .map((c) => c.context);
        if (failingChecks.length > 0) {
          throw new ValidationError(
            `❌ forceBypass refused: required status check(s) failing on PR ` +
              `#${sessionRecord.pullRequest.number}: ${failingChecks.join(", ")}. ` +
              `CI must be green on HEAD before a convergence-failure bypass.`
          );
        }

        // Other merge blockers (draft / conflict / not-open) still apply.
        if (approvalStatus.hasNonApprovalMergeBlockers) {
          const blockerDesc =
            approvalStatus.nonApprovalBlockerDescription ?? approvalStatus.prState ?? "unknown";
          throw new ValidationError(
            `❌ forceBypass refused: a non-approval merge blocker is active on PR ` +
              `#${sessionRecord.pullRequest.number} (${blockerDesc}). The bypass addresses the ` +
              `review gate only — resolve the underlying blocker (draft state, merge conflicts, ` +
              `closed PR) before retrying.`
          );
        }

        // Precondition: a present (non-DISMISSED) CHANGES_REQUESTED review MUST exist.
        // forceBypass is specifically the CHANGES_REQUESTED-present path (verified
        // false-positive / reviewer self-reversal / leakage-stale blocking review). The
        // reviewer-ABSENT case (webhook-miss, no CHANGES_REQUESTED) is covered by
        // acceptStaleReviewerSilence instead. Without this guard, any not-approved PR with
        // >=1 review and green CI could be force-merged, broadening the bypass beyond intent.
        const blockingReviews = rawReviews.filter((r) => r.state === "CHANGES_REQUESTED");
        if (blockingReviews.length === 0) {
          throw new ValidationError(
            `❌ forceBypass refused: no present (non-DISMISSED) CHANGES_REQUESTED review on PR ` +
              `#${sessionRecord.pullRequest.number}. forceBypass is the CHANGES_REQUESTED-present ` +
              `path. If the merge is blocked only by reviewer ABSENCE (webhook-miss, no ` +
              `CHANGES_REQUESTED), use acceptStaleReviewerSilence instead.`
          );
        }

        // Fold-in dismissal: dismiss every present CHANGES_REQUESTED review using the supplied
        // reason as evidence, clearing the GitHub-side review gate before merge. Uses the
        // already-created repositoryBackend.review.dismissReview primitive — the same call
        // session_pr_review_dismiss wraps — rather than re-creating a backend.
        const dismissedReviewIds: string[] = [];
        const dismissReview = repositoryBackend.review.dismissReview?.bind(
          repositoryBackend.review
        );
        for (const review of blockingReviews) {
          const reviewIdNum = Number(review.reviewId);
          if (!Number.isInteger(reviewIdNum) || reviewIdNum <= 0) {
            log.warn(`forceBypass: skipping non-numeric review id "${review.reviewId}" on dismiss`);
            continue;
          }
          if (!dismissReview) {
            log.warn(
              `forceBypass: repository backend does not support review dismissal; ` +
                `review ${review.reviewId} left in place (merge will still proceed)`
            );
            continue;
          }
          try {
            await dismissReview(sessionRecord.pullRequest.number, reviewIdNum, {
              message: reason,
            });
            dismissedReviewIds.push(review.reviewId);
          } catch (dismissError) {
            // COMMENT-event reviews cannot be dismissed (GitHub 422); merge can still proceed.
            log.warn(
              `forceBypass: could not dismiss review ${review.reviewId} on PR ` +
                `#${sessionRecord.pullRequest.number}: ${getErrorMessage(dismissError)}`
            );
          }
        }

        const dismissedSummary = dismissedReviewIds.length ? dismissedReviewIds.join(", ") : "none";
        log.info(
          `FORCE-BYPASS: audited reviewer-convergence-failure bypass applied for PR ` +
            `#${sessionRecord.pullRequest.number}. Reason: ${reason}. ` +
            `Review rounds observed: ${rawReviews.length}. ` +
            `CHANGES_REQUESTED dismissed: ${dismissedSummary}. ` +
            `Per feedback_self_authored_pr_merge_constraints.`
        );
        if (!params.json) {
          log.cli(
            `⚠️  Audited force-bypass applied (mt#2215): ${reason}. ` +
              `Canonical audit signature will be written to the merge commit.`
          );
        }

        // Canonical audit-trail signature — consumed by /verify-task's bypass-merge closeout.
        bypassAuditMessage =
          `\n\nBot self-approval bypass per feedback_self_authored_pr_merge_constraints` +
          `\nReason: ${reason}` +
          `\nReview rounds observed: ${rawReviews.length}` +
          `\nCHANGES_REQUESTED dismissed: ${dismissedSummary}`;
        bypassApplied = true;
        // Fall through to merge -- do not throw.
      } else if (waiverEligible) {
        // Waiver only addresses the reviewer-bot-silence blocker, not other merge blockers.
        // Use hasNonApprovalMergeBlockers rather than canMerge: canMerge is always false
        // when isApproved=false (it includes isApproved in its computation), making it
        // permanently unreachable here. hasNonApprovalMergeBlockers is computed independently
        // of approval state and accurately reflects draft/conflict/closed blockers (B1).
        if (approvalStatus.hasNonApprovalMergeBlockers) {
          const blockerDesc =
            approvalStatus.nonApprovalBlockerDescription ?? approvalStatus.prState ?? "unknown";
          throw new ValidationError(
            `❌ GitHub PR #${sessionRecord.pullRequest.number} cannot be merged.\n` +
              `   The acceptStaleReviewerSilence waiver addresses reviewer-bot silence only.\n` +
              `   Another merge blocker is active (${blockerDesc}).\n` +
              `   Resolve the underlying blocker (e.g., draft state, merge conflicts, failing checks) before retrying.\n\n` +
              `💡 Next steps:` +
              `\n   1. View the PR: ${sessionRecord.pullRequest.url}` +
              `\n   2. Address the blocker` +
              `\n   3. Re-run merge when the PR is mergeable`
          );
        }

        // Identify which identities are involved for audit record
        const commentReviewers = rawReviews
          .filter((r) => r.state === "COMMENTED")
          .map((r) => r.reviewerLogin)
          .join(", ");
        const prNumber = sessionRecord.pullRequest.number;

        log.info(
          `WAIVER: acceptStaleReviewerSilence applied for PR #${prNumber}. ` +
            `PR author identity: ${sessionRecord.pullRequest.github?.author ?? "unknown"}. ` +
            `COMMENT reviewer(s): ${commentReviewers}. ` +
            `${reviewerBotLogin} review absent (webhook-miss class). ` +
            `Proceeding with merge under operator-override waiver.`
        );
        if (!params.json) {
          log.cli(
            `⚠️  Operator-override waiver applied: ${reviewerBotLogin} review absent. ` +
              `Merging under acceptStaleReviewerSilence. See audit log for details.`
          );
        }
        waiverApplied = true;
        // Fall through to merge -- do not throw
      } else if (params.acceptStaleReviewerSilence === true && !waiverEligible) {
        // Flag was set but waiver conditions don't hold -- give a clear reason
        const reasons: string[] = [];
        if (!isPrAuthorBot) {
          reasons.push(
            `PR author is "${prAuthor}", not the configured bot identity "${botIdentityLogin}" ` +
              `(waiver only applies to self-authored bot PRs; set github.botIdentityLogin / ` +
              `reviewer.botLogin if this project uses its own bots)`
          );
        }
        if (hasChangesRequested) {
          reasons.push("CHANGES_REQUESTED review exists (substantive findings must be addressed)");
        }
        if (hasReviewerBotReview) {
          reasons.push(
            `${reviewerBotLogin} review exists (waiver only applies when reviewer-bot is absent)`
          );
        }
        if (!hasCommentedReview) {
          reasons.push(
            `no COMMENTED review from the PR author (${prAuthor}) found (waiver requires a same-identity COMMENT review)`
          );
        }
        throw new ValidationError(
          `❌ GitHub PR #${sessionRecord.pullRequest.number} does not meet approval requirements.\n` +
            `   acceptStaleReviewerSilence=true was set but waiver conditions are not met:\n${reasons
              .map((r) => `   - ${r}`)
              .join("\n")}\n\n` +
            `💡 Next steps:` +
            `\n   1. View the PR: ${sessionRecord.pullRequest.url}` +
            `\n   2. Request required reviews` +
            `\n   3. Address any changes requested` +
            `\n   4. Re-run merge when approvals are sufficient`
        );
      } else {
        // Default path: no waiver, block merge with actionable guidance
        // Only hint about acceptStaleReviewerSilence when the waiver could plausibly apply:
        // the PR must be authored by the bot identity (waiver never applies to human-authored PRs).
        const missingReviewerNote =
          isPrAuthorBot && !hasReviewerBotReview
            ? `\n   Note: ${reviewerBotLogin} has not reviewed this PR. ` +
              `If the reviewer bot is silent (webhook-miss), you may use ` +
              `acceptStaleReviewerSilence=true as an operator-override waiver.`
            : "";
        throw new ValidationError(
          `❌ GitHub PR #${sessionRecord.pullRequest.number} does not meet approval requirements.${
            missingReviewerNote
          }\n\n` +
            `💡 Next steps:` +
            `\n   1. View the PR: ${sessionRecord.pullRequest.url}` +
            `\n   2. Request required reviews` +
            `\n   3. Address any changes requested` +
            `\n   4. Re-run merge when approvals are sufficient`
        );
      }
    }

    // B1: Condition success message on whether the PR was actually approved (not waiver path).
    // When proceeding via waiver, the waiver message above already informed the user.
    if (!params.json) {
      if (waiverApplied) {
        log.cli(
          `PR proceeding via acceptStaleReviewerSilence waiver -- reviewer-bot review absent, waiver conditions met`
        );
      } else if (bypassApplied) {
        // The forceBypass branch already emitted its own audited cli message above.
        log.cli(`PR proceeding via audited force-bypass (mt#2215)`);
      } else {
        log.cli(`✅ PR is approved and mergeable`);
      }
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error; // Re-throw our validation errors
    }
    // Quietly continue on API errors; avoid noisy raw HTTP logs
    log.debug(`Skipping pre-merge approval check due to API error. Proceeding with merge attempt.`);
  }

  return { bypassAuditMessage };
}
