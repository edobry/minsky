/**
 * Types for PR Approval and Merge Decoupling
 * 
 * Defines the new interfaces needed to separate PR approval from merging
 * as outlined in Task #358.
 */

/**
 * Information about a PR approval operation
 */
export interface ApprovalInfo {
  /**
   * Review ID from the platform (GitHub review ID, or generated local ID)
   */
  reviewId: string | number;

  /**
   * User who approved the PR
   */
  approvedBy: string;

  /**
   * ISO timestamp when approval was granted
   */
  approvedAt: string;

  /**
   * Optional review comment provided with approval
   */
  comment?: string;

  /**
   * PR number or identifier that was approved
   */
  prNumber: string | number;

  /**
   * Platform-specific metadata
   */
  metadata?: {
    /**
     * GitHub-specific data
     */
    github?: {
      reviewId: number;
      reviewState: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
      reviewerLogin: string;
      submittedAt: string;
    };

    /**
     * Local/Remote repository data
     */
    local?: {
      approvalId: string;
      sessionName: string;
      taskId?: string;
    };

    [key: string]: any;
  };
}

/**
 * Current approval status of a pull request
 */
export interface ApprovalStatus {
  /**
   * Whether the PR has sufficient approvals to be merged
   */
  isApproved: boolean;

  /**
   * List of all approvals for this PR
   */
  approvals: ApprovalInfo[];

  /**
   * Number of approvals required (from branch protection or repo settings)
   */
  requiredApprovals: number;

  /**
   * Whether the PR can be merged (considers approvals, status checks, etc.)
   */
  canMerge: boolean;

  /**
   * Current state of the pull request
   */
  prState: "open" | "closed" | "merged" | "draft";

  /**
   * Platform-specific approval metadata
   */
  metadata?: {
    /**
     * GitHub-specific approval data
     */
    github?: {
      /**
       * Required status checks and their states
       */
      statusChecks: Array<{
        context: string;
        state: "pending" | "success" | "failure";
        targetUrl?: string;
      }>;

      /**
       * Branch protection rules affecting merge
       */
      branchProtection: {
        requiredReviews: number;
        dismissStaleReviews: boolean;
        requireCodeOwnerReviews: boolean;
        restrictPushes: boolean;
      };

      /**
       * CODEOWNERS requirements
       */
      codeownersApproval?: boolean;
    };

    /**
     * Local/Remote repository approval data
     */
    local?: {
      sessionWorkspace: string;
      approvalSource: "manual" | "automatic";
    };

    [key: string]: any;
  };
}

/**
 * Error types for approval operations
 */
export class ApprovalError extends Error {
  constructor(
    message: string,
    public prIdentifier: string | number,
    public code?: string
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

export class InsufficientPermissionsError extends ApprovalError {
  constructor(prIdentifier: string | number, requiredPermission: string) {
    super(
      `Insufficient permissions to approve PR ${prIdentifier}. Required: ${requiredPermission}`,
      prIdentifier,
      "INSUFFICIENT_PERMISSIONS"
    );
    this.name = "InsufficientPermissionsError";
  }
}

export class AlreadyApprovedError extends ApprovalError {
  constructor(prIdentifier: string | number, approvedBy: string) {
    super(
      `PR ${prIdentifier} is already approved by ${approvedBy}`,
      prIdentifier,
      "ALREADY_APPROVED"
    );
    this.name = "AlreadyApprovedError";
  }
}

export class PullRequestNotFoundError extends ApprovalError {
  constructor(prIdentifier: string | number) {
    super(
      `Pull request ${prIdentifier} not found`,
      prIdentifier,
      "PR_NOT_FOUND"
    );
    this.name = "PullRequestNotFoundError";
  }
}

/**
 * Error types for merge operations
 */
export class MergeError extends Error {
  constructor(
    message: string,
    public prIdentifier: string | number,
    public code?: string
  ) {
    super(message);
    this.name = "MergeError";
  }
}

export class NotApprovedError extends MergeError {
  constructor(prIdentifier: string | number, requiredApprovals: number, currentApprovals: number) {
    super(
      `PR ${prIdentifier} cannot be merged: ${currentApprovals}/${requiredApprovals} approvals`,
      prIdentifier,
      "NOT_APPROVED"
    );
    this.name = "NotApprovedError";
  }
}

export class MergeConflictError extends MergeError {
  constructor(prIdentifier: string | number, conflictDetails: string) {
    super(
      `PR ${prIdentifier} has merge conflicts: ${conflictDetails}`,
      prIdentifier,
      "MERGE_CONFLICT"
    );
    this.name = "MergeConflictError";
  }
}

export class BranchProtectionError extends MergeError {
  constructor(prIdentifier: string | number, violation: string) {
    super(
      `PR ${prIdentifier} violates branch protection rules: ${violation}`,
      prIdentifier,
      "BRANCH_PROTECTION_VIOLATION"
    );
    this.name = "BranchProtectionError";
  }
}

/**
 * Configuration for approval operations
 */
export interface ApprovalConfig {
  /**
   * Whether to require a review comment when approving
   */
  requireComment?: boolean;

  /**
   * Whether to automatically dismiss stale reviews
   */
  dismissStaleReviews?: boolean;

  /**
   * Whether to skip approval if already approved by same user
   */
  allowReapproval?: boolean;

  /**
   * Custom validation rules for approval
   */
  customValidation?: (prIdentifier: string | number) => Promise<boolean>;
}

/**
 * Configuration for merge operations
 */
export interface MergeConfig {
  /**
   * Merge strategy to use
   */
  strategy?: "merge" | "squash" | "rebase";

  /**
   * Whether to delete the source branch after merge
   */
  deleteBranch?: boolean;

  /**
   * Whether to skip status checks (admin override)
   */
  skipStatusChecks?: boolean;

  /**
   * Custom commit message for merge commit
   */
  commitMessage?: string;

  /**
   * Custom validation before merge
   */
  premergeValidation?: (prIdentifier: string | number) => Promise<void>;
}
