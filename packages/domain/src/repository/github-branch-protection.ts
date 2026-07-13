/**
 * GitHub branch protection operations.
 *
 * Provides:
 *   - getBranchProtection — get current protection rules for a branch
 *   - setBranchProtection — update / replace protection rules for a branch
 *
 * Auth goes through `gh.getToken()` (TokenProvider-aware), consistent with
 * the rest of the GitHub subinterface family.
 *
 * GitHub API reference:
 *   https://docs.github.com/en/rest/branches/branch-protection
 *
 * Note: Setting branch protection requires admin access to the repository.
 */

import { MinskyError } from "../errors/index";
import { handleOctokitError } from "./github-error-handler";
import { type GitHubContext, createOctokit } from "./github-pr-operations";

// ── Public types ──────────────────────────────────────────────────────────

/** Required status checks configuration for a protected branch. */
export interface RequiredStatusChecks {
  /** Enforcement level — "off" | "non_admins" | "everyone" */
  enforcement_level?: string;
  /** The strict flag requires branches to be up to date before merging. */
  strict: boolean;
  /** List of required context/check names. */
  contexts: string[];
}

/** Required pull request review settings. */
export interface RequiredPullRequestReviews {
  /** Dismiss stale reviews when new commits are pushed. */
  dismiss_stale_reviews?: boolean;
  /** Require review from code owners. */
  require_code_owner_reviews?: boolean;
  /** Number of approving reviews required. */
  required_approving_review_count?: number;
  /** Require that the most recent review is approved. */
  require_last_push_approval?: boolean;
}

/** User/team/app restrictions for a protected branch. */
export interface BranchRestrictions {
  /** Logins of users allowed to push. */
  users: string[];
  /** Slugs of teams allowed to push. */
  teams: string[];
  /** Slugs of apps allowed to push. */
  apps?: string[];
}

/**
 * Branch protection configuration.
 *
 * Mirrors the GitHub REST API shape for branch protection rules.
 * All fields are optional on write (only fields present are applied).
 */
export interface BranchProtection {
  /** Required status checks to pass before merging. */
  required_status_checks?: RequiredStatusChecks | null;
  /** Whether admins are included in protection enforcement. */
  enforce_admins?: boolean | null;
  /** Required pull request review settings. */
  required_pull_request_reviews?: RequiredPullRequestReviews | null;
  /** Restrict who can push to this branch. */
  restrictions?: BranchRestrictions | null;
  /** Whether signed commits are required. */
  required_signatures?: boolean;
  /** Whether linear commit history is required. */
  required_linear_history?: boolean;
  /** Whether force pushes are allowed. */
  allow_force_pushes?: boolean;
  /** Whether branch deletions are allowed. */
  allow_deletions?: boolean;
  /** Whether conversations must be resolved before merging. */
  required_conversation_resolution?: boolean;
  /** Whether the branch is locked (read-only). */
  lock_branch?: boolean;
  /** Whether fork-originated pull requests can bypass branch protection. */
  allow_fork_syncing?: boolean;
}

// ── Implementation ────────────────────────────────────────────────────────

/**
 * Get the current branch protection settings for the given branch.
 *
 * Returns a `BranchProtection` object with the fields present in the
 * GitHub API response. Throws a MinskyError if the branch has no
 * protection rules (GitHub returns 404 in that case).
 *
 * @param gh     — GitHub context (owner, repo, token resolver)
 * @param branch — branch name to query (e.g. "main")
 * @param octokitOverride — optional DI-injected Octokit for testing
 */
