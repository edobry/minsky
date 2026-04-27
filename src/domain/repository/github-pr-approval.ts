/**
 * GitHub PR approval operations extracted from GitHubBackend.
 *
 * Contains: approvePullRequest, getPullRequestApprovalStatus,
 * diagnoseMergeBlocker.
 */

import { Octokit } from "@octokit/rest";
import { MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import type { ApprovalInfo, ApprovalStatus, RawReviewEntry } from "./approval-types";
import { handleOctokitError } from "./github-error-handler";
import {
  type GitHubContext,
  createOctokit,
  resolvePRNumber,
  findPRNumberForBranch,
} from "./github-pr-operations";

// ── GitHub API shape interfaces ──────────────────────────────────────────

/** Partial shape of a GitHub check run as returned by the Checks API. */
interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

/** Partial shape of a GitHub commit status entry from the combined status API. */
interface GitHubCommitStatus {
  state: string;
  context?: string;
  description?: string;
}

/**
 * Extended PR data shape that includes fields not present in the official
 * Octokit TypeScript types (e.g. `mergeable_state`, `draft`).
 */
interface GitHubPRExtended {
  state: string;
  merged: boolean;
  draft?: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

// ── Approval operations ─────────────────────────────────────────────────

/**
 * Approve a GitHub pull request by creating an APPROVE review.
 */
export async function approvePullRequest(
  gh: GitHubContext,
  prIdentifier: string | number,
  reviewComment?: string
): Promise<ApprovalInfo> {
  const prNumber = await resolvePRNumber(prIdentifier, gh, async (branch) => {
    const token = await gh.getToken();
    const ok = createOctokit(token);
    return findPRNumberForBranch(branch, gh, ok);
  });

  try {
    const githubToken = await gh.getToken();
    const octokit = createOctokit(githubToken);

    // Validate PR exists and is open
    const prResponse = await octokit.rest.pulls.get({
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
    });

    const pr = prResponse.data;

    if (pr.state !== "open") {
      throw new MinskyError(
        `Pull request #${prNumber} is not open ` + `(current state: ${pr.state})`
      );
    }

    // Create approval review
    const reviewResponse = await octokit.rest.pulls.createReview({
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
      body: reviewComment || "Approved via Minsky session workflow",
      event: "APPROVE",
    });

    const review = reviewResponse.data;

    // Get the current user info
    const userResponse = await octokit.rest.users.getAuthenticated();
    const approver = userResponse.data.login;

    log.info("GitHub PR approved successfully", {
      prNumber,
      reviewId: review.id,
      approver,
      owner: gh.owner,
      repo: gh.repo,
    });

    return {
      reviewId: String(review.id),
      approvedBy: approver,
      approvedAt: review.submitted_at || new Date().toISOString(),
      comment: reviewComment,
      prNumber,
      metadata: {
        github: {
          reviewId: review.id,
          reviewState:
            (review.state as "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED") || "APPROVED",
          reviewerLogin: approver,
          submittedAt: review.submitted_at || new Date().toISOString(),
        },
      },
    };
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "approve pull request",
      owner: gh.owner,
      repo: gh.repo,
      prNumber,
    });
  }
}

/**
 * Get approval status for a GitHub pull request.
 */
