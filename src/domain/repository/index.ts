/**
 * Repository Backend Interface
 *
 * Defines a common interface for repository backend implementations.
 * Currently only the GitHub backend is supported.
 */

export * from "./RepositoryBackend";
export * from "./approval-types";

// Import RepositoryStatus and RepositoryBackendType from legacy-types (previously from ../repository)
import type { RepositoryStatus } from "./legacy-types";
import { RepositoryBackendType } from "./legacy-types";

import type { ApprovalInfo, ApprovalStatus } from "./approval-types";
import type { SessionProviderInterface } from "../session/types";
import type { ChecksResult } from "./github-pr-checks";
// Re-export RepositoryStatus
export type { RepositoryStatus };

// Re-export check types so consumers don't need to import from github-pr-checks directly
export type { ChecksResult, CheckRunResult } from "./github-pr-checks";

// Define ValidationResult with compatibility for both interfaces
export interface ValidationResult {
  valid: boolean;
  issues?: string[];
  success?: boolean;
  message?: string;
  error?: Error;
}

// Define RepoStatus as extending RepositoryStatus for backward compatibility
export interface RepoStatus extends RepositoryStatus {
  // Additional fields specific to the original RepoStatus interface
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  remotes: string[];
  [key: string]: unknown;
}

/**
 * Configuration for repository backends
 */
export interface RepositoryBackendConfig {
  /**
   * The type of repository backend to use
   */
  type: "github" | "gitlab" | "bitbucket";

  /**
   * Repository URL or path
   */
  repoUrl: string;

  /**
   * Branch to checkout (for remote repositories)
   */
  branch?: string;

  /**
   * Remote repository-specific options
   */
  remote?: {
    /**
     * Authentication method to use for remote repositories
     */
    authMethod?: "ssh" | "https" | "token";

    /**
     * Clone depth for shallow clones (default: 1)
     */
    depth?: number;

    /**
     * Number of retry attempts for network operations (default: 3)
     */
    retryAttempts?: number;

    /**
     * Timeout in milliseconds for git operations (default: DEFAULT_TIMEOUT_MS)
     */
    timeout?: number;

    /**
     * Whether to follow redirects when cloning (default: true)
     */
    followRedirects?: boolean;
  };

  /**
   * GitHub-specific options for GitHub backend
   */
  github?: {
    /**
     * GitHub access token for authentication
     */
    token?: string;

    /**
     * GitHub repository owner (organization or user)
     */
    owner?: string;

    /**
     * GitHub repository name
     */
    repo?: string;

    /**
     * GitHub API URL (for GitHub Enterprise)
     */
    apiUrl?: string;

    /**
     * GitHub Enterprise domain (for GitHub Enterprise)
     */
    enterpriseDomain?: string;

    /**
     * Whether to use the GitHub API for operations like PR creation
     */
    useApi?: boolean;
  };
}

/**
 * Repository clone result
 */
export interface CloneResult {
  /**
   * Working directory where the repository was cloned
   */
  workdir: string;

  /**
   * Session identifier
   */
  session: string;
}

/**
 * Repository branch result
 */
export interface BranchResult {
  /**
   * Working directory where the branch was created
   */
  workdir: string;

  /**
   * Branch name
   */
  branch: string;
}

/**
 * Pull Request information
 */
export interface PRInfo {
  /**
   * PR number (for platforms that support it) or identifier
   */
  number: number | string;

  /**
   * PR URL (for platforms that support it) or branch name
   */
  url: string;

  /**
   * PR state
   */
  state: "open" | "closed" | "merged";

  /**
   * Additional metadata specific to the repository backend
   */
  metadata?: Record<string, unknown>;
}

/**
 * Pull Request merge information
 */
export interface MergeInfo {
  /**
   * Commit hash of the merge
   */
  commitHash: string;

  /**
   * Date when the merge occurred
   */
  mergeDate: string;

