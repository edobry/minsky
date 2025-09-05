/**
 * Changeset Adapter Interface
 *
 * Platform-specific adapters implement this interface to provide unified
 * changeset operations across different VCS platforms.
 */

import type {
  Changeset,
  ChangesetListOptions,
  ChangesetSearchOptions,
  CreateChangesetOptions,
  CreateChangesetResult,
  MergeChangesetResult,
  ChangesetPlatform,
} from "./types";

/**
 * Core changeset adapter interface
 * Each platform (GitHub, GitLab, etc.) implements this interface
 */
export interface ChangesetAdapter {
  /** Platform identifier */
  readonly platform: ChangesetPlatform;

  /** Human-readable platform name */
  readonly name: string;

  /** Check if this adapter is available/configured */
  isAvailable(): Promise<boolean>;

  /** List changesets with filtering */
  list(options?: ChangesetListOptions): Promise<Changeset[]>;

  /** Get a specific changeset by ID */
  get(id: string): Promise<Changeset | null>;

  /** Search changesets */
  search(options: ChangesetSearchOptions): Promise<Changeset[]>;

  /** Create a new changeset */
  create(options: CreateChangesetOptions): Promise<CreateChangesetResult>;

  /** Update an existing changeset */
  update(id: string, updates: Partial<CreateChangesetOptions>): Promise<Changeset>;

  /** Merge a changeset */
  merge(id: string, options?: { deleteSourceBranch?: boolean }): Promise<MergeChangesetResult>;

  /** Approve a changeset (if platform supports separate approval) */
  approve?(id: string, comment?: string): Promise<{ success: boolean; reviewId: string }>;

  /** Get detailed changeset information including diffs */
  getDetails(id: string): Promise<ChangesetDetails>;

  /** Platform-specific feature detection */
  supportsFeature(feature: ChangesetFeature): boolean;
}

/**
 * Detailed changeset information including diffs and file changes
 */
export interface ChangesetDetails extends Changeset {
  /** File changes and diffs */
  files: ChangesetFile[];

  /** Overall diff statistics */
  diffStats: {
    additions: number;
    deletions: number;
    filesChanged: number;
  };

  /** Full diff content (optional, may be large) */
  fullDiff?: string;
}

/**
 * File change information in a changeset
 */
export interface ChangesetFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previousPath?: string; // For renames
}

/**
 * Features that changeset adapters may support
 */
export type ChangesetFeature =
  | "approval_workflow" // Separate approve vs merge
  | "draft_changesets" // Draft PRs/MRs
  | "file_comments" // Line-level comments
  | "suggested_changes" // Inline suggestions
  | "auto_merge" // Automatic merging
  | "branch_protection" // Branch protection rules
  | "status_checks" // CI/CD status checks
  | "assignee_management" // Assignees and reviewers
  | "label_management" // Labels/tags
  | "milestone_tracking"; // Milestones

/**
 * Adapter factory interface for creating platform-specific adapters
 */
export interface ChangesetAdapterFactory {
  /** Platform this factory creates adapters for */
  readonly platform: ChangesetPlatform;

  /** Create an adapter instance for the given repository */
  createAdapter(repositoryUrl: string, config?: any): Promise<ChangesetAdapter>;

  /** Check if this factory can handle the given repository */
  canHandle(repositoryUrl: string): boolean;
}

/**
 * Configuration for changeset adapters
 */
export interface ChangesetAdapterConfig {
  /** Repository URL */
  repositoryUrl: string;

  /** Platform-specific authentication */
  auth?: {
    token?: string;
    username?: string;
    password?: string;
    apiUrl?: string;
  };

  /** Default options for operations */
  defaults?: {
    targetBranch?: string;
    reviewers?: string[];
    labels?: string[];
  };

  /** Feature flags */
  features?: {
    enableDrafts?: boolean;
    autoDeleteBranches?: boolean;
    requireApproval?: boolean;
  };
}
