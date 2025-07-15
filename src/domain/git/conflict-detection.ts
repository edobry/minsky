/**
 * Conflict Detection Service
 *
 * Provides comprehensive conflict detection and analysis for all git operations,
 * helping prevent merge conflicts before they occur across the entire git workflow.
 */
import { execAsync } from "../../utils/exec";
import { log } from "../../utils/logger";
import { predictRebaseConflictsImpl } from "./rebase-conflict-prediction";
import { generateAdvancedResolutionStrategiesImpl } from "./advanced-resolution-strategies";
import { simulateMergeImpl } from "./merge-simulation";
import {
  analyzeConflictFiles,
  analyzeDeletion,
  analyzeConflictRegions,
  analyzeConflictSeverity,
} from "./conflict-analysis-operations";
import {
  generateResolutionStrategies,
  generateUserGuidance,
} from "./conflict-resolution-strategies";
import {
  ConflictPrediction,
  ConflictFile,
  ConflictRegion,
  DeletionInfo,
  GitOperationPreview,
  BranchSwitchWarning,
  RebaseConflictPrediction,
  ConflictingCommit,
  StashStrategy,
  AdvancedResolutionStrategy,
  ResolutionStrategy,
  BranchDivergenceAnalysis,
  EnhancedMergeResult,
  SmartUpdateResult,
  GitOperationType,
  ConflictType,
  ConflictSeverity,
  FileConflictStatus,
} from "./conflict-detection-types";

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
    return predictRebaseConflictsImpl(repoPath, baseBranch, featureBranch, {
      execAsync,
      analyzeConflictFiles: this.analyzeConflictFiles.bind(this),
      determineCommitComplexity: this.determineCommitComplexity.bind(this),
      determineOverallComplexity: this.determineOverallComplexity.bind(this),
      estimateResolutionTime: this.estimateResolutionTime.bind(this),
      generateRebaseRecommendations: this.generateRebaseRecommendations.bind(this),
    });
  }

  async generateAdvancedResolutionStrategies(
    repoPath: string,
    conflictFiles: ConflictFile[]
  ): Promise<AdvancedResolutionStrategy[]> {
    return generateAdvancedResolutionStrategiesImpl(repoPath, conflictFiles, {
      identifyFormattingOnlyConflicts: this.identifyFormattingOnlyConflicts.bind(this),
      createPackageJsonStrategy: this.createPackageJsonStrategy.bind(this),
      createLockFileStrategy: this.createLockFileStrategy.bind(this),
      createFormattingOnlyStrategy: this.createFormattingOnlyStrategy.bind(this),
      createDocumentationStrategy: this.createDocumentationStrategy.bind(this),
      createConfigFileStrategy: this.createConfigFileStrategy.bind(this),
      createGeneralStrategy: this.createGeneralStrategy.bind(this),
    });
  }

  private async simulateMerge(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<ConflictFile[]> {
    return simulateMergeImpl(repoPath, sourceBranch, targetBranch, {
      execAsync,
      analyzeConflictFiles: this.analyzeConflictFiles.bind(this),
    });
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
    return analyzeConflictFiles(repoPath);
  }

  private async analyzeDeletion(
    repoPath: string,
    filePath: string,
    deletedBy: "us" | "them"
  ): Promise<DeletionInfo> {
    return analyzeDeletion(repoPath, filePath, deletedBy);
  }

  private async analyzeConflictRegions(
    repoPath: string,
    filePath: string
  ): Promise<ConflictRegion[]> {
    return analyzeConflictRegions(repoPath, filePath);
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
    return analyzeConflictSeverity(conflictFiles);
  }

  private generateResolutionStrategies(
    conflictFiles: ConflictFile[],
    conflictType: ConflictType
  ): ResolutionStrategy[] {
    return generateResolutionStrategies(conflictFiles, conflictType);
  }

  private generateUserGuidance(
    conflictType: ConflictType,
    severity: ConflictSeverity,
    conflictFiles: ConflictFile[]
  ): string {
    return generateUserGuidance(conflictType, severity, conflictFiles);
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