export async function getBranchProtection(
  gh: GitHubContext,
  branch: string,
  octokitOverride?: ReturnType<typeof createOctokit>
): Promise<BranchProtection> {
  if (!branch || branch.trim().length === 0) {
    throw new MinskyError("getBranchProtection: branch name is required");
  }

  try {
    const octokit = octokitOverride ?? createOctokit(await gh.getToken());

    const resp = await octokit.rest.repos.getBranchProtection({
      owner: gh.owner,
      repo: gh.repo,
      branch,
    });

    const d = resp.data as Record<string, unknown>;

    // Map the GitHub API response shape to our BranchProtection interface.
    const protection: BranchProtection = {};

    if (d["required_status_checks"] != null) {
      const rsc = d["required_status_checks"] as Record<string, unknown>;
      protection.required_status_checks = {
        strict: Boolean(rsc["strict"]),
        contexts: (rsc["contexts"] as string[]) ?? [],
        enforcement_level: rsc["enforcement_level"] as string | undefined,
      };
    } else if ("required_status_checks" in d) {
      protection.required_status_checks = null;
    }

    if (d["enforce_admins"] != null) {
      const ea = d["enforce_admins"] as Record<string, unknown>;
      protection.enforce_admins = Boolean(ea["enabled"]);
    }

    if (d["required_pull_request_reviews"] != null) {
      const rpr = d["required_pull_request_reviews"] as Record<string, unknown>;
      protection.required_pull_request_reviews = {
        dismiss_stale_reviews: Boolean(rpr["dismiss_stale_reviews"]),
        require_code_owner_reviews: Boolean(rpr["require_code_owner_reviews"]),
        required_approving_review_count:
          typeof rpr["required_approving_review_count"] === "number"
            ? rpr["required_approving_review_count"]
            : undefined,
        require_last_push_approval: Boolean(rpr["require_last_push_approval"]),
      };
    } else if ("required_pull_request_reviews" in d) {
      protection.required_pull_request_reviews = null;
    }

    if (d["restrictions"] != null) {
      const r = d["restrictions"] as Record<string, unknown>;
      protection.restrictions = {
        users: ((r["users"] as Array<Record<string, unknown>>) ?? []).map(
          (u) => (u["login"] as string) ?? ""
        ),
        teams: ((r["teams"] as Array<Record<string, unknown>>) ?? []).map(
          (t) => (t["slug"] as string) ?? ""
        ),
        apps: ((r["apps"] as Array<Record<string, unknown>>) ?? []).map(
          (a) => (a["slug"] as string) ?? ""
        ),
      };
    } else if ("restrictions" in d) {
      protection.restrictions = null;
    }

    if (d["required_signatures"] != null) {
      const rs = d["required_signatures"] as Record<string, unknown>;
      protection.required_signatures = Boolean(rs["enabled"]);
    }

    if (d["required_linear_history"] != null) {
      const rlh = d["required_linear_history"] as Record<string, unknown>;
      protection.required_linear_history = Boolean(rlh["enabled"]);
    }

    if (d["allow_force_pushes"] != null) {
      const afp = d["allow_force_pushes"] as Record<string, unknown>;
      protection.allow_force_pushes = Boolean(afp["enabled"]);
    }

    if (d["allow_deletions"] != null) {
      const ad = d["allow_deletions"] as Record<string, unknown>;
      protection.allow_deletions = Boolean(ad["enabled"]);
    }

    if (d["required_conversation_resolution"] != null) {
      const rcr = d["required_conversation_resolution"] as Record<string, unknown>;
      protection.required_conversation_resolution = Boolean(rcr["enabled"]);
    }

    if (d["lock_branch"] != null) {
      const lb = d["lock_branch"] as Record<string, unknown>;
      protection.lock_branch = Boolean(lb["enabled"]);
    }

    if (d["allow_fork_syncing"] != null) {
      const afs = d["allow_fork_syncing"] as Record<string, unknown>;
      protection.allow_fork_syncing = Boolean(afs["enabled"]);
    }

    return protection;
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "get branch protection",
      owner: gh.owner,
      repo: gh.repo,
    });
    throw error;
  }
}

/**
 * Set (replace) branch protection rules for the given branch.
 *
 * The GitHub API is a full-replace operation — fields not included in
 * `config` are treated as "disabled". See the GitHub docs for defaults.
 *
 * Returns the resulting `BranchProtection` (re-fetched after the update).
 *
 * @param gh     — GitHub context (owner, repo, token resolver)
 * @param branch — branch name to protect (e.g. "main")
 * @param config — desired protection configuration
 * @param octokitOverride — optional DI-injected Octokit for testing
 */
export async function setBranchProtection(
  gh: GitHubContext,
  branch: string,
  config: BranchProtection,
  octokitOverride?: ReturnType<typeof createOctokit>
): Promise<BranchProtection> {
  if (!branch || branch.trim().length === 0) {
    throw new MinskyError("setBranchProtection: branch name is required");
  }

  try {
    const octokit = octokitOverride ?? createOctokit(await gh.getToken());

    // The GitHub API requires these fields to be explicitly present.
    // When not provided in config, we use safe defaults (disabled / null).
    await octokit.rest.repos.updateBranchProtection({
      owner: gh.owner,
      repo: gh.repo,
      branch,
      // required_status_checks is nullable
      required_status_checks: config.required_status_checks
        ? {
            strict: config.required_status_checks.strict,
            contexts: config.required_status_checks.contexts,
          }
        : null,
      // enforce_admins: true/false (not nullable)
      enforce_admins: config.enforce_admins ?? false,
      // required_pull_request_reviews is nullable
      required_pull_request_reviews: config.required_pull_request_reviews
        ? {
            dismiss_stale_reviews:
              config.required_pull_request_reviews.dismiss_stale_reviews ?? false,
            require_code_owner_reviews:
              config.required_pull_request_reviews.require_code_owner_reviews ?? false,
            required_approving_review_count:
              config.required_pull_request_reviews.required_approving_review_count ?? 0,
            require_last_push_approval:
              config.required_pull_request_reviews.require_last_push_approval ?? false,
          }
        : null,
      // restrictions is nullable (null = no restrictions)
      restrictions: config.restrictions
        ? {
            users: config.restrictions.users,
            teams: config.restrictions.teams,
            apps: config.restrictions.apps,
          }
        : null,
      ...(config.required_linear_history !== undefined
        ? { required_linear_history: config.required_linear_history }
        : {}),
      ...(config.allow_force_pushes !== undefined
        ? { allow_force_pushes: config.allow_force_pushes }
        : {}),
      ...(config.allow_deletions !== undefined ? { allow_deletions: config.allow_deletions } : {}),
      ...(config.required_conversation_resolution !== undefined
        ? { required_conversation_resolution: config.required_conversation_resolution }
        : {}),
      ...(config.lock_branch !== undefined ? { lock_branch: config.lock_branch } : {}),
      ...(config.allow_fork_syncing !== undefined
        ? { allow_fork_syncing: config.allow_fork_syncing }
        : {}),
    });

    // Re-fetch to return the canonical post-update state.
    return getBranchProtection(gh, branch, octokitOverride);
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "set branch protection",
      owner: gh.owner,
      repo: gh.repo,
    });
    throw error;
  }
}