  /**
   * User who performed the merge
   */
  mergedBy: string;

  /**
   * Additional metadata specific to the repository backend
   */
  metadata?: Record<string, unknown>;
}

// --- Sub-interfaces for forge operations ---

export interface CreatePROptions {
  title: string;
  body: string;
  sourceBranch: string;
  baseBranch: string;
  session?: string;
  draft?: boolean;
  /** Optional authorship tier — when provided, the corresponding label is applied to the PR. */
  authorshipTier?: import("../provenance/types").AuthorshipTier;
}

export interface UpdatePROptions {
  prIdentifier?: string | number;
  title?: string;
  body?: string;
  session?: string;
}

export interface MergePROptions {
  /** Authorship tier from provenance — used to select the correct token and build trailers. */
  authorshipTier?: import("../provenance/types").AuthorshipTier;
  /** Git trailers string to append to the merge commit message (e.g. built by buildMergeTrailers). */
  mergeTrailers?: string;
  /** Override the token used for the merge API call. When absent, the default GitHubContext token is used. */
  tokenOverride?: () => Promise<string>;
}

export interface PullRequestOperations {
  create(options: CreatePROptions): Promise<PRInfo>;
  update(options: UpdatePROptions): Promise<PRInfo>;
  merge(
    prIdentifier: string | number,
    session?: string,
    options?: MergePROptions
  ): Promise<MergeInfo>;
  get(options: { prIdentifier?: string | number; session?: string }): Promise<{
    number?: number | string;
    url?: string;
    state?: string;
    title?: string;
    body?: string;
    headBranch?: string;
    baseBranch?: string;
    author?: string;
    createdAt?: string;
    updatedAt?: string;
    mergedAt?: string;
  }>;
  getDiff(options: { prIdentifier?: string | number; session?: string }): Promise<{
    diff: string;
    stats?: { filesChanged: number; insertions: number; deletions: number };
  }>;
}

export interface CIStatusOperations {
  getChecksForRef(headSha: string): Promise<ChecksResult>;
  getChecksForPR(prNumber: number): Promise<ChecksResult>;
}

export interface ReviewOperations {
  approve(prIdentifier: string | number, reviewComment?: string): Promise<ApprovalInfo>;
  getApprovalStatus(prIdentifier: string | number): Promise<ApprovalStatus>;
  submitReview?(
    prIdentifier: string | number,
    options: {
      body: string;
      event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
      comments?: Array<{ path: string; line: number; body: string; side?: "LEFT" | "RIGHT" }>;
    }
  ): Promise<{ reviewId: number; htmlUrl: string }>;
  dismissReview?(
    prIdentifier: string | number,
    reviewId: number,
    options: { message: string }
  ): Promise<{ reviewId: number; htmlUrl: string; state: string }>;
  /**
   * List all reviews on a pull request, ordered as the forge returns them
   * (GitHub: chronological by submission time).
   *
   * Introduced for `session_pr_wait_for_review` (mt#1203): the polling loop
   * needs to detect when a new review has been posted since a given timestamp,
   * optionally filtered by reviewer identity.
   *
   * Non-GitHub backends may not implement this yet; callers should treat
   * `undefined` as "listing not supported on this backend."
   */
  listReviews?(prIdentifier: string | number): Promise<ReviewListEntry[]>;
}

/**
 * Structured review metadata returned by `ReviewOperations.listReviews`.
 *
 * Intentionally a narrow projection of forge-specific review objects so
 * non-GitHub backends can implement the method without leaking GitHub
 * payload shape into domain code.
 */
