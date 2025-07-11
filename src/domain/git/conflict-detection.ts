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
  CHERRY_PICK = "cherry-pick",
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
   * Static method to predict merge conflicts
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
   * Static method to analyze branch divergence
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
    return service.mergeWithConflictPrevention(
      repoPath,
      sourceBranch,
      targetBranch,
      options
    );
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
    return service.smartSessionUpdate(
      repoPath,
      sessionBranch,
      baseBranch,
      options
    );
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
    return service.previewGitOperation(
      repoPath,
      operation,
      sourceRef,
      targetRef
    );
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
   * NEW: Predict conflicts for a rebase operation
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
   * NEW: Generate advanced resolution strategies for common conflict patterns
   */
  static async generateAdvancedResolutionStrategies(
    repoPath: string,
    conflictFiles: ConflictFile[]
  ): Promise<AdvancedResolutionStrategy[]> {
    const service = new ConflictDetectionService();
    return service.generateAdvancedResolutionStrategies(repoPath, conflictFiles);
  }

  async predictMergeConflicts(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<ConflictPrediction> {
    log.debug("Predicting merge conflicts", {
      repoPath,
      sourceBranch,
      targetBranch,
    });

    try {
      // First, analyze branch divergence
      const divergence = await this.analyzeBranchDivergence(
        repoPath,
        sourceBranch,
        targetBranch
      );

      // If already merged, no conflicts
      if (divergence.sessionChangesInBase) {
        return {
          hasConflicts: false,
          conflictType: ConflictType.ALREADY_MERGED,
          severity: ConflictSeverity.NONE,
          affectedFiles: [],
          resolutionStrategies: [
            {
              type: "automatic",
              description: "Session changes already in base branch",
              commands: ["# No action needed - changes already merged"],
              riskLevel: "low",
            },
          ],
          userGuidance:
            "Your session changes have already been merged into the base branch. You can skip the update or create a PR without conflicts.",
          recoveryCommands: ["minsky session pr --no-update"],
        };
      }

      // Simulate merge to detect conflicts
      const conflictFiles = await this.simulateMerge(
        repoPath,
        sourceBranch,
        targetBranch
      );

      if (conflictFiles.length === 0) {
        return {
          hasConflicts: false,
          conflictType: ConflictType.NONE,
          severity: ConflictSeverity.NONE,
          affectedFiles: [],
          resolutionStrategies: [],
          userGuidance: "No conflicts detected. Safe to proceed with merge.",
          recoveryCommands: [],
        };
      }

      // Analyze conflict types and severity
      const { conflictType, severity } =
        this.analyzeConflictSeverity(conflictFiles);
      const resolutionStrategies = this.generateResolutionStrategies(
        conflictFiles,
        conflictType
      );
      const userGuidance = this.generateUserGuidance(
        conflictType,
        severity,
        conflictFiles
      );
      const recoveryCommands = this.generateRecoveryCommands(
        conflictFiles,
        conflictType
      );

      return {
        hasConflicts: true,
        conflictType,
        severity,
        affectedFiles: conflictFiles,
        resolutionStrategies,
        userGuidance,
        recoveryCommands,
      };
    } catch (error) {
      log.error("Error predicting merge conflicts", {
        error,
        repoPath,
        sourceBranch,
        targetBranch,
      });
      throw error;
    }
  }

  async analyzeBranchDivergence(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string
  ): Promise<BranchDivergenceAnalysis> {
    log.debug("Analyzing branch divergence", {
      repoPath,
      sessionBranch,
      baseBranch,
    });

    try {
      // Get commit counts
      const { stdout: aheadBehind } = await execAsync(
        `git -C ${repoPath} rev-list --left-right --count ${baseBranch}...${sessionBranch}`
      );
      const [behindStr, aheadStr] = aheadBehind.trim().split("\t");
      const behind = Number(behindStr) || 0;
      const ahead = Number(aheadStr) || 0;

      // Get last common commit
      const { stdout: commonCommit } = await execAsync(
        `git -C ${repoPath} merge-base ${baseBranch} ${sessionBranch}`
      );

      // Check if session changes are already in base
      const sessionChangesInBase = await this.checkSessionChangesInBase(
        repoPath,
        sessionBranch,
        baseBranch
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
        recommendedAction,
      };
    } catch (error) {
      log.error("Error analyzing branch divergence", {
        error,
        repoPath,
        sessionBranch,
        baseBranch,
      });
      throw error;
    }
  }

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
    log.debug("Enhanced merge with conflict prevention", {
      repoPath,
      sourceBranch,
      targetBranch,
      options,
    });

    try {
      let prediction: ConflictPrediction | undefined;

      // Step 1: Predict conflicts unless skipped
      if (!options?.skipConflictCheck) {
        prediction = await this.predictMergeConflicts(
          repoPath,
          sourceBranch,
          targetBranch
        );

        if (prediction.hasConflicts && options?.dryRun) {
          return {
            workdir: repoPath,
            merged: false,
            conflicts: true,
            conflictDetails: prediction.userGuidance,
            prediction,
          };
        }

        // Auto-resolve delete conflicts if requested
        if (
          prediction.hasConflicts &&
          prediction.conflictType === ConflictType.DELETE_MODIFY &&
          options?.autoResolveDeleteConflicts
        ) {
          await this.autoResolveDeleteConflicts(
            repoPath,
            prediction.affectedFiles
          );
        }
      }

      // Step 2: Perform actual merge if not dry run
      if (!options?.dryRun) {
        const { stdout: beforeHash } = await execAsync(
          `git -C ${repoPath} rev-parse HEAD`
        );

        try {
          await execAsync(`git -C ${repoPath} merge ${sourceBranch}`);

          const { stdout: afterHash } = await execAsync(
            `git -C ${repoPath} rev-parse HEAD`
          );
          const merged = beforeHash.trim() !== afterHash.trim();

          return {
            workdir: repoPath,
            merged,
            conflicts: false,
            prediction,
          };
        } catch (mergeError) {
          // Check for conflicts
          const { stdout: status } = await execAsync(
            `git -C ${repoPath} status --porcelain`
          );
          const hasConflicts =
            status.includes("UU") ||
            status.includes("AA") ||
            status.includes("DD");

          if (hasConflicts) {
            return {
              workdir: repoPath,
              merged: false,
              conflicts: true,
              conflictDetails:
                prediction?.userGuidance || "Merge conflicts detected",
              prediction,
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
        prediction,
      };
    } catch (error) {
      log.error("Error in enhanced merge", {
        error,
        repoPath,
        sourceBranch,
        targetBranch,
      });
      throw error;
    }
  }

  async smartSessionUpdate(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string,
    options?: {
      skipIfAlreadyMerged?: boolean;
      autoResolveConflicts?: boolean;
    }
  ): Promise<SmartUpdateResult> {
    log.debug("Smart session update", {
      repoPath,
      sessionBranch,
      baseBranch,
      options,
    });

    try {
      // Analyze branch divergence against origin/baseBranch (remote tracking branch)
      const remoteBranch = `origin/${baseBranch}`;
      const divergence = await this.analyzeBranchDivergence(
        repoPath,
        sessionBranch,
        remoteBranch
      );

      // Check if we should skip update
      if (options?.skipIfAlreadyMerged && divergence.sessionChangesInBase) {
        return {
          workdir: repoPath,
          updated: false,
          skipped: true,
          reason: "Session changes already in base branch",
          divergenceAnalysis: divergence,
        };
      }

      // If no update needed
      if (
        divergence.divergenceType === "none" ||
        divergence.divergenceType === "ahead"
      ) {
        return {
          workdir: repoPath,
          updated: false,
          skipped: true,
          reason: "No update needed - session is current or ahead",
          divergenceAnalysis: divergence,
        };
      }

      // Perform update based on divergence analysis
      if (divergence.recommendedAction === "fast_forward") {
        // Simple fast-forward - merge from the remote branch we analyzed against
        await execAsync(`git -C ${repoPath} fetch origin ${baseBranch}`);
        await execAsync(`git -C ${repoPath} merge --ff-only ${remoteBranch}`);

        return {
          workdir: repoPath,
          updated: true,
          skipped: false,
          reason: "Fast-forward update completed",
          divergenceAnalysis: divergence,
        };
      } else {
        // Complex merge needed - merge from the remote branch we analyzed against
        const mergeResult = await this.mergeWithConflictPrevention(
          repoPath,
          remoteBranch,
          sessionBranch,
          { autoResolveDeleteConflicts: options?.autoResolveConflicts }
        );

        return {
          workdir: repoPath,
          updated: mergeResult.merged,
          skipped: false,
          reason: mergeResult.conflicts
            ? "Update failed due to conflicts"
            : "Merge update completed",
          conflictDetails: mergeResult.conflictDetails,
          divergenceAnalysis: divergence,
        };
      }
    } catch (error) {
      log.error("Error in smart session update", {
        error,
        repoPath,
        sessionBranch,
        baseBranch,
      });
      throw error;
    }
  }

  // Stubs for new methods
  async previewGitOperation(
    repoPath: string,
    operation: GitOperationType,
    sourceRef: string,
    targetRef?: string
  ): Promise<GitOperationPreview> {
    // Placeholder implementation
    log.debug("Previewing git operation (not yet implemented)", {
      repoPath,
      operation,
      sourceRef,
      targetRef,
    });
    const prediction: ConflictPrediction = {
      hasConflicts: false,
      conflictType: ConflictType.NONE,
      severity: ConflictSeverity.NONE,
      affectedFiles: [],
      resolutionStrategies: [],
      userGuidance: "Preview not yet implemented.",
      recoveryCommands: [],
    };
    return {
      operation,
      repoPath,
      sourceRef,
      targetRef,
      prediction,
      safeToExecute: true,
      recommendedActions: [],
    };
  }

  async checkBranchSwitchConflicts(
    repoPath: string,
    targetBranch: string
  ): Promise<BranchSwitchWarning> {
    log.debug("Checking branch switch conflicts", { repoPath, targetBranch });

    try {
      const { stdout: currentBranch } = await execAsync(
        `git -C ${repoPath} rev-parse --abbrev-ref HEAD`
      );
      const fromBranch = currentBranch.trim();

      if (fromBranch === targetBranch) {
        return {
          fromBranch,
          toBranch: targetBranch,
          uncommittedChanges: [],
          conflictingFiles: [],
          wouldLoseChanges: false,
          recommendedAction: "force", // No action needed
        };
      }

      const { stdout: statusOutput } = await execAsync(`git -C ${repoPath} status --porcelain`);
      const uncommittedChanges = statusOutput.trim().split("\n").filter(Boolean);

      let conflictingFiles: string[] = [];
      let wouldLoseChanges = false;
      let recommendedAction: BranchSwitchWarning["recommendedAction"] = "force";

      if (uncommittedChanges.length > 0) {
        // If there are uncommitted changes, a simple checkout might fail or lose data.
        // We can simulate a merge to see if the uncommitted changes would conflict.
        try {
          // This is a simplified check. A true check is more complex.
          // We'll try to merge the target branch into a temporary index.
          await execAsync(
            `git -C ${repoPath} merge-tree $(git -C ${repoPath} write-tree) HEAD ${targetBranch}`
          );
        } catch (error) {
          wouldLoseChanges = true;
          const errorMessage = error instanceof Error ? error.message : String(error);
          conflictingFiles = this.parseMergeConflictOutput(errorMessage);
        }

        if (wouldLoseChanges) {
          recommendedAction = "stash";
        } else {
          recommendedAction = "commit";
        }
      }

      return {
        fromBranch,
        toBranch: targetBranch,
        uncommittedChanges: uncommittedChanges.map((line) => line.substring(3)),
        conflictingFiles,
        wouldLoseChanges,
        recommendedAction,
      };
    } catch (error) {
      log.error("Error checking branch switch conflicts", {
        error,
        repoPath,
        targetBranch,
      });
      throw error;
    }
  }

  async predictRebaseConflicts(
    repoPath: string,
    baseBranch: string,
    featureBranch: string
  ): Promise<RebaseConflictPrediction> {
    log.debug("Predicting rebase conflicts", {
      repoPath,
      baseBranch,
      featureBranch,
    });

    try {
      // Find the common ancestor commit
      const { stdout: mergeBase } = await execAsync(
        `git -C ${repoPath} merge-base ${baseBranch} ${featureBranch}`
      );
      const commonAncestor = mergeBase.trim();

      // Get commits in feature branch that are not in base branch
      const { stdout: commitsOutput } = await execAsync(
        `git -C ${repoPath} log --format="%H|%s|%an" ${commonAncestor}..${featureBranch}`
      );

      // Parse commit information
      const commitInfos = commitsOutput
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|");
          const sha = parts[0] || "";
          const message = parts[1] || "(no commit message)";
          const author = parts[2] || "(unknown)";
          return { sha, message, author };
        })
        .reverse(); // Order from oldest to newest for rebase simulation

      if (commitInfos.length === 0) {
        // No commits to rebase, so no conflicts
        return {
          baseBranch,
          featureBranch,
          conflictingCommits: [],
          overallComplexity: "simple",
          estimatedResolutionTime: "0 minutes",
          canAutoResolve: true,
          recommendations: ["No rebase needed, branches are already in sync."],
        };
      }

      // Create a temporary branch for simulation
      const tempBranch = `rebase-simulation-${Date.now()}`;
      const conflictingCommits: ConflictingCommit[] = [];
      
      try {
        // Create temp branch from base
        await execAsync(
          `git -C ${repoPath} checkout -b ${tempBranch} ${baseBranch}`
        );

        // Simulate cherry-picking each commit to detect conflicts
        for (const commit of commitInfos) {
          try {
            await execAsync(
              `git -C ${repoPath} cherry-pick --no-commit ${commit.sha}`
            );
            
            // No conflict for this commit, clean up and continue
            await execAsync(`git -C ${repoPath} reset --hard HEAD`);
          } catch (cherryPickError) {
            // Cherry-pick failed, analyze conflicts
            const conflictFiles = await this.analyzeConflictFiles(repoPath);
            
            // Determine complexity based on conflict files
            const complexity = this.determineCommitComplexity(conflictFiles);
            
            conflictingCommits.push({
              sha: commit.sha,
              message: commit.message,
              author: commit.author,
              conflictFiles: conflictFiles.map((f) => f.path),
              complexity,
            });

            // Abort the cherry-pick
            await execAsync(`git -C ${repoPath} cherry-pick --abort`);
          }
        }
      } finally {
        // Clean up temporary branch
        try {
          await execAsync(`git -C ${repoPath} checkout ${featureBranch}`);
          await execAsync(`git -C ${repoPath} branch -D ${tempBranch}`);
        } catch (cleanupError) {
          log.warn("Failed to clean up temporary branch", {
            tempBranch,
            cleanupError,
          });
        }
      }

      // Determine overall complexity and estimated resolution time
      const overallComplexity = this.determineOverallComplexity(conflictingCommits);
      const estimatedResolutionTime = this.estimateResolutionTime(conflictingCommits);
      const canAutoResolve = conflictingCommits.every(
        (commit) => commit.complexity === "simple"
      );

      // Generate recommendations
      const recommendations = this.generateRebaseRecommendations(
        conflictingCommits,
        overallComplexity,
        canAutoResolve
      );

      return {
        baseBranch,
        featureBranch,
        conflictingCommits,
        overallComplexity,
        estimatedResolutionTime,
        canAutoResolve,
        recommendations,
      };
    } catch (error) {
      log.error("Error predicting rebase conflicts", {
        error,
        repoPath,
        baseBranch,
        featureBranch,
      });
      throw error;
    }
  }

  async generateAdvancedResolutionStrategies(
    repoPath: string,
    conflictFiles: ConflictFile[]
  ): Promise<AdvancedResolutionStrategy[]> {
    log.debug("Generating advanced resolution strategies", {
      repoPath,
      conflictFiles,
    });

    try {
      const strategies: AdvancedResolutionStrategy[] = [];

      // No conflicts, no strategies needed
      if (conflictFiles.length === 0) {
        return strategies;
      }

      // Group files by type for specialized handling
      const packageJsonFiles = conflictFiles.filter((file) =>
        file.path.endsWith("package.json")
      );
      const lockFiles = conflictFiles.filter(
        (file) =>
          file.path.endsWith("package-lock.json") ||
          file.path.endsWith("yarn.lock") ||
          file.path.endsWith("bun.lock")
      );
      const configFiles = conflictFiles.filter(
        (file) =>
          file.path.endsWith(".json") ||
          file.path.endsWith(".yaml") ||
          file.path.endsWith(".yml") ||
          file.path.endsWith(".toml")
      );
      const documentationFiles = conflictFiles.filter(
        (file) =>
          file.path.endsWith(".md") ||
          file.path.endsWith(".txt") ||
          file.path.match(/README|CHANGELOG|LICENSE|CONTRIBUTING/)
      );
      const formattingOnlyConflicts = await this.identifyFormattingOnlyConflicts(
        repoPath,
        conflictFiles
      );

      // 1. Handle package.json conflicts
      if (packageJsonFiles.length > 0) {
        strategies.push(this.createPackageJsonStrategy(packageJsonFiles));
      }

      // 2. Handle lock file conflicts
      if (lockFiles.length > 0) {
        strategies.push(this.createLockFileStrategy(lockFiles));
      }

      // 3. Handle formatting-only conflicts
      if (formattingOnlyConflicts.length > 0) {
        strategies.push(
          this.createFormattingOnlyStrategy(formattingOnlyConflicts)
        );
      }

      // 4. Handle documentation conflicts
      if (documentationFiles.length > 0) {
        strategies.push(this.createDocumentationStrategy(documentationFiles));
      }

      // 5. Handle configuration files
      if (configFiles.length > 0) {
        strategies.push(this.createConfigFileStrategy(configFiles));
      }

      // 6. Add a general strategy for remaining files
      const handledPaths = new Set([
        ...packageJsonFiles,
        ...lockFiles,
        ...formattingOnlyConflicts,
        ...documentationFiles,
        ...configFiles,
      ].map((file) => file.path));

      const remainingFiles = conflictFiles.filter(
        (file) => !handledPaths.has(file.path)
      );

      if (remainingFiles.length > 0) {
        strategies.push(this.createGeneralStrategy(remainingFiles));
      }

      return strategies;
    } catch (error) {
      log.error("Error generating advanced resolution strategies", {
        error,
        repoPath,
        conflictFiles,
      });
      return [];
    }
  }

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
        await execAsync(
          `git -C ${repoPath} checkout -b ${tempBranch} ${targetBranch}`
        );

        // Attempt merge
        try {
          await execAsync(
            `git -C ${repoPath} merge --no-commit --no-ff ${sourceBranch}`
          );

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
          log.warn("Failed to clean up temporary branch", {
            tempBranch,
            cleanupError,
          });
        }
      }
    } catch (error) {
      log.error("Error simulating merge", {
        error,
        repoPath,
        sourceBranch,
        targetBranch,
      });
      throw error;
    }
  }

  private parseMergeConflictOutput(output: string): string[] {
    const files: string[] = [];
    const regex = /CONFLICT \((.+?)\): Merge conflict in (.+)/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      files.push(match[2]);
    }
    return files;
  }

  private async analyzeConflictFiles(repoPath: string): Promise<ConflictFile[]> {
    try {
      const { stdout: statusOutput } = await execAsync(
        `git -C ${repoPath} status --porcelain`
      );

      const conflictFiles: ConflictFile[] = [];
      const lines = statusOutput
        .trim()
        .split("\n")
        .filter((line) => line.trim());

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
          deletionInfo = await this.analyzeDeletion(
            repoPath,
            filePath,
            "them"
          );
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

        const conflictRegions =
          fileStatus === FileConflictStatus.MODIFIED_BOTH
            ? await this.analyzeConflictRegions(repoPath, filePath)
            : undefined;

        conflictFiles.push({
          path: filePath,
          status: fileStatus,
          conflictRegions,
          deletionInfo,
        });
      }

      return conflictFiles;
    } catch (error) {
      log.error("Error analyzing conflict files", { error, repoPath });
      throw error;
    }
  }

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
        canAutoResolve: true, // Deletions are generally auto-resolvable
      };
    } catch (error) {
      log.warn("Could not analyze deletion", { error, filePath });
      return {
        deletedInBranch: deletedBy === "us" ? "session" : "main",
        modifiedInBranch: deletedBy === "us" ? "main" : "session",
        lastCommitHash: "unknown",
        canAutoResolve: false,
      };
    }
  }

  private async analyzeConflictRegions(
    repoPath: string,
    filePath: string
  ): Promise<ConflictRegion[]> {
    try {
      const { stdout: fileContent } = await execAsync(
        `cat "${repoPath}/${filePath}"`
      );
      const lines = fileContent.split("\n");

      const regions: ConflictRegion[] = [];
      let inConflict = false;
      let startLine = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!line) continue;

        if (line.startsWith("<<<<<<<")) {
          inConflict = true;
          startLine = i + 1;
        } else if (line.startsWith(">>>>>>>") && inConflict) {
          regions.push({
            startLine,
            endLine: i + 1,
            type: "content",
            description: `Content conflict in lines ${startLine}-${i + 1}`,
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

  private async autoResolveDeleteConflicts(
    repoPath: string,
    conflictFiles: ConflictFile[]
  ): Promise<void> {
    try {
      const deleteConflicts = conflictFiles.filter(
        (f) =>
          f.deletionInfo?.canAutoResolve &&
          (f.status === FileConflictStatus.DELETED_BY_US ||
            f.status === FileConflictStatus.DELETED_BY_THEM)
      );

      for (const file of deleteConflicts) {
        // Remove the file to accept the deletion
        await execAsync(`git -C ${repoPath} rm "${file.path}"`);
        log.debug("Auto-resolved delete conflict", { file: file.path });
      }

      if (deleteConflicts.length > 0) {
        // Commit the resolution
        await execAsync(
          `git -C ${repoPath} commit -m "resolve conflicts: accept file deletions"`
        );
        log.debug("Committed auto-resolved delete conflicts", {
          count: deleteConflicts.length,
        });
      }
    } catch (error) {
      log.error("Error auto-resolving delete conflicts", { error });
      throw error;
    }
  }

  private analyzeConflictSeverity(conflictFiles: ConflictFile[]): {
    conflictType: ConflictType;
    severity: ConflictSeverity;
  } {
    if (conflictFiles.length === 0) {
      return {
        conflictType: ConflictType.NONE,
        severity: ConflictSeverity.NONE,
      };
    }

    const hasContentConflicts = conflictFiles.some(
      (f) => f.status === FileConflictStatus.MODIFIED_BOTH
    );
    const hasDeleteConflicts = conflictFiles.some(
      (f) =>
        f.status === FileConflictStatus.DELETED_BY_US ||
        f.status === FileConflictStatus.DELETED_BY_THEM
    );
    const hasRenameConflicts = conflictFiles.some(
      (f) => f.status === FileConflictStatus.RENAMED
    );

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
        .filter((f) => f.deletionInfo)
        .every((f) => f.deletionInfo?.canAutoResolve);
      severity = allAutoResolvable
        ? ConflictSeverity.AUTO_RESOLVABLE
        : ConflictSeverity.MANUAL_SIMPLE;
    } else if (hasContentConflicts) {
      conflictType = ConflictType.CONTENT_CONFLICT;
      // Analyze content conflict complexity
      const totalRegions = conflictFiles.reduce(
        (sum, f) => sum + (f.conflictRegions?.length || 0),
        0
      );
      severity =
        totalRegions <= 3
          ? ConflictSeverity.MANUAL_SIMPLE
          : ConflictSeverity.MANUAL_COMPLEX;
    } else {
      conflictType = ConflictType.CONTENT_CONFLICT;
      severity = ConflictSeverity.MANUAL_SIMPLE;
    }

    return { conflictType, severity };
  }

  private generateResolutionStrategies(
    conflictFiles: ConflictFile[],
    conflictType: ConflictType
  ): ResolutionStrategy[] {
    const strategies: ResolutionStrategy[] = [];

    if (conflictType === ConflictType.DELETE_MODIFY) {
      const allAutoResolvable = conflictFiles
        .filter((f) => f.deletionInfo)
        .every((f) => f.deletionInfo?.canAutoResolve);

      if (allAutoResolvable) {
        strategies.push({
          type: "automatic",
          description: "Accept deletions (recommended for removed files)",
          commands: [
            ...conflictFiles
              .filter((f) => f.deletionInfo)
              .map((f) => `git rm ${f.path}`),
            "git commit -m \"resolve conflicts: accept file deletions\"",
          ],
          riskLevel: "low",
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
        "git commit -m \"resolve merge conflicts\"",
      ],
      riskLevel: "medium",
    });

    return strategies;
  }

  private generateUserGuidance(
    conflictType: ConflictType,
    severity: ConflictSeverity,
    conflictFiles: ConflictFile[]
  ): string {
    switch (conflictType) {
    case ConflictType.DELETE_MODIFY: {
      const deletedFiles = conflictFiles
        .filter((f) => f.deletionInfo)
        .map((f) => f.path);
      return `
🗑️  Deleted file conflicts detected

Files deleted in main branch but modified in your session:
${deletedFiles.map((f) => `  • ${f}`).join("\n")}

These conflicts are typically auto-resolvable by accepting the deletion.
The files were removed for a reason (likely part of refactoring or cleanup).

Recommended action: Accept the deletions and remove your changes to these files.
        `.trim();
    }
    case ConflictType.CONTENT_CONFLICT:
      return `
✏️  Content conflicts detected

${
  conflictFiles.length
} file(s) have conflicting changes between your session and main branch.
These require manual resolution by editing the files and choosing which changes to keep.

📋 Next Steps:
1. Run: git status                    (see which files are conflicted)
2. Edit the conflicted files          (look for <<<<<<< markers)
3. Run: git add <file>               (mark conflicts as resolved)
4. Run: git commit                    (complete the merge)
5. Run: minsky session pr [options]   (retry PR creation)

🔧 Quick Check:
• Run 'git status' now to see the conflicted files
• Edit files and remove conflict markers
• Choose which changes to keep between <<<<<<< and >>>>>>>

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

  private generateRecoveryCommands(
    conflictFiles: ConflictFile[],
    conflictType: ConflictType
  ): string[] {
    const commands: string[] = [];

    if (conflictType === ConflictType.DELETE_MODIFY) {
      commands.push("# Accept file deletions (recommended)");
      conflictFiles
        .filter((f) => f.deletionInfo)
        .forEach((f) => commands.push(`git rm "${f.path}"`));
      commands.push(
        "git commit -m \"resolve conflicts: accept file deletions\""
      );
    } else {
      commands.push("# Check conflict status");
      commands.push("git status");
      commands.push("");
      commands.push(
        "# Edit each conflicted file to resolve <<<<<<< ======= >>>>>>> markers"
      );
      conflictFiles.forEach((f) => commands.push(`# Edit: ${f.path}`));
      commands.push("");
      commands.push("# After editing, add resolved files");
      commands.push("git add .");
      commands.push("git commit -m \"resolve merge conflicts\"");
    }

    return commands;
  }

  private determineCommitComplexity(
    conflictFiles: ConflictFile[]
  ): "simple" | "moderate" | "complex" {
    // Determine complexity based on number and types of conflicts
    if (conflictFiles.length === 0) {
      return "simple";
    }

    // Check for complex conflicts
    const hasComplexConflicts = conflictFiles.some(
      (file) =>
        file.status === FileConflictStatus.RENAMED ||
        (file.conflictRegions && file.conflictRegions.length > 5)
    );

    if (hasComplexConflicts) {
      return "complex";
    }

    // Check for moderate conflicts
    if (
      conflictFiles.length > 3 ||
      conflictFiles.some(
        (file) =>
          file.status === FileConflictStatus.DELETED_BY_US ||
          file.status === FileConflictStatus.DELETED_BY_THEM
      )
    ) {
      return "moderate";
    }

    return "simple";
  }

  private determineOverallComplexity(
    conflictingCommits: ConflictingCommit[]
  ): "simple" | "moderate" | "complex" {
    if (conflictingCommits.length === 0) {
      return "simple";
    }

    if (conflictingCommits.some((commit) => commit.complexity === "complex")) {
      return "complex";
    }

    if (
      conflictingCommits.some((commit) => commit.complexity === "moderate") ||
      conflictingCommits.length > 3
    ) {
      return "moderate";
    }

    return "simple";
  }

  private estimateResolutionTime(
    conflictingCommits: ConflictingCommit[]
  ): string {
    if (conflictingCommits.length === 0) {
      return "0 minutes";
    }

    // Rough estimate: 5 mins for simple, 15 for moderate, 30 for complex
    const timeEstimates = {
      simple: 5,
      moderate: 15,
      complex: 30,
    };

    const totalMinutes = conflictingCommits.reduce(
      (total, commit) => total + timeEstimates[commit.complexity],
      0
    );

    if (totalMinutes < 60) {
      return `${totalMinutes} minutes`;
    }

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours} hour${hours > 1 ? "s" : ""}${
      minutes > 0 ? ` ${minutes} minutes` : ""
    }`;
  }

  private generateRebaseRecommendations(
    conflictingCommits: ConflictingCommit[],
    overallComplexity: "simple" | "moderate" | "complex",
    canAutoResolve: boolean
  ): string[] {
    if (conflictingCommits.length === 0) {
      return ["Rebase should complete without conflicts."];
    }

    const recommendations: string[] = [
      `${conflictingCommits.length} commit(s) may cause conflicts during rebase.`,
    ];

    if (canAutoResolve) {
      recommendations.push(
        "All conflicts appear simple and might be auto-resolvable."
      );
    } else if (overallComplexity === "complex") {
      recommendations.push(
        "Consider using interactive rebase (`git rebase -i`) to handle complex conflicts one by one.",
        "You may want to squash related commits before rebasing to reduce conflict points."
      );
    } else {
      recommendations.push(
        "Use `git rebase --continue` after resolving each conflict.",
        "Consider stashing any uncommitted changes before rebasing."
      );
    }

    // Add specific recommendations for problematic commits
    const complexCommits = conflictingCommits.filter(
      (c) => c.complexity === "complex"
    );
    if (complexCommits.length > 0) {
      const commitShas = complexCommits
        .map((c) => c.sha.substring(0, 8))
        .join(", ");
      recommendations.push(
        `Pay special attention to complex commits: ${commitShas}`
      );
    }

    return recommendations;
  }

  private async identifyFormattingOnlyConflicts(
    repoPath: string,
    conflictFiles: ConflictFile[]
  ): Promise<ConflictFile[]> {
    const formattingOnlyFiles: ConflictFile[] = [];

    for (const file of conflictFiles) {
      // Skip files that aren't content conflicts
      if (file.status !== FileConflictStatus.MODIFIED_BOTH) {
        continue;
      }

      try {
        // Get the conflict markers content
        const { stdout: fileContent } = await execAsync(
          `git -C ${repoPath} show :1:${file.path} | tr -d '\\r\\n\\t '`
        );
        const { stdout: ourContent } = await execAsync(
          `git -C ${repoPath} show :2:${file.path} | tr -d '\\r\\n\\t '`
        );
        const { stdout: theirContent } = await execAsync(
          `git -C ${repoPath} show :3:${file.path} | tr -d '\\r\\n\\t '`
        );

        // If the content is the same when whitespace is removed, it's a formatting-only conflict
        if (
          ourContent.trim() === theirContent.trim() &&
          ourContent.trim() !== fileContent.trim()
        ) {
          formattingOnlyFiles.push(file);
        }
      } catch (error) {
        // Skip this file if we can't analyze it
        log.warn("Could not analyze file for formatting-only conflicts", {
          file: file.path,
          error,
        });
      }
    }

    return formattingOnlyFiles;
  }

  private createPackageJsonStrategy(
    files: ConflictFile[]
  ): AdvancedResolutionStrategy {
    return {
      type: "pattern_based",
      confidence: 0.85,
      description:
        "Intelligently merge package.json dependencies by combining both sets of changes",
      commands: [
        "# For each package.json file:",
        ...files.map(
          (file) => `
# 1. Extract dependencies from both versions
git checkout --theirs ${file.path}
cp ${file.path} ${file.path}.theirs
git checkout --ours ${file.path}
cp ${file.path} ${file.path}.ours

# 2. Use jq to merge dependencies
jq -s '.[0].dependencies * .[1].dependencies | {dependencies: .}' ${file.path}.ours ${file.path}.theirs > ${file.path}.deps
jq -s '.[0].devDependencies * .[1].devDependencies | {devDependencies: .}' ${file.path}.ours ${file.path}.theirs > ${file.path}.devdeps

# 3. Merge the dependencies back into the main file
jq -s '.[0] * .[1] * .[2]' ${file.path} ${file.path}.deps ${file.path}.devdeps > ${file.path}.merged
mv ${file.path}.merged ${file.path}

# 4. Clean up temporary files
rm ${file.path}.{ours,theirs,deps,devdeps}

# 5. Add the resolved file
git add ${file.path}`
        ),
        "# After resolving all files:",
        "git commit -m \"Resolve package.json conflicts with intelligent dependency merge\"",
      ],
      riskLevel: "medium",
      applicableFileTypes: ["package.json"],
    };
  }

  private createLockFileStrategy(
    files: ConflictFile[]
  ): AdvancedResolutionStrategy {
    return {
      type: "pattern_based",
      confidence: 0.9,
      description:
        "Resolve lock file conflicts by regenerating from the merged package.json",
      commands: [
        "# First, ensure package.json is resolved correctly",
        "# Then regenerate lock files:",
        ...files.map((file) => `git checkout --ours ${file.path}`),
        "# Remove all lock files",
        ...files.map((file) => `rm ${file.path}`),
        "# Regenerate lock files based on your package manager:",
        "# For npm:",
        "npm install",
        "# For yarn:",
        "# yarn",
        "# For bun:",
        "# bun install",
        "# Add the regenerated lock files:",
        ...files.map((file) => `git add ${file.path}`),
        "git commit -m \"Resolve lock file conflicts by regenerating lock files\"",
      ],
      riskLevel: "low",
      applicableFileTypes: ["package-lock.json", "yarn.lock", "bun.lock"],
    };
  }

  private createFormattingOnlyStrategy(
    files: ConflictFile[]
  ): AdvancedResolutionStrategy {
    return {
      type: "intelligent",
      confidence: 0.95,
      description:
        "Auto-resolve formatting-only conflicts by keeping our version and reformatting",
      commands: [
        "# For formatting-only conflicts, keep our version:",
        ...files.map((file) => `git checkout --ours ${file.path}`),
        "# Run formatter on the files:",
        "# For TypeScript/JavaScript:",
        ...files
          .filter(
            (file) =>
              file.path.endsWith(".ts") ||
              file.path.endsWith(".js") ||
              file.path.endsWith(".tsx") ||
              file.path.endsWith(".jsx")
          )
          .map((file) => `npx prettier --write ${file.path}`),
        "# Add the resolved files:",
        ...files.map((file) => `git add ${file.path}`),
        "git commit -m \"Resolve formatting-only conflicts\"",
      ],
      riskLevel: "low",
      applicableFileTypes: [
        "*.ts",
        "*.js",
        "*.tsx",
        "*.jsx",
        "*.css",
        "*.scss",
        "*.html",
      ],
    };
  }

  private createDocumentationStrategy(
    files: ConflictFile[]
  ): AdvancedResolutionStrategy {
    return {
      type: "pattern_based",
      confidence: 0.8,
      description:
        "Resolve documentation conflicts by combining both versions with clear separation",
      commands: [
        "# For each documentation file:",
        ...files.map(
          (file) => `
# 1. Extract both versions
git checkout --theirs ${file.path}
cp ${file.path} ${file.path}.theirs
git checkout --ours ${file.path}

# 2. Combine the files with clear separation
echo "\\n\\n<!-- Combined from both versions during merge resolution -->\\n\\n" >> ${file.path}
cat ${file.path}.theirs >> ${file.path}

# 3. Clean up
rm ${file.path}.theirs

# 4. Add the resolved file
git add ${file.path}`
        ),
        "git commit -m \"Resolve documentation conflicts by combining content\"",
      ],
      riskLevel: "low",
      applicableFileTypes: ["*.md", "README*", "CHANGELOG*", "*.txt"],
    };
  }

  private createConfigFileStrategy(
    files: ConflictFile[]
  ): AdvancedResolutionStrategy {
    return {
      type: "pattern_based",
      confidence: 0.75,
      description:
        "Resolve config file conflicts by merging JSON/YAML structures",
      commands: [
        "# For each config file:",
        ...files.map(
          (file) => `
# 1. Extract both versions
git checkout --theirs ${file.path}
cp ${file.path} ${file.path}.theirs
git checkout --ours ${file.path}
cp ${file.path} ${file.path}.ours

# 2. For JSON files, use jq to merge
if [[ "${file.path}" == *.json ]]; then
  jq -s '.[0] * .[1]' ${file.path}.ours ${file.path}.theirs > ${file.path}
fi

# 3. For YAML files, consider manual merge or specialized tools
if [[ "${file.path}" == *.yml || "${file.path}" == *.yaml ]]; then
  # This is a placeholder - manual merge may be needed
  echo "# CONFLICT: Manual merge needed for YAML" > ${file.path}.merged
  echo "# OUR VERSION:" >> ${file.path}.merged
  cat ${file.path}.ours >> ${file.path}.merged
  echo "\\n# THEIR VERSION:" >> ${file.path}.merged
  cat ${file.path}.theirs >> ${file.path}.merged
  mv ${file.path}.merged ${file.path}
fi

# 4. Clean up
rm ${file.path}.ours ${file.path}.theirs

# 5. Add the resolved file
git add ${file.path}`
        ),
        "git commit -m \"Resolve configuration file conflicts\"",
      ],
      riskLevel: "medium",
      applicableFileTypes: ["*.json", "*.yaml", "*.yml", "*.toml"],
    };
  }

  private createGeneralStrategy(
    files: ConflictFile[]
  ): AdvancedResolutionStrategy {
    return {
      type: "user_preference",
      confidence: 0.6,
      description:
        "General conflict resolution strategy with clear conflict markers",
      commands: [
        "# For each conflicted file:",
        ...files.map(
          (file) => `
# Open ${file.path} in your editor and resolve conflicts
# Look for <<<<<<< HEAD, =======, and >>>>>>> markers
# After resolving conflicts:
git add ${file.path}`
        ),
        "# After resolving all files:",
        "git commit -m \"Resolve remaining conflicts\"",
      ],
      riskLevel: "medium",
      applicableFileTypes: ["*"],
    };
  }
}
