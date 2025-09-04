/**
 * Unified Changeset Abstraction Types
 *
 * Provides platform-agnostic interfaces for different VCS changeset concepts
 * (GitHub PRs, GitLab MRs, Bitbucket PRs, Gerrit Changes, local git prepared merge commits)
 */

/**
 * Platform identifier for different VCS systems
 */
export type ChangesetPlatform =
  | "github-pr"
  | "gitlab-mr"
  | "bitbucket-pr"
  | "gerrit-change"
  | "local-git";

/**
 * Unified changeset status across all platforms
 */
export type ChangesetStatus = "open" | "merged" | "closed" | "draft";

/**
 * Unified review status across all platforms
 */
export type ReviewStatus = "pending" | "approved" | "changes_requested" | "dismissed";

/**
 * Core changeset interface - platform-agnostic representation
 */
export interface Changeset {
  /** Unique identifier within the platform */
  id: string;

  /** Platform this changeset belongs to */
  platform: ChangesetPlatform;

  /** Changeset title/summary */
  title: string;

  /** Detailed description */
  description: string;

  /** Author information */
  author: {
    username: string;
    displayName?: string;
    email?: string;
  };

  /** Current status */
  status: ChangesetStatus;

  /** Target branch (destination) */
  targetBranch: string;

  /** Source branch (origin) - may be null for some platforms */
  sourceBranch?: string;

  /** Associated commits */
  commits: ChangesetCommit[];

  /** Review information */
  reviews: ChangesetReview[];

  /** Discussion comments */
  comments: ChangesetComment[];

  /** Creation timestamp */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;

  /** Platform-specific metadata */
  metadata: ChangesetMetadata;

  /** Optional associated session (for local git workflow) */
  sessionName?: string;

  /** Optional associated task ID */
  taskId?: string;
}

/**
 * Commit information within a changeset
 */
export interface ChangesetCommit {
  sha: string;
  message: string;
  author: {
    username: string;
    email: string;
  };
  timestamp: Date;
  filesChanged: string[];
}

/**
 * Review information for a changeset
 */
export interface ChangesetReview {
  id: string;
  author: {
    username: string;
    displayName?: string;
  };
  status: ReviewStatus;
  summary?: string;
  comments: ReviewComment[];
  submittedAt: Date;
}

/**
 * Review comment (can be general or file-specific)
 */
export interface ReviewComment {
  id: string;
  author: {
    username: string;
    displayName?: string;
  };
  content: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  createdAt: Date;
  isResolved?: boolean;
}

/**
 * General discussion comment on a changeset
 */
export interface ChangesetComment {
  id: string;
  author: {
    username: string;
    displayName?: string;
  };
  content: string;
  createdAt: Date;
  updatedAt?: Date;
  isMinimized?: boolean;
}

/**
 * Platform-specific metadata container
 */
export interface ChangesetMetadata {
  /** GitHub-specific data */
  github?: {
    number: number;
    url: string;
    htmlUrl: string;
    apiUrl: string;
    isDraft: boolean;
    isMergeable: boolean;
    mergeableState: string;
    headSha: string;
    baseSha: string;
  };

  /** GitLab-specific data */
  gitlab?: {
    iid: number;
    webUrl: string;
    mergeStatus: string;
    pipelineStatus?: string;
    targetProjectId: number;
    sourceProjectId: number;
  };

  /** Bitbucket-specific data */
  bitbucket?: {
    id: number;
    url: string;
    state: string;
    reviewers: string[];
  };

  /** Gerrit-specific data */
  gerrit?: {
    number: number;
    changeId: string;
    topic?: string;
    project: string;
    branch: string;
  };

  /** Local git workflow data */
  local?: {
    prBranch: string;
    baseBranch: string;
    sessionName?: string;
    isPrepared: boolean;
    mergeCommitReady: boolean;
  };
}

/**
 * Options for listing changesets
 */
export interface ChangesetListOptions {
  /** Filter by status */
  status?: ChangesetStatus | ChangesetStatus[];

  /** Filter by author */
  author?: string;

  /** Filter by target branch */
  targetBranch?: string;

  /** Maximum number of results */
  limit?: number;

  /** Include closed/merged changesets */
  includeClosed?: boolean;

  /** Date range filter */
  since?: Date;
  until?: Date;

  /** Platform-specific filters */
  platformFilters?: Record<string, any>;
}

/**
 * Search options for changesets
 */
export interface ChangesetSearchOptions extends ChangesetListOptions {
  /** Search query string */
  query: string;

  /** Search in title */
  searchTitle?: boolean;

  /** Search in description */
  searchDescription?: boolean;

  /** Search in comments */
  searchComments?: boolean;

  /** Search in commit messages */
  searchCommits?: boolean;
}

/**
 * Options for creating a changeset
 */
export interface CreateChangesetOptions {
  title: string;
  description: string;
  targetBranch: string;
  sourceBranch?: string;
  isDraft?: boolean;
  assignees?: string[];
  reviewers?: string[];
  labels?: string[];
  sessionName?: string;
  taskId?: string;
}

/**
 * Result of changeset creation
 */
export interface CreateChangesetResult {
  changeset: Changeset;
  url?: string;
  platformId: string | number;
}

/**
 * Result of changeset merge operation
 */
export interface MergeChangesetResult {
  success: boolean;
  mergeCommitSha?: string;
  mergedAt: Date;
  mergedBy: string;
  deletedBranch?: boolean;
}
