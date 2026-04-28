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
  aheadCommits: number;
  behindCommits: number;
  lastCommonCommit: string;
  sessionChangesInBase: boolean;
  divergenceType: "none" | "ahead" | "behind" | "diverged";
  recommendedAction: "none" | "fast_forward" | "update_needed" | "skip_update";
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