export interface ReviewListEntry {
  /** Forge-assigned review ID. */
  reviewId: number;
  /**
   * Review verdict at submission time.
   *
   * "APPROVED" / "CHANGES_REQUESTED" / "COMMENTED" map directly to GitHub's
   * states. "PENDING" covers reviews that the reviewer has drafted but not
   * submitted; these rarely appear via list endpoints but are listed for
   * completeness.
   */
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  /** ISO-8601 submission timestamp (absent for truly-PENDING drafts). */
  submittedAt?: string;
  /** Reviewer login (human or bot). May be null when the forge stripped the author. */
  reviewerLogin: string | null;
  /** Review body (may be empty for APPROVE-with-no-comment). */
  body: string;
  /** Web URL of the review, if the forge exposes one. */
  htmlUrl?: string;
}

// Completely rewritten repository backend interface with flexible types
export interface RepositoryBackend {
  getType(): string;
  clone(session: string): Promise<CloneResult>;
  branch(session: string, branch: string): Promise<BranchResult>;
  getStatus(session?: string): Promise<RepoStatus>;
  getPath(session?: string): string | Promise<string>;
  validate(): Promise<ValidationResult>;
  push(branch?: string): Promise<{ success: boolean; message?: string }>;
  pull(branch?: string): Promise<{ success: boolean; message?: string }>;
  checkout?(branch: string): Promise<void>;
  getConfig?(): RepositoryBackendConfig;

  /** Grouped pull request operations */
  readonly pr: PullRequestOperations;
  /** Grouped CI status operations */
  readonly ci: CIStatusOperations;
  /** Grouped review/approval operations */
  readonly review: ReviewOperations;
}

export type ForgeType = "github" | "gitlab" | "bitbucket";

export interface ForgeBackend extends RepositoryBackend {
  readonly forgeType: ForgeType;
}

/**
 * Repository backend types — re-exported from legacy-types for single source of truth
 */
export { RepositoryBackendType } from "./legacy-types";

/**
 * Operation result
 */
export interface Result {
  /**
   * Whether the operation was successful
   */
  success: boolean;

  /**
   * Optional message
   */
  message?: string;

  /**
   * Optional error
   */
  error?: Error;
}

/**
 * Factory function to create a repository backend
 * @param config Repository backend configuration
 * @returns Repository backend instance
 */
export async function createRepositoryBackend(
  config: RepositoryBackendConfig,
  sessionDB: SessionProviderInterface
): Promise<ForgeBackend> {
  // Validate common configuration
  if (!config.type) {
    throw new Error("Repository backend type is required");
  }

  if (!config.repoUrl) {
    throw new Error("Repository URL is required");
  }

  // Backend-specific validation — only GitHub is supported
  switch (config.type) {
    case RepositoryBackendType.GITHUB: {
      // For GitHub repositories, validate GitHub-specific options
      if (config.github) {
        // If owner and repo are provided, validate them
        if (
          (config.github.owner && !config.github.repo) ||
          (!config.github.owner && config.github.repo)
        ) {
          throw new Error("Both owner and repo must be provided for GitHub repositories");
        }

        // Validate GitHub Enterprise settings if provided
        if (config.github.enterpriseDomain && !config.github.apiUrl) {
          throw new Error("API URL must be provided when using GitHub Enterprise");
        }
      }

      const { GitHubBackend } = await import("./github");
      const { createTokenProvider } = await import("../auth");
      const { getConfiguration } = await import("../configuration/index");
      const cfg = getConfiguration();
      const userToken = cfg.github?.token || "";
      const tokenProvider = createTokenProvider(cfg.github || {}, userToken);
      return new GitHubBackend(config, sessionDB, tokenProvider);
    }

    case RepositoryBackendType.GITLAB:
      throw new Error(
        "GitLab backend is not yet implemented. Only GitHub is currently supported for PR/CI/review operations."
      );

    case RepositoryBackendType.BITBUCKET:
      throw new Error(
        "Bitbucket backend is not yet implemented. Only GitHub is currently supported for PR/CI/review operations."
      );

    default:
      throw new Error(
        `Unsupported repository backend type: ${config.type}. Only "github" is currently supported for PR/CI/review operations.`
      );
  }
}
