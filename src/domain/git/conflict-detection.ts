/**
 * Conflict Detection Service
 * 
 * Provides comprehensive conflict detection and analysis for all git operations,
 * helping prevent merge conflicts before they occur across the entire git workflow.
 */

import { execAsync } from "../../utils/exec";
import { log } from "../../utils/logger";

export interface ConflictPrediction {
  hasConflicts: boolean;
  conflictType: ConflictType;
  severity: ConflictSeverity;
  affectedFiles: ConflictFile[];
  resolutionStrategies: ResolutionStrategy[];
  userGuidance: string;
  recoveryCommands: string[];
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

// New interfaces for comprehensive git workflow protection
export interface GitOperationPreview {
  operation: GitOperationType;
  repoPath: string;
  sourceRef: string;
  targetRef?: string;
  prediction: ConflictPrediction;
  safeToExecute: boolean;
  recommendedActions: string[];
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

export enum GitOperationType {
  MERGE = "merge",
  REBASE = "rebase",
  CHECKOUT = "checkout",
  SWITCH = "switch",
  PULL = "pull",
  CHERRY_PICK = "cherry-pick"
}

export enum ConflictType {
  NONE = "none",
  CONTENT_CONFLICT = "content_conflict",
  DELETE_MODIFY = "delete_modify",
  RENAME_CONFLICT = "rename_conflict",
  MODE_CONFLICT = "mode_conflict",
  ALREADY_MERGED = "already_merged",
  UNCOMMITTED_CHANGES = "uncommitted_changes",
  REBASE_CONFLICT = "rebase_conflict"
}

export enum ConflictSeverity {
  NONE = "none",
  AUTO_RESOLVABLE = "auto_resolvable",
  MANUAL_SIMPLE = "manual_simple",
  MANUAL_COMPLEX = "manual_complex",
  BLOCKING = "blocking"
}

export enum FileConflictStatus {
  CLEAN = "clean",
  MODIFIED_BOTH = "modified_both",
  DELETED_BY_US = "deleted_by_us",
  DELETED_BY_THEM = "deleted_by_them",
  ADDED_BY_US = "added_by_us",
  ADDED_BY_THEM = "added_by_them",
  RENAMED = "renamed"
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
}

export interface SmartUpdateResult {
  workdir: string;
  updated: boolean;
  skipped: boolean;
  reason?: string;
  conflictDetails?: string;
  divergenceAnalysis?: BranchDivergenceAnalysis;
}

export class ConflictDetectionService {
  /**
   * Predicts conflicts between two branches without performing actual merge
   */
  static async predictConflicts(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<ConflictPrediction> {
    const service = new ConflictDetectionService();
    return service.predictMergeConflicts(repoPath, sourceBranch, targetBranch);
  }

  /**
   * Analyzes branch divergence between session and base branches
   */
  static async analyzeBranchDivergence(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string
  ): Promise<BranchDivergenceAnalysis> {
    const service = new ConflictDetectionService();
    return service.analyzeBranchDivergence(repoPath, sessionBranch, baseBranch);
  }

  /**
   * Enhanced merge with conflict prediction and better handling
   */
  static async mergeWithConflictPrevention(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string,
    options?: {
      skipConflictCheck?: boolean;
      autoResolveDeleteConflicts?: boolean;
      dryRun?: boolean;
    }
  ): Promise<EnhancedMergeResult> {
    const service = new ConflictDetectionService();
    return service.mergeWithConflictPrevention(repoPath, sourceBranch, targetBranch, options);
  }

  /**
   * Smart session update that detects already-merged changes
   */
  static async smartSessionUpdate(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string,
    options?: {
      skipIfAlreadyMerged?: boolean;
      autoResolveConflicts?: boolean;
    }
  ): Promise<SmartUpdateResult> {
    const service = new ConflictDetectionService();
    return service.smartSessionUpdate(repoPath, sessionBranch, baseBranch, options);
  }

  /**
   * NEW: Preview any git operation for potential conflicts
   */
  static async previewGitOperation(
    repoPath: string,
    operation: GitOperationType,
    sourceRef: string,
    targetRef?: string
  ): Promise<GitOperationPreview> {
    const service = new ConflictDetectionService();
    return service.previewGitOperation(repoPath, operation, sourceRef, targetRef);
  }

  /**
   * NEW: Check for branch switching conflicts and uncommitted changes
   */
  static async checkBranchSwitchConflicts(
    repoPath: string,
    targetBranch: string
  ): Promise<BranchSwitchWarning> {
    const service = new ConflictDetectionService();
    return service.checkBranchSwitchConflicts(repoPath, targetBranch);
  }

  /**
   * NEW: Predict conflicts for rebase operations
   */
  static async predictRebaseConflicts(
    repoPath: string,
    baseBranch: string,
    featureBranch: string
  ): Promise<RebaseConflictPrediction> {
    const service = new ConflictDetectionService();
    return service.predictRebaseConflicts(repoPath, baseBranch, featureBranch);
  }

  /**
   * NEW: Generate advanced resolution strategies based on patterns
   */
  static async generateAdvancedResolutionStrategies(
    repoPath: string,
    conflictFiles: ConflictFile[]
  ): Promise<AdvancedResolutionStrategy[]> {
    const service = new ConflictDetectionService();
    return service.generateAdvancedResolutionStrategies(repoPath, conflictFiles);
  }

  /**
   * Predicts conflicts between two branches without performing actual merge
   */
  async predictMergeConflicts(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<ConflictPrediction> {
    log.debug("Predicting merge conflicts", { repoPath, sourceBranch, targetBranch });

    try {
      // First, analyze branch divergence
      const divergence = await this.analyzeBranchDivergence(repoPath, sourceBranch, targetBranch);
      
      // If already merged, no conflicts
      if (divergence.sessionChangesInBase) {
        return {
          hasConflicts: false,
          conflictType: ConflictType.ALREADY_MERGED,
          severity: ConflictSeverity.NONE,
          affectedFiles: [],
          resolutionStrategies: [{
            type: "automatic",
            description: "Session changes already in base branch",
            commands: ["# No action needed - changes already merged"],
            riskLevel: "low"
          }],
          userGuidance: "Your session changes have already been merged into the base branch. You can skip the update or create a PR without conflicts.",
          recoveryCommands: ["minsky session pr --no-update"]
        };
      }

      // Simulate merge to detect conflicts
      const conflictFiles = await this.simulateMerge(repoPath, sourceBranch, targetBranch);
      
      if (conflictFiles.length === 0) {
        return {
          hasConflicts: false,
          conflictType: ConflictType.NONE,
          severity: ConflictSeverity.NONE,
          affectedFiles: [],
          resolutionStrategies: [],
          userGuidance: "No conflicts detected. Safe to proceed with merge.",
          recoveryCommands: []
        };
      }

      // Analyze conflict types and severity
      const { conflictType, severity } = this.analyzeConflictSeverity(conflictFiles);
      const resolutionStrategies = this.generateResolutionStrategies(conflictFiles, conflictType);
      const userGuidance = this.generateUserGuidance(conflictType, severity, conflictFiles);
      const recoveryCommands = this.generateRecoveryCommands(conflictFiles, conflictType);

      return {
        hasConflicts: true,
        conflictType,
        severity,
        affectedFiles: conflictFiles,
        resolutionStrategies,
        userGuidance,
        recoveryCommands
      };

    } catch (error) {
      log.error("Error predicting merge conflicts", { error, repoPath, sourceBranch, targetBranch });
      throw error;
    }
  }

  /**
   * Analyzes branch divergence to understand relationship between branches
   */
  async analyzeBranchDivergence(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string
  ): Promise<BranchDivergenceAnalysis> {
    log.debug("Analyzing branch divergence", { repoPath, sessionBranch, baseBranch });

    try {
      // Get commit counts
      const { stdout: aheadBehind } = await execAsync(
        `git -C ${repoPath} rev-list --left-right --count ${baseBranch}...${sessionBranch}`
      );
      const [behind, ahead] = aheadBehind.trim().split("\t").map(Number);

      // Get last common commit
      const { stdout: commonCommit } = await execAsync(
        `git -C ${repoPath} merge-base ${baseBranch} ${sessionBranch}`
      );

      // Check if session changes are already in base
      const sessionChangesInBase = await this.checkSessionChangesInBase(
        repoPath, sessionBranch, baseBranch
      );

      // Determine divergence type
      let divergenceType: BranchDivergenceAnalysis["divergenceType"];
      let recommendedAction: BranchDivergenceAnalysis["recommendedAction"];

      if (ahead === 0 && behind === 0) {
        divergenceType = "none";
        recommendedAction = "none";
      } else if (ahead > 0 && behind === 0) {
        divergenceType = "ahead";
        recommendedAction = sessionChangesInBase ? "skip_update" : "none";
      } else if (ahead === 0 && behind > 0) {
        divergenceType = "behind";
        recommendedAction = "fast_forward";
      } else {
        divergenceType = "diverged";
        recommendedAction = sessionChangesInBase ? "skip_update" : "update_needed";
      }

      return {
        sessionBranch,
        baseBranch,
        aheadCommits: ahead,
        behindCommits: behind,
        lastCommonCommit: commonCommit.trim(),
        sessionChangesInBase,
        divergenceType,
        recommendedAction
      };

    } catch (error) {
      log.error("Error analyzing branch divergence", { error, repoPath, sessionBranch, baseBranch });
      throw error;
    }
  }

  /**
   * Enhanced merge with conflict prediction and better handling
   */
  async mergeWithConflictPrevention(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string,
    options?: {
      skipConflictCheck?: boolean;
      autoResolveDeleteConflicts?: boolean;
      dryRun?: boolean;
    }
  ): Promise<EnhancedMergeResult> {
    log.debug("Enhanced merge with conflict prevention", { repoPath, sourceBranch, targetBranch, options });

    try {
      let prediction: ConflictPrediction | undefined;

      // Step 1: Predict conflicts unless skipped
      if (!options?.skipConflictCheck) {
        prediction = await this.predictMergeConflicts(repoPath, sourceBranch, targetBranch);
        
        if (prediction.hasConflicts && options?.dryRun) {
          return {
            workdir: repoPath,
            merged: false,
            conflicts: true,
            conflictDetails: prediction.userGuidance,
            prediction
          };
        }

        // Auto-resolve delete conflicts if requested
        if (prediction.hasConflicts && 
            prediction.conflictType === ConflictType.DELETE_MODIFY &&
            options?.autoResolveDeleteConflicts) {
          await this.autoResolveDeleteConflicts(repoPath, prediction.affectedFiles);
        }
      }

      // Step 2: Perform actual merge if not dry run
      if (!options?.dryRun) {
        const { stdout: beforeHash } = await execAsync(`git -C ${repoPath} rev-parse HEAD`);
        
        try {
          await execAsync(`git -C ${repoPath} merge ${sourceBranch}`);
          
          const { stdout: afterHash } = await execAsync(`git -C ${repoPath} rev-parse HEAD`);
          const merged = beforeHash.trim() !== afterHash.trim();
          
          return {
            workdir: repoPath,
            merged,
            conflicts: false,
            prediction
          };
          
        } catch (mergeError) {
          // Check for conflicts
          const { stdout: status } = await execAsync(`git -C ${repoPath} status --porcelain`);
          const hasConflicts = status.includes("UU") || status.includes("AA") || status.includes("DD");
          
          if (hasConflicts) {
            return {
              workdir: repoPath,
              merged: false,
              conflicts: true,
              conflictDetails: prediction?.userGuidance || "Merge conflicts detected",
              prediction
            };
          }
          
          throw mergeError;
        }
      }

      // Dry run result
      return {
        workdir: repoPath,
        merged: false,
        conflicts: prediction?.hasConflicts || false,
        conflictDetails: prediction?.userGuidance,
        prediction
      };

    } catch (error) {
      log.error("Error in enhanced merge", { error, repoPath, sourceBranch, targetBranch });
      throw error;
    }
  }

  /**
   * Smart session update that detects already-merged changes
   */
  async smartSessionUpdate(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string,
    options?: {
      skipIfAlreadyMerged?: boolean;
      autoResolveConflicts?: boolean;
    }
  ): Promise<SmartUpdateResult> {
    log.debug("Smart session update", { repoPath, sessionBranch, baseBranch, options });

    try {
      // Analyze branch divergence
      const divergence = await this.analyzeBranchDivergence(repoPath, sessionBranch, baseBranch);

      // Check if we should skip update
      if (options?.skipIfAlreadyMerged && divergence.sessionChangesInBase) {
        return {
          workdir: repoPath,
          updated: false,
          skipped: true,
          reason: "Session changes already in base branch",
          divergenceAnalysis: divergence
        };
      }

      // If no update needed
      if (divergence.divergenceType === "none" || divergence.divergenceType === "ahead") {
        return {
          workdir: repoPath,
          updated: false,
          skipped: true,
          reason: "No update needed - session is current or ahead",
          divergenceAnalysis: divergence
        };
      }

      // Perform update based on divergence analysis
      if (divergence.recommendedAction === "fast_forward") {
        // Simple fast-forward
        await execAsync(`git -C ${repoPath} fetch origin ${baseBranch}`);
        await execAsync(`git -C ${repoPath} merge --ff-only origin/${baseBranch}`);
        
        return {
          workdir: repoPath,
          updated: true,
          skipped: false,
          reason: "Fast-forward update completed",
          divergenceAnalysis: divergence
        };
      } else {
        // Complex merge needed
        const mergeResult = await this.mergeWithConflictPrevention(
          repoPath, 
          `origin/${baseBranch}`, 
          sessionBranch,
          { autoResolveDeleteConflicts: options?.autoResolveConflicts }
        );

        return {
          workdir: repoPath,
          updated: mergeResult.merged,
          skipped: false,
          reason: mergeResult.conflicts ? "Update failed due to conflicts" : "Merge update completed",
          conflictDetails: mergeResult.conflictDetails,
          divergenceAnalysis: divergence
        };
      }

    } catch (error) {
      log.error("Error in smart session update", { error, repoPath, sessionBranch, baseBranch });
      throw error;
    }
  }

  /**
   * NEW: Preview any git operation for potential conflicts
   */
  async previewGitOperation(
    repoPath: string,
    operation: GitOperationType,
    sourceRef: string,
    targetRef?: string
  ): Promise<GitOperationPreview> {
    log.debug("Previewing git operation", { repoPath, operation, sourceRef, targetRef });

    try {
      let prediction: ConflictPrediction | undefined;
      let safeToExecute = true;
      let recommendedActions: string[] = [];

      // Simulate the operation to predict conflicts
      switch (operation) {
      case GitOperationType.MERGE:
        prediction = await this.predictMergeConflicts(repoPath, sourceRef, targetRef || "HEAD");
        safeToExecute = !prediction.hasConflicts;
        recommendedActions = prediction.hasConflicts ? prediction.userGuidance.split("\n") : [];
        break;
      case GitOperationType.REBASE:
        prediction = await this.predictRebaseConflicts(repoPath, sourceRef, targetRef || "HEAD");
        safeToExecute = !prediction.canAutoResolve; // Rebase conflicts are blocking
        recommendedActions = prediction.recommendations;
        break;
      case GitOperationType.CHECKOUT:
        // For checkout, we need to simulate a merge-like conflict
        // This is a simplified check, as actual checkout can be complex
        // For now, we'll assume it's safe if no conflicts are predicted
        prediction = await this.predictMergeConflicts(repoPath, sourceRef, "HEAD");
        safeToExecute = !prediction.hasConflicts;
        recommendedActions = prediction.hasConflicts ? prediction.userGuidance.split("\n") : [];
        break;
      case GitOperationType.SWITCH: {
        // For switch, we need to check for uncommitted changes and conflicts
        const branchSwitchWarning = await this.checkBranchSwitchConflicts(repoPath, sourceRef);
        safeToExecute = !branchSwitchWarning.wouldLoseChanges;
        recommendedActions = branchSwitchWarning.recommendedAction === "abort" ? ["Abort operation"] : [];
        break;
      }
      case GitOperationType.PULL:
        // For pull, we need to predict conflicts if the source is a branch
        if (targetRef) {
          prediction = await this.predictMergeConflicts(repoPath, sourceRef, targetRef);
          safeToExecute = !prediction.hasConflicts;
          recommendedActions = prediction.hasConflicts ? prediction.userGuidance.split("\n") : [];
        } else {
          // If source is a branch, it's a fetch, which is generally safe
          safeToExecute = true;
          recommendedActions = [];
        }
        break;
      case GitOperationType.CHERRY_PICK:
        // Cherry-pick is similar to merge, but with a single commit
        prediction = await this.predictMergeConflicts(repoPath, sourceRef, "HEAD");
        safeToExecute = !prediction.hasConflicts;
        recommendedActions = prediction.hasConflicts ? prediction.userGuidance.split("\n") : [];
        break;
      default:
        safeToExecute = true;
        recommendedActions = [];
        break;
      }

      return {
        operation,
        repoPath,
        sourceRef,
        targetRef,
        prediction,
        safeToExecute,
        recommendedActions
      };

    } catch (error) {
      log.error("Error previewing git operation", { error, repoPath, operation, sourceRef, targetRef });
      throw error;
    }
  }

  /**
   * NEW: Check for branch switching conflicts and uncommitted changes
   */
  async checkBranchSwitchConflicts(
    repoPath: string,
    targetBranch: string
  ): Promise<BranchSwitchWarning> {
    log.debug("Checking branch switch conflicts", { repoPath, targetBranch });

    try {
      const { stdout: uncommittedChanges } = await execAsync(`git -C ${repoPath} status --porcelain`);
      const uncommittedFiles = uncommittedChanges
        .trim()
        .split("\n")
        .filter(line => line.trim() && line.trim().startsWith("??"))
        .map(line => line.substring(3));

      const { stdout: conflictingFiles } = await execAsync(`git -C ${repoPath} status --porcelain`);
      const hasConflicts = conflictingFiles.includes("UU") || conflictingFiles.includes("AA") || conflictingFiles.includes("DD");

      const wouldLoseChanges = await this.checkWouldLoseChanges(repoPath, targetBranch);

      let recommendedAction: BranchSwitchWarning["recommendedAction"];
      let stashStrategy: StashStrategy | undefined;

      if (hasConflicts) {
        recommendedAction = "abort";
      } else if (uncommittedChanges.trim() && !wouldLoseChanges) {
        recommendedAction = "commit";
      } else if (uncommittedChanges.trim() && wouldLoseChanges) {
        recommendedAction = "stash";
        stashStrategy = {
          type: "full",
          description: "Stash all changes to keep uncommitted changes and avoid losing them",
          commands: [
            "git stash save -u \"Uncommitted changes before branch switch\"",
            `git checkout ${  targetBranch}`
          ]
        };
      } else {
        recommendedAction = "force";
      }

      return {
        fromBranch: "HEAD", // Assuming HEAD is the current branch
        toBranch: targetBranch,
        uncommittedChanges: uncommittedFiles,
        conflictingFiles: [], // This will be populated by analyzeConflictFiles
        wouldLoseChanges,
        recommendedAction,
        stashStrategy
      };

    } catch (error) {
      log.error("Error checking branch switch conflicts", { error, repoPath, targetBranch });
      throw error;
    }
  }

  /**
   * NEW: Predict conflicts for rebase operations
   */
  async predictRebaseConflicts(
    repoPath: string,
    baseBranch: string,
    featureBranch: string
  ): Promise<RebaseConflictPrediction> {
    log.debug("Predicting rebase conflicts", { repoPath, baseBranch, featureBranch });

    try {
      // Simulate rebase to detect conflicts
      const tempBranch = `rebase-simulation-${Date.now()}`;
      
      try {
        // Create a temporary branch from the base branch
        await execAsync(`git -C ${repoPath} checkout -b ${tempBranch} ${baseBranch}`);
        
        // Attempt rebase
        try {
          await execAsync(`git -C ${repoPath} rebase ${featureBranch}`);
          
          // If rebase succeeds, reset and return no conflicts
          await execAsync(`git -C ${repoPath} reset --hard HEAD`);
          return {
            baseBranch,
            featureBranch,
            conflictingCommits: [],
            overallComplexity: "simple",
            estimatedResolutionTime: "Immediate",
            canAutoResolve: true,
            recommendations: ["Rebase completed successfully."]
          };
          
        } catch (rebaseError) {
          // Rebase failed, analyze conflicts
          const conflictFiles = await this.analyzeConflictFiles(repoPath);
          
          // Abort the rebase
          await execAsync(`git -C ${repoPath} rebase --abort`);
          
          // Analyze conflict severity and complexity
          const { conflictType, severity } = this.analyzeConflictSeverity(conflictFiles);
          const complexity = this.determineRebaseComplexity(conflictFiles);
          const resolutionStrategies = this.generateResolutionStrategies(conflictFiles, conflictType);
          const userGuidance = this.generateUserGuidance(conflictType, severity, conflictFiles);
          const recoveryCommands = this.generateRecoveryCommands(conflictFiles, conflictType);

          return {
            baseBranch,
            featureBranch,
            conflictingCommits: [], // This will be populated by analyzeConflictFiles
            overallComplexity: complexity,
            estimatedResolutionTime: "Depends on conflicts",
            canAutoResolve: false,
            recommendations: [userGuidance, ...resolutionStrategies.map(s => s.description)]
          };
        }
        
      } finally {
        // Clean up temporary branch
        try {
          await execAsync(`git -C ${repoPath} checkout ${baseBranch}`);
          await execAsync(`git -C ${repoPath} branch -D ${tempBranch}`);
        } catch (cleanupError) {
          log.warn("Failed to clean up temporary branch", { tempBranch, cleanupError });
        }
      }
      
    } catch (error) {
      log.error("Error predicting rebase conflicts", { error, repoPath, baseBranch, featureBranch });
      throw error;
    }
  }

  /**
   * NEW: Generate advanced resolution strategies based on patterns
   */
  async generateAdvancedResolutionStrategies(
    repoPath: string,
    conflictFiles: ConflictFile[]
  ): Promise<AdvancedResolutionStrategy[]> {
    log.debug("Generating advanced resolution strategies", { repoPath, conflictFiles });

    const strategies: AdvancedResolutionStrategy[] = [];

    // Pattern-based strategies
    const hasContentConflicts = conflictFiles.some(f => f.status === FileConflictStatus.MODIFIED_BOTH);
    const hasDeleteConflicts = conflictFiles.some(f => 
      f.status === FileConflictStatus.DELETED_BY_US || f.status === FileConflictStatus.DELETED_BY_THEM
    );
    const hasRenameConflicts = conflictFiles.some(f => f.status === FileConflictStatus.RENAMED);

    if (hasContentConflicts && hasDeleteConflicts) {
      strategies.push({
        type: "pattern_based",
        confidence: 0.8,
        description: "Accept deletions (recommended for removed files)",
        commands: [
          ...conflictFiles
            .filter(f => f.deletionInfo)
            .map(f => `git rm ${f.path}`),
          "git commit -m \"resolve conflicts: accept file deletions\""
        ],
        riskLevel: "low",
        applicableFileTypes: ["*"]
      });
    }

    if (hasRenameConflicts) {
      strategies.push({
        type: "pattern_based",
        confidence: 0.7,
        description: "Accept renames (recommended for renamed files)",
        commands: [
          ...conflictFiles
            .filter(f => f.status === FileConflictStatus.RENAMED)
            .map(f => `git mv ${f.path} ${f.path}.bak`),
          "git commit -m \"resolve conflicts: accept file renames\""
        ],
        riskLevel: "low",
        applicableFileTypes: ["*"]
      });
    }

    // Intelligent strategies (requires more sophisticated analysis)
    // This part would involve a more complex conflict analysis and resolution logic
    // For now, we'll just return a placeholder
    if (conflictFiles.length > 0) {
      strategies.push({
        type: "intelligent",
        confidence: 0.5,
        description: "Review and resolve conflicts manually",
        commands: ["git status", "git diff", "git add .", "git commit -m \"resolve merge conflicts\""],
        riskLevel: "medium",
        applicableFileTypes: ["*"]
      });
    }

    return strategies;
  }

  /**
   * Simulates a merge operation to detect conflicts without actually merging
   */
  private async simulateMerge(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<ConflictFile[]> {
    log.debug("Simulating merge", { repoPath, sourceBranch, targetBranch });

    try {
      // Create a temporary branch for simulation
      const tempBranch = `conflict-simulation-${Date.now()}`;
      
      try {
        // Create temp branch from target
        await execAsync(`git -C ${repoPath} checkout -b ${tempBranch} ${targetBranch}`);
        
        // Attempt merge
        try {
          await execAsync(`git -C ${repoPath} merge --no-commit --no-ff ${sourceBranch}`);
          
          // If merge succeeds, reset and return no conflicts
          await execAsync(`git -C ${repoPath} reset --hard HEAD`);
          return [];
          
        } catch (mergeError) {
          // Merge failed, analyze conflicts
          const conflictFiles = await this.analyzeConflictFiles(repoPath);
          
          // Abort the merge
          await execAsync(`git -C ${repoPath} merge --abort`);
          
          return conflictFiles;
        }
        
      } finally {
        // Clean up temporary branch
        try {
          await execAsync(`git -C ${repoPath} checkout ${targetBranch}`);
          await execAsync(`git -C ${repoPath} branch -D ${tempBranch}`);
        } catch (cleanupError) {
          log.warn("Failed to clean up temporary branch", { tempBranch, cleanupError });
        }
      }
      
    } catch (error) {
      log.error("Error simulating merge", { error, repoPath, sourceBranch, targetBranch });
      throw error;
    }
  }

  /**
   * Analyzes files in conflict state to determine conflict details
   */
  private async analyzeConflictFiles(repoPath: string): Promise<ConflictFile[]> {
    try {
      const { stdout: statusOutput } = await execAsync(`git -C ${repoPath} status --porcelain`);
      
      const conflictFiles: ConflictFile[] = [];
      const lines = statusOutput.trim().split("\n").filter(line => line.trim());
      
      for (const line of lines) {
        const status = line.substring(0, 2);
        const filePath = line.substring(3);
        
        let fileStatus: FileConflictStatus;
        let deletionInfo: DeletionInfo | undefined;
        
        switch (status) {
        case "UU":
          fileStatus = FileConflictStatus.MODIFIED_BOTH;
          break;
        case "DU":
          fileStatus = FileConflictStatus.DELETED_BY_US;
          deletionInfo = await this.analyzeDeletion(repoPath, filePath, "us");
          break;
        case "UD":
          fileStatus = FileConflictStatus.DELETED_BY_THEM;
          deletionInfo = await this.analyzeDeletion(repoPath, filePath, "them");
          break;
        case "AU":
          fileStatus = FileConflictStatus.ADDED_BY_US;
          break;
        case "UA":
          fileStatus = FileConflictStatus.ADDED_BY_THEM;
          break;
        default:
          continue; // Skip non-conflict files
        }
        
        const conflictRegions = fileStatus === FileConflictStatus.MODIFIED_BOTH 
          ? await this.analyzeConflictRegions(repoPath, filePath)
          : undefined;
        
        conflictFiles.push({
          path: filePath,
          status: fileStatus,
          conflictRegions,
          deletionInfo
        });
      }
      
      return conflictFiles;
      
    } catch (error) {
      log.error("Error analyzing conflict files", { error, repoPath });
      throw error;
    }
  }

  /**
   * Analyzes deletion conflicts to provide context and resolution options
   */
  private async analyzeDeletion(
    repoPath: string, 
    filePath: string, 
    deletedBy: "us" | "them"
  ): Promise<DeletionInfo> {
    try {
      // Get the last commit that touched this file
      const { stdout: lastCommit } = await execAsync(
        `git -C ${repoPath} log -n 1 --format=%H -- ${filePath}`
      );
      
      return {
        deletedInBranch: deletedBy === "us" ? "session" : "main",
        modifiedInBranch: deletedBy === "us" ? "main" : "session",
        lastCommitHash: lastCommit.trim(),
        canAutoResolve: true // Deletions are generally auto-resolvable
      };
      
    } catch (error) {
      log.warn("Could not analyze deletion", { error, filePath });
      return {
        deletedInBranch: deletedBy === "us" ? "session" : "main",
        modifiedInBranch: deletedBy === "us" ? "main" : "session",
        lastCommitHash: "unknown",
        canAutoResolve: false
      };
    }
  }

  /**
   * Analyzes conflict regions within a file
   */
  private async analyzeConflictRegions(repoPath: string, filePath: string): Promise<ConflictRegion[]> {
    try {
      const { stdout: fileContent } = await execAsync(`cat "${repoPath}/${filePath}"`);
      const lines = fileContent.split("\n");
      
      const regions: ConflictRegion[] = [];
      let inConflict = false;
      let startLine = 0;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.startsWith("<<<<<<<")) {
          inConflict = true;
          startLine = i + 1;
        } else if (line.startsWith(">>>>>>>") && inConflict) {
          regions.push({
            startLine,
            endLine: i + 1,
            type: "content",
            description: `Content conflict in lines ${startLine}-${i + 1}`
          });
          inConflict = false;
        }
      }
      
      return regions;
      
    } catch (error) {
      log.warn("Could not analyze conflict regions", { error, filePath });
      return [];
    }
  }

  /**
   * Checks if session changes are already present in the base branch
   */
  private async checkSessionChangesInBase(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string
  ): Promise<boolean> {
    try {
      // Get session commits not in base
      const { stdout: sessionCommits } = await execAsync(
        `git -C ${repoPath} rev-list ${baseBranch}..${sessionBranch}`
      );
      
      if (!sessionCommits.trim()) {
        return true; // No session commits not in base
      }
      
      // Check if the content changes are already in base by comparing trees
      const { stdout: sessionTree } = await execAsync(
        `git -C ${repoPath} rev-parse ${sessionBranch}^{tree}`
      );
      
      const { stdout: baseTree } = await execAsync(
        `git -C ${repoPath} rev-parse ${baseBranch}^{tree}`
      );
      
      return sessionTree.trim() === baseTree.trim();
      
    } catch (error) {
      log.warn("Could not check session changes in base", { error });
      return false;
    }
  }

  /**
   * Checks if switching to a new branch would result in losing uncommitted changes.
   */
  private async checkWouldLoseChanges(repoPath: string, targetBranch: string): Promise<boolean> {
    try {
      const { stdout: currentBranch } = await execAsync(`git -C ${repoPath} rev-parse --abbrev-ref HEAD`);
      const { stdout: uncommittedChanges } = await execAsync(`git -C ${repoPath} status --porcelain`);

      // If we are already on the target branch, no uncommitted changes to lose
      if (currentBranch.trim() === targetBranch) {
        return false;
      }

      // If there are uncommitted changes, we need to be careful
      if (uncommittedChanges.trim()) {
        return true;
      }

      // If we are on a different branch and have no uncommitted changes, it's safe
      return false;

    } catch (error) {
      log.warn("Could not check for uncommitted changes before branch switch", { error });
      return false; // Assume safe if check fails
    }
  }

  /**
   * Automatically resolves delete conflicts by accepting deletions
   */
  private async autoResolveDeleteConflicts(
    repoPath: string,
    conflictFiles: ConflictFile[]
  ): Promise<void> {
    try {
      const deleteConflicts = conflictFiles.filter(f => 
        f.deletionInfo?.canAutoResolve &&
        (f.status === FileConflictStatus.DELETED_BY_US || f.status === FileConflictStatus.DELETED_BY_THEM)
      );

      for (const file of deleteConflicts) {
        // Remove the file to accept the deletion
        await execAsync(`git -C ${repoPath} rm "${file.path}"`);
        log.debug("Auto-resolved delete conflict", { file: file.path });
      }

      if (deleteConflicts.length > 0) {
        // Commit the resolution
        await execAsync(`git -C ${repoPath} commit -m "resolve conflicts: accept file deletions"`);
        log.debug("Committed auto-resolved delete conflicts", { count: deleteConflicts.length });
      }

    } catch (error) {
      log.error("Error auto-resolving delete conflicts", { error });
      throw error;
    }
  }

  /**
   * Analyzes the overall conflict severity
   */
  private analyzeConflictSeverity(conflictFiles: ConflictFile[]): { 
    conflictType: ConflictType; 
    severity: ConflictSeverity; 
  } {
    if (conflictFiles.length === 0) {
      return { conflictType: ConflictType.NONE, severity: ConflictSeverity.NONE };
    }

    const hasContentConflicts = conflictFiles.some(f => f.status === FileConflictStatus.MODIFIED_BOTH);
    const hasDeleteConflicts = conflictFiles.some(f => 
      f.status === FileConflictStatus.DELETED_BY_US || f.status === FileConflictStatus.DELETED_BY_THEM
    );
    const hasRenameConflicts = conflictFiles.some(f => f.status === FileConflictStatus.RENAMED);
    
    let conflictType: ConflictType;
    let severity: ConflictSeverity;
    
    if (hasRenameConflicts) {
      conflictType = ConflictType.RENAME_CONFLICT;
      severity = ConflictSeverity.MANUAL_COMPLEX;
    } else if (hasContentConflicts && hasDeleteConflicts) {
      conflictType = ConflictType.CONTENT_CONFLICT;
      severity = ConflictSeverity.MANUAL_COMPLEX;
    } else if (hasDeleteConflicts) {
      conflictType = ConflictType.DELETE_MODIFY;
      // Check if all deletions are auto-resolvable
      const allAutoResolvable = conflictFiles
        .filter(f => f.deletionInfo)
        .every(f => f.deletionInfo?.canAutoResolve);
      severity = allAutoResolvable ? ConflictSeverity.AUTO_RESOLVABLE : ConflictSeverity.MANUAL_SIMPLE;
    } else if (hasContentConflicts) {
      conflictType = ConflictType.CONTENT_CONFLICT;
      // Analyze content conflict complexity
      const totalRegions = conflictFiles.reduce((sum, f) => sum + (f.conflictRegions?.length || 0), 0);
      severity = totalRegions <= 3 ? ConflictSeverity.MANUAL_SIMPLE : ConflictSeverity.MANUAL_COMPLEX;
    } else {
      conflictType = ConflictType.CONTENT_CONFLICT;
      severity = ConflictSeverity.MANUAL_SIMPLE;
    }
    
    return { conflictType, severity };
  }

  /**
   * Generates resolution strategies based on conflict analysis
   */
  private generateResolutionStrategies(
    conflictFiles: ConflictFile[], 
    conflictType: ConflictType
  ): ResolutionStrategy[] {
    const strategies: ResolutionStrategy[] = [];
    
    if (conflictType === ConflictType.DELETE_MODIFY) {
      const allAutoResolvable = conflictFiles
        .filter(f => f.deletionInfo)
        .every(f => f.deletionInfo?.canAutoResolve);
        
      if (allAutoResolvable) {
        strategies.push({
          type: "automatic",
          description: "Accept deletions (recommended for removed files)",
          commands: [
            ...conflictFiles
              .filter(f => f.deletionInfo)
              .map(f => `git rm ${f.path}`),
            "git commit -m \"resolve conflicts: accept file deletions\""
          ],
          riskLevel: "low"
        });
      }
    }
    
    // Always provide manual resolution option
    strategies.push({
      type: "manual",
      description: "Manually resolve conflicts by editing files",
      commands: [
        "git status",
        "# Edit conflicted files to resolve <<<<<<< ======= >>>>>>> markers",
        "git add .",
        "git commit -m \"resolve merge conflicts\""
      ],
      riskLevel: "medium"
    });
    
    return strategies;
  }

  /**
   * Generates user-friendly guidance based on conflict analysis
   */
  private generateUserGuidance(
    conflictType: ConflictType,
    severity: ConflictSeverity,
    conflictFiles: ConflictFile[]
  ): string {
    switch (conflictType) {
    case ConflictType.DELETE_MODIFY: {
      const deletedFiles = conflictFiles.filter(f => f.deletionInfo).map(f => f.path);
      return `
🗑️  Deleted file conflicts detected

Files deleted in main branch but modified in your session:
${deletedFiles.map(f => `  • ${f}`).join("\n")}

These conflicts are typically auto-resolvable by accepting the deletion.
The files were removed for a reason (likely part of refactoring or cleanup).

Recommended action: Accept the deletions and remove your changes to these files.
        `.trim();
    }
    case ConflictType.CONTENT_CONFLICT:
      return `
✏️  Content conflicts detected

${conflictFiles.length} file(s) have conflicting changes between your session and main branch.
These require manual resolution by editing the files and choosing which changes to keep.

Look for conflict markers:
  <<<<<<< HEAD (your changes)
  =======
  >>>>>>> main (main branch changes)
        `.trim();
        
    case ConflictType.ALREADY_MERGED:
      return `
✅ Changes already merged

Your session changes appear to already be present in the main branch.
You can skip the update step and proceed directly to PR creation.
        `.trim();
        
    default:
      return `
⚠️  Merge conflicts detected

${conflictFiles.length} file(s) have conflicts that need resolution.
Review the affected files and choose appropriate resolution strategy.
        `.trim();
    }
  }

  /**
   * Generates copy-pasteable recovery commands
   */
  private generateRecoveryCommands(
    conflictFiles: ConflictFile[],
    conflictType: ConflictType
  ): string[] {
    const commands: string[] = [];
    
    if (conflictType === ConflictType.DELETE_MODIFY) {
      commands.push("# Accept file deletions (recommended)");
      conflictFiles
        .filter(f => f.deletionInfo)
        .forEach(f => commands.push(`git rm "${f.path}"`));
      commands.push("git commit -m \"resolve conflicts: accept file deletions\"");
    } else {
      commands.push("# Check conflict status");
      commands.push("git status");
      commands.push("");
      commands.push("# Edit each conflicted file to resolve <<<<<<< ======= >>>>>>> markers");
      conflictFiles.forEach(f => commands.push(`# Edit: ${f.path}`));
      commands.push("");
      commands.push("# After editing, add resolved files");
      commands.push("git add .");
      commands.push("git commit -m \"resolve merge conflicts\"");
    }
    
    return commands;
  }

  /**
   * Determines the complexity of a rebase conflict based on the number of conflicts.
   */
  private determineRebaseComplexity(conflictFiles: ConflictFile[]): "simple" | "moderate" | "complex" {
    const totalRegions = conflictFiles.reduce((sum, f) => sum + (f.conflictRegions?.length || 0), 0);
    if (totalRegions === 0) {
      return "simple";
    } else if (totalRegions <= 5) {
      return "moderate";
    } else {
      return "complex";
    }
  }
} 
