/**
 * Conflict Detection Types
 *
 * Type definitions for comprehensive conflict detection and analysis
 * across all git operations.
 */

export interface ConflictPrediction {
  hasConflicts: boolean;
  conflictType: ConflictType;
  severity: ConflictSeverity;
  affectedFiles: ConflictFile[];
  resolutionStrategies: ResolutionStrategy[];
  userGuidance: string;
  recoveryCommands: string[];
  /** Whether the conflicts can be automatically resolved */
  canAutoResolve?: boolean;
  /** Recommendations for resolving conflicts */
  recommendations?: string[];
  /** Overall complexity of the conflict */
  overallComplexity?: "simple" | "moderate" | "complex";
}

export interface ConflictFile {
  path: string;
  status: FileConflictStatus;
  conflictRegions?: ConflictRegion[];
  deletionInfo?: DeletionInfo;
}

export interface ConflictRegion {
  startLine: number;
  endLine: number;
  type: "content" | "deletion" | "addition";
  description: string;
}

export interface DeletionInfo {
  deletedInBranch: string;
  modifiedInBranch: string;
  lastCommitHash: string;
  canAutoResolve: boolean;
}

export interface BranchSwitchWarning {
  fromBranch: string;
  toBranch: string;
  uncommittedChanges: string[];
  conflictingFiles: string[];
  wouldLoseChanges: boolean;
  recommendedAction: "commit" | "stash" | "force" | "abort";
  stashStrategy?: StashStrategy;
}

export interface RebaseConflictPrediction {
  baseBranch: string;
  featureBranch: string;
  conflictingCommits: ConflictingCommit[];
  overallComplexity: "simple" | "moderate" | "complex";
  estimatedResolutionTime: string;
  canAutoResolve: boolean;
  recommendations: string[];
}

export interface ConflictingCommit {
  sha: string;
  message: string;
  author: string;
  conflictFiles: string[];
  complexity: "simple" | "moderate" | "complex";
}

export interface StashStrategy {
  type: "full" | "partial" | "keep_index";
  description: string;
  commands: string[];
}

export interface AdvancedResolutionStrategy {
  type: "intelligent" | "pattern_based" | "user_preference";
  confidence: number;
  description: string;
  commands: string[];
  riskLevel: "low" | "medium" | "high";
  applicableFileTypes: string[];
}

export interface ResolutionStrategy {
  type: "automatic" | "guided" | "manual";
  description: string;
  commands: string[];
  riskLevel: "low" | "medium" | "high";
}

export interface BranchDivergenceAnalysis {
  sessionBranch: string;
  baseBranch: string;
  /**
   * Commit counts, or **null when the comparison could not be made** (mt#3220)
   * — `rev-list` failed, or returned output that did not parse.
   *
   * Null is not zero. Previously both defaulted to `0`, which is
   * indistinguishable from a genuinely converged pair of branches, and drove
   * `divergenceType: "none"` → a caller skipping an update it may have needed.
   */
  aheadCommits: number | null;
  behindCommits: number | null;
  /** Merge base, or null when it could not be determined (was `""` — same ambiguity). */
  lastCommonCommit: string | null;
  sessionChangesInBase: boolean;
  /**
   * `"unknown"` means the comparison did not produce an answer — distinct from
   * `"none"`, which asserts the branches ARE converged. Callers must not treat
   * the two alike: `"none"` is a measurement, `"unknown"` is its absence.
   */
  divergenceType: "none" | "ahead" | "behind" | "diverged" | "unknown";
  /**
   * `"manual_review"` accompanies `divergenceType: "unknown"` — deliberately NOT
   * `"none"`, which would read as "verified nothing to do" for a comparison that
   * never happened.
   */
  recommendedAction: "none" | "fast_forward" | "update_needed" | "skip_update" | "manual_review";
}

export interface EnhancedMergeResult {
  workdir: string;
  merged: boolean;
  conflicts: boolean;
  conflictDetails?: string;
  prediction?: ConflictPrediction;
  /**
   * When conflicts is true and markers were left in the working tree,
   * lists the paths of conflicted files so callers can surface them to the agent.
   */
  conflictedFiles?: string[];
}

export interface SmartUpdateResult {
  workdir: string;
  updated: boolean;
  skipped: boolean;
  reason?: string;
  conflictDetails?: string;
  divergenceAnalysis?: BranchDivergenceAnalysis;
  /**
   * When conflictDetails is set, lists the paths of files that contain
   * conflict markers in the working tree, allowing agents to resolve them
   * via session_edit_file / session_search_replace.
   */
  conflictedFiles?: string[];
}

export enum ConflictType {
  NONE = "none",
  CONTENT_CONFLICT = "content_conflict",
  DELETE_MODIFY = "delete_modify",
  RENAME_CONFLICT = "rename_conflict",
  MODE_CONFLICT = "mode_conflict",
  ALREADY_MERGED = "already_merged",
  UNCOMMITTED_CHANGES = "uncommitted_changes",
  REBASE_CONFLICT = "rebase_conflict",
}

export enum ConflictSeverity {
  NONE = "none",
  AUTO_RESOLVABLE = "auto_resolvable",
  MANUAL_SIMPLE = "manual_simple",
  MANUAL_COMPLEX = "manual_complex",
  BLOCKING = "blocking",
}

export enum FileConflictStatus {
  CLEAN = "clean",
  MODIFIED_BOTH = "modified_both",
  DELETED_BY_US = "deleted_by_us",
  DELETED_BY_THEM = "deleted_by_them",
  ADDED_BY_US = "added_by_us",
  ADDED_BY_THEM = "added_by_them",
  RENAMED = "renamed",
}
