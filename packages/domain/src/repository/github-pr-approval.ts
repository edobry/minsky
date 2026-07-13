/**
 * GitHub PR approval operations extracted from GitHubBackend.
 *
 * Contains: approvePullRequest, getPullRequestApprovalStatus,
 * diagnoseMergeBlocker.
 */

import { Octokit } from "@octokit/rest";
import { createTimeoutFetch } from "../github/octokit-timeout";
import { MinskyError, getErrorMessage } from "../errors/index";
import { log } from "@minsky/shared/logger";
import type { ApprovalInfo, ApprovalStatus, RawReviewEntry } from "./approval-types";
import { handleOctokitError } from "./github-error-handler";
import {
  type GitHubContext,
  createOctokit,
  resolvePRNumber,
  findPRNumberForBranch,
} from "./github-pr-operations";

/**
 * Minimal review shape consumed by `pickLatestReviewPerReviewer`. Matches
 * the GitHub REST review payload (and the Octokit-typed listReviews response)
 * but constrained to the fields the per-reviewer reducer needs. Exported so
 * tests can construct synthetic reviews without depending on Octokit types.
 */
export interface MinimalReview {
  user: { login: string } | null | undefined;
  state: string;
  submitted_at: string | null | undefined;
}

/**
 * The set of review states GitHub treats as "decision-bearing" for its own
 * `review_decision` field. Only these states participate in the per-reviewer
 * latest-wins reduction. COMMENTED and PENDING are informational, NOT
 * decisions: an APPROVED review followed by a COMMENTED review from the same
 * reviewer is still APPROVED, and a CHANGES_REQUESTED followed by a COMMENTED
 * is still CHANGES_REQUESTED. Per GitHub docs (and verified against the
 * `review_decision` GraphQL field), only APPROVED / CHANGES_REQUESTED /
 * DISMISSED carry a decision.
 */
const DECISION_BEARING_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/**
 * Reduce a review list to the latest decision-bearing review per reviewer
 * (by `submitted_at`).
 *
 * GitHub's own `review_decision` semantics: a reviewer's most recent
 * DECISION-BEARING review supersedes their earlier ones. So
 * `[CHANGES_REQUESTED then APPROVED]` from the same reviewer collapses to
 * APPROVED (resolved); `[APPROVED then CHANGES_REQUESTED]` collapses to
 * CHANGES_REQUESTED (re-rejected). A COMMENTED review interleaved between
 * decisions does NOT supersede the prior decision (COMMENTED is
 * informational, not a verdict).
 *
 * This function preserves those semantics for downstream code that computes
 * `isApproved`. The previous implementation counted every CHANGES_REQUESTED
 * review regardless of whether the same reviewer later approved, producing
 * a false-blocking merge state for the common reviewer-bot cycle (request
 * changes → fix → approve). See mt#1830 for the originating incident
 * (mt#1824 / PR #1110 R1 → R2).
 *
 * Behavior:
 *   - Non-decision-bearing states (COMMENTED, PENDING, anything not in
 *     DECISION_BEARING_STATES) are filtered out BEFORE the reduction.
 *     They do not appear in the output and do not supersede prior decisions.
 *   - Reviews without a `user.login` are dropped (cannot key by reviewer).
 *   - `submitted_at` is compared as an ISO-8601 lexicographic string
 *     (matches temporal ordering for valid ISO timestamps). Reviews with
 *     missing `submitted_at` are treated as oldest (empty string < any
 *     real timestamp).
 *   - On tie (identical `submitted_at`), the LATER entry in the input
 *     array wins. This matches the order in which `listReviews` returns
 *     them (chronological), so the most-recently-listed review wins.
 *   - Returns reviews in arbitrary order (Map insertion order). Callers
 *     that need a deterministic order should sort the result themselves.
 */