export async function getPullRequestApprovalStatus(
  gh: GitHubContext,
  prIdentifier: string | number
): Promise<ApprovalStatus> {
  const prNumber = typeof prIdentifier === "string" ? parseInt(prIdentifier, 10) : prIdentifier;
  if (isNaN(prNumber)) {
    throw new MinskyError(`Invalid PR number: ${prIdentifier}`);
  }

  try {
    const githubToken = await gh.getToken();

    const debugEnabled = (() => {
      try {
        const level = (log as { config?: { level?: unknown } })?.config?.level;
        return (
          String(level).toLowerCase() === "debug" ||
          String(process.env.LOGLEVEL).toLowerCase() === "debug"
        );
      } catch {
        return false;
      }
    })();

    const octokit = new Octokit({
      auth: githubToken,
      log: debugEnabled
        ? {
            debug: (msg: unknown) => log.systemDebug(String(msg)),
            info: (msg: unknown) => log.systemDebug(String(msg)),
            warn: (msg: unknown) => log.systemDebug(String(msg)),
            error: (msg: unknown) => log.systemDebug(String(msg)),
          }
        : { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });

    // Get PR details and ALL reviews (paginated to avoid the ~30 default cap).
    // listReviews without pagination silently drops reviews beyond the first page;
    // a minsky-reviewer[bot] review on page 2+ would be missed by the waiver gate.
    const [prResponse, reviews] = await Promise.all([
      octokit.rest.pulls.get({
        owner: gh.owner,
        repo: gh.repo,
        pull_number: prNumber,
      }),
      octokit.paginate(octokit.rest.pulls.listReviews, {
        owner: gh.owner,
        repo: gh.repo,
        pull_number: prNumber,
        per_page: 100,
      }),
    ]);

    const pr = prResponse.data;

    const approvals = reviews.filter((r) => r.state === "APPROVED");
    const rejections = reviews.filter((r) => r.state === "CHANGES_REQUESTED");

    // Determine required approvals from branch protection
    let requiredApprovals = 0;
    try {
      const protection = await octokit.rest.repos.getBranchProtection({
        owner: gh.owner,
        repo: gh.repo,
        branch: pr.base.ref,
      });
      const required =
        protection.data.required_pull_request_reviews?.required_approving_review_count;
      if (typeof required === "number" && required >= 0) {
        requiredApprovals = required;
      }
    } catch (_e) {
      requiredApprovals = 0;
    }

    const isApproved =
      (requiredApprovals === 0 && rejections.length === 0) ||
      (requiredApprovals > 0 && approvals.length >= requiredApprovals && rejections.length === 0);

    // Capture draft state: GitHub returns state="open" for draft PRs, so we need
    // to check the separate `draft` boolean (B3).
    const prExtended = pr as typeof pr & { draft?: boolean };
    const isDraft = prExtended.draft === true;

    const canMerge = isApproved && !!pr.mergeable && pr.state === "open" && !isDraft;

    // hasNonApprovalMergeBlockers is computed independently of isApproved so the
    // acceptStaleReviewerSilence waiver can use it. canMerge is always false when
    // isApproved=false, making canMerge useless inside the waiver path (B1).
    let nonApprovalBlockerDescription: string | undefined;
    if (isDraft) {
      nonApprovalBlockerDescription = "draft PR";
    } else if (!pr.mergeable) {
      nonApprovalBlockerDescription = "merge conflicts";
    } else if (pr.state !== "open") {
      nonApprovalBlockerDescription = `PR not open (state: ${pr.state})`;
    }
    const hasNonApprovalMergeBlockers = nonApprovalBlockerDescription !== undefined;

    // prState: surface "draft" when the PR is a draft rather than surfacing the
    // misleading GitHub state value "open" (B3).
    const prState: "open" | "closed" | "merged" | "draft" = isDraft
      ? "draft"
      : (pr.state as "open" | "closed" | "merged") || "open";

    const rawReviews: RawReviewEntry[] = reviews.map((review) => ({
      reviewId: String(review.id),
      reviewerLogin: review.user?.login || "unknown",
      state: review.state,
      submittedAt: review.submitted_at || "",
      body: review.body || undefined,
    }));

    return {
      isApproved,
      canMerge,
      hasNonApprovalMergeBlockers,
      nonApprovalBlockerDescription,
      approvals: approvals.map((review) => ({
        reviewId: String(review.id),
        approvedBy: review.user?.login || "unknown",
        approvedAt: review.submitted_at || "",
        comment: review.body || undefined,
        prNumber,
      })),
      requiredApprovals,
      prState,
      rawReviews,
      metadata: {
        github: {
          statusChecks: [],
          branchProtection: {
            requiredReviews: requiredApprovals,
            dismissStaleReviews: false,
            requireCodeOwnerReviews: false,
            restrictPushes: false,
          },
          codeownersApproval: undefined,
        },
      },
    };
  } catch (error) {
    throw new MinskyError(
      `Failed to get GitHub PR approval status: ` + `${getErrorMessage(error)}`
    );
  }
}

// ── Merge blocker diagnosis ─────────────────────────────────────────────

/**
 * Diagnose why a PR cannot be merged and return a user-friendly
 * description.
 */
export async function diagnoseMergeBlocker(
  gh: GitHubContext,
  prNumber: number,
  octokit: Octokit
): Promise<string> {
  try {
    const prResp = await octokit.rest.pulls.get({
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
    });
    const pr = prResp.data as typeof prResp.data & GitHubPRExtended;

    const reasons: string[] = [];

    const mergeableState: string = (pr.mergeable_state as string) || "unknown";
    switch (mergeableState) {
      case "dirty":
        reasons.push("Merge conflicts detected. Resolve conflicts between head and base.");
        break;
      case "behind":
        reasons.push(
          `Head branch '${pr.head?.ref}' is behind '${pr.base?.ref}'. ` +
            `Update the branch (merge or rebase).`
        );
        break;
      case "blocked":
        reasons.push("Blocked by required reviews or status checks.");
        break;
      case "unstable":
        reasons.push("Required status checks are failing or pending.");
        break;
      case "draft":
        reasons.push("PR is in draft state. Mark it ready for review to allow merging.");
        break;
      case "unknown":
        reasons.push("Mergeability is being calculated by GitHub. " + "Retry in a few seconds.");
        break;
      case "clean":
        break;
    }

    // Check repository merge method settings
    const repoInfo = await octokit.rest.repos.get({
      owner: gh.owner,
      repo: gh.repo,
    });
    if (repoInfo?.data?.allow_merge_commit === false) {
      reasons.push("Merge commits are disabled in repository settings. " + "Use squash or rebase.");
    }

    // Inspect checks and combined statuses
    const headSha: string = pr.head?.sha as string;
    if (headSha) {
      try {
        const checks = await octokit.rest.checks.listForRef({
          owner: gh.owner,
          repo: gh.repo,
          ref: headSha,
          per_page: 100,
        });
        const checkRuns = checks.data.check_runs as GitHubCheckRun[];
        const failingChecks = checkRuns.filter((r) => r.conclusion && r.conclusion !== "success");
        const pendingChecks = checkRuns.filter((r) => r.status !== "completed");
        if (failingChecks.length > 0) {
          const list = failingChecks
            .slice(0, 5)
            .map((r) => r.name)
            .join(", ");
          reasons.push(
            `Failing checks: ${list}${
              failingChecks.length > 5 ? ` (+${failingChecks.length - 5} more)` : ""
            }`
          );
        } else if (pendingChecks.length > 0) {
          const list = pendingChecks
            .slice(0, 5)
            .map((r) => r.name)
            .join(", ");
          reasons.push(`Pending checks: ${list}`);
        } else {
          const statuses = await octokit.rest.repos.getCombinedStatusForRef({
            owner: gh.owner,
            repo: gh.repo,
            ref: headSha,
          });
          const statusList = statuses.data.statuses as GitHubCommitStatus[];
          const failingStatuses = statusList.filter((s) => s.state !== "success");
          if (failingStatuses.length > 0) {
            const list = failingStatuses
              .slice(0, 5)
              .map((s) => s.context || s.description || "status")
              .join(", ");
            reasons.push(
              `Failing status checks: ${list}$${
                failingStatuses.length > 5 ? ` (+${failingStatuses.length - 5} more)` : ""
              }`
            );
          }
        }
      } catch (_e) {
        // Ignore check fetching errors
      }
    }

    if (reasons.length === 0) {
      reasons.push("GitHub did not provide a specific reason. " + "Check the PR page for details.");
    }

    return reasons.map((r) => `  - ${r}`).join("\n");
  } catch (_e) {
    return "  - Unable to diagnose blocker via GitHub API. " + "Check the PR page for details.";
  }
}