export function pickLatestReviewPerReviewer<R extends MinimalReview>(reviews: R[]): R[] {
  const byReviewer = new Map<string, R>();
  for (const r of reviews) {
    if (!DECISION_BEARING_STATES.has(r.state)) continue;
    const login = r.user?.login;
    if (!login) continue;
    const prev = byReviewer.get(login);
    if (!prev) {
      byReviewer.set(login, r);
      continue;
    }
    const prevTs = prev.submitted_at ?? "";
    const currTs = r.submitted_at ?? "";
    if (currTs >= prevTs) {
      byReviewer.set(login, r);
    }
  }
  return Array.from(byReviewer.values());
}

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
      // Bound every request so a hung GitHub call can't wedge a long-lived
      // process (mt#2270 sweep; see octokit-timeout.ts).
      request: { fetch: createTimeoutFetch() },
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

    // Apply GitHub's per-reviewer "latest review wins" semantics for the
    // isApproved decision: a CHANGES_REQUESTED that the same reviewer later
    // approved is resolved, not still-blocking. The `approvals` array below
    // is kept as the chronological full list of APPROVED reviews for the
    // return value's `approvals: ApprovalInfo[]` field (consumer contract
    // preserved); only the isApproved predicate uses the per-reviewer
    // reduction. See mt#1830 for the originating incident.
    //
    // The reducer itself filters input to decision-bearing states
    // (APPROVED, CHANGES_REQUESTED, DISMISSED) — see DECISION_BEARING_STATES
    // and pickLatestReviewPerReviewer above. COMMENTED and PENDING are
    // informational and do not supersede prior decisions.
    // Cast to MinimalReview[]: Octokit's review type carries many fields
    // (author_association, _links, etc.) that don't structurally widen to
    // MinimalReview's tighter user shape. The runtime fields the helper
    // touches (user.login, state, submitted_at) are present on the Octokit
    // shape — only the TS type assertion is needed.
    // eslint-disable-next-line custom/no-excessive-as-unknown -- Octokit's listReviews response type carries many fields that don't structurally narrow to MinimalReview; the runtime fields the helper touches are guaranteed to be present.
    const latestPerReviewer = pickLatestReviewPerReviewer(reviews as unknown as MinimalReview[]);
    const effectiveApprovals = latestPerReviewer.filter((r) => r.state === "APPROVED");
    const effectiveRejections = latestPerReviewer.filter((r) => r.state === "CHANGES_REQUESTED");

    // Backward-compat: chronological list of all APPROVED reviews, unchanged.
    const approvals = reviews.filter((r) => r.state === "APPROVED");

    // Read branch protection for the PR's base branch.
    //
    // mt#2007: previously this block read ONLY `required_approving_review_count`
    // and discarded every other field, then the CLI collapsed the result to
    // "configured / not configured" based solely on `requiredApprovals > 0`.
    // That misreports branches with status checks + force-push/deletion blocks
    // but zero required reviewers (Minsky's actual main config) as "not
    // configured". Now: capture all the protection-shape fields the spec
    // enumerates and pass them through `metadata.github.branchProtection` so
    // the formatter can render the real state.
    let requiredApprovals = 0;
    let bpDismissStaleReviews = false;
    let bpRequireCodeOwnerReviews = false;
    let bpRestrictPushes = false;
    let bpStatusChecksContexts: string[] = [];
    let bpEnforceAdmins = false;
    let bpAllowForcePushes: boolean | undefined;
    let bpAllowDeletions: boolean | undefined;
    let bpApiResponded = false;
    let bpProbeError = false;
    try {
      const protection = await octokit.rest.repos.getBranchProtection({
        owner: gh.owner,
        repo: gh.repo,
        branch: pr.base.ref,
      });
      bpApiResponded = true;
      const d = protection.data;
      const required = d.required_pull_request_reviews?.required_approving_review_count;
      if (typeof required === "number" && required >= 0) {
        requiredApprovals = required;
      }
      bpDismissStaleReviews = d.required_pull_request_reviews?.dismiss_stale_reviews === true;
      bpRequireCodeOwnerReviews =
        d.required_pull_request_reviews?.require_code_owner_reviews === true;
      bpRestrictPushes = d.restrictions != null;
      bpStatusChecksContexts = Array.isArray(d.required_status_checks?.contexts)
        ? [...d.required_status_checks.contexts]
        : [];
      bpEnforceAdmins = d.enforce_admins?.enabled === true;
      // allow_force_pushes / allow_deletions are nested {enabled: boolean} per
      // GitHub's REST shape, but Octokit's typing varies — read defensively.
      const afp = (d as { allow_force_pushes?: { enabled?: boolean } }).allow_force_pushes;
      bpAllowForcePushes = typeof afp?.enabled === "boolean" ? afp.enabled : undefined;
      const ad = (d as { allow_deletions?: { enabled?: boolean } }).allow_deletions;
      bpAllowDeletions = typeof ad?.enabled === "boolean" ? ad.enabled : undefined;
    } catch (e) {
      // mt#2007 R1: distinguish 404 (definitive "no protection configured")
      // from non-404 errors (auth / network / permission — state is UNKNOWN).
      // The prior code conflated both as `apiResponded=false`, which the
      // formatter rendered as "not configured" — misleading when the actual
      // state was undeterminable due to API failure.
      //
      // Octokit's RequestError carries an `.status` number for HTTP errors.
      // 404 means the branch genuinely has no protection rules; any other
      // status (401, 403, 5xx) or a network error (no `.status`) is a probe
      // failure where the protection state is unknown.
      const status =
        typeof (e as { status?: unknown })?.status === "number"
          ? (e as { status: number }).status
          : undefined;
      if (status === 404) {
        // Definitive "no protection" — API responded, no rules exist.
        bpApiResponded = true;
        // All boolean defaults already represent the no-protection state.
        // GitHub doesn't return allow_force_pushes / allow_deletions when
        // there's no protection rule, so leave those undefined.
      } else {
        // Probe failure (auth, network, permission, 5xx). State is unknown;
        // the formatter renders "unknown (API error)" rather than "not
        // configured."
        bpProbeError = true;
      }
      requiredApprovals = 0;
    }

    // Use the per-reviewer effective counts so a CHANGES_REQUESTED superseded
    // by a later APPROVE from the same reviewer doesn't keep blocking.
    const isApproved =
      (requiredApprovals === 0 && effectiveRejections.length === 0) ||
      (requiredApprovals > 0 &&
        effectiveApprovals.length >= requiredApprovals &&
        effectiveRejections.length === 0);

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
            dismissStaleReviews: bpDismissStaleReviews,
            requireCodeOwnerReviews: bpRequireCodeOwnerReviews,
            restrictPushes: bpRestrictPushes,
            statusChecksContexts: bpStatusChecksContexts,
            enforceAdmins: bpEnforceAdmins,
            allowForcePushes: bpAllowForcePushes,
            allowDeletions: bpAllowDeletions,
            apiResponded: bpApiResponded,
            probeError: bpProbeError,
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
