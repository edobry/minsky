/**
 * Conflict Detection Service
 *
 * Thin orchestrator that delegates to focused sub-modules for conflict detection,
 * analysis, resolution strategies, merge simulation, and rebase prediction.
 */
import { injectable } from "tsyringe";
import { execAsync as defaultExecAsync } from "../../utils/exec";
import { log as defaultLog } from "../../utils/logger";
import { gitFetchWithTimeout as defaultGitFetchWithTimeout } from "../../utils/git-exec";
import { predictRebaseConflictsImpl } from "./rebase-conflict-prediction";
import { generateAdvancedResolutionStrategiesImpl } from "./advanced-resolution-strategies";
import { simulateMergeImpl } from "./merge-simulation";
import {
  analyzeConflictSeverity,
  autoResolveDeleteConflicts,
  generateRecoveryCommands,
} from "./conflict-analysis-operations";
import {
  generateResolutionStrategies,
  generateUserGuidance,
} from "./conflict-resolution-strategies";
import {
  analyzeBranchDivergenceImpl,
  checkBranchSwitchConflictsImpl,
} from "./branch-analysis-operations";
import {
  ConflictPrediction,
  ConflictFile,
  BranchSwitchWarning,
  RebaseConflictPrediction,
  AdvancedResolutionStrategy,
  BranchDivergenceAnalysis,
  EnhancedMergeResult,
  SmartUpdateResult,
  ConflictType,
  ConflictSeverity,
} from "./conflict-detection-types";

/**
 * Dependencies for ConflictDetectionService, injectable for testing
 */
export interface ConflictDetectionDeps {
  execAsync: typeof defaultExecAsync;
  gitFetchWithTimeout: typeof defaultGitFetchWithTimeout;
  log: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

const defaultConflictDetectionDeps: ConflictDetectionDeps = {
  execAsync: defaultExecAsync,
  gitFetchWithTimeout: defaultGitFetchWithTimeout,
  log: defaultLog,
};

// Re-export key types for external use
export { FileConflictStatus, ConflictSeverity, ConflictType } from "./conflict-detection-types";
export type {
  ConflictPrediction,
  BranchDivergenceAnalysis,
  EnhancedMergeResult,
  SmartUpdateResult,
  AdvancedResolutionStrategy,
  ConflictFile,
  RebaseConflictPrediction,
  ConflictingCommit,
} from "./conflict-detection-types";

@injectable()
export class ConflictDetectionService {
  private readonly deps: ConflictDetectionDeps;

  constructor(deps: ConflictDetectionDeps = defaultConflictDetectionDeps) {
    this.deps = deps;
  }

  /**
   * Static method to predict merge conflicts
   */
  static async predictConflicts(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string,
    deps?: ConflictDetectionDeps
  ): Promise<ConflictPrediction> {
    const service = new ConflictDetectionService(deps);
    return service.predictMergeConflicts(repoPath, sourceBranch, targetBranch);
  }

  /**
   * Static method to analyze branch divergence
   */
  static async analyzeBranchDivergence(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string,
    deps?: ConflictDetectionDeps
  ): Promise<BranchDivergenceAnalysis> {
    const service = new ConflictDetectionService(deps);
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
    },
    deps?: ConflictDetectionDeps
  ): Promise<SmartUpdateResult> {
    const service = new ConflictDetectionService(deps);
    return service.smartSessionUpdate(repoPath, sessionBranch, baseBranch, options);
  }

  /**
   * Check for branch switching conflicts and uncommitted changes
   */
  static async checkBranchSwitchConflicts(
    repoPath: string,
    targetBranch: string
  ): Promise<BranchSwitchWarning> {
    const service = new ConflictDetectionService();
    return service.checkBranchSwitchConflicts(repoPath, targetBranch);
  }

  /**
   * Predict conflicts for a rebase operation
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
   * Generate advanced resolution strategies for common conflict patterns
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
    this.deps.log.debug("Predicting merge conflicts", {
      repoPath,
      sourceBranch,
      targetBranch,
    });

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
          resolutionStrategies: [
            {
              type: "automatic",
              description: "Session changes already in base branch",
              commands: ["# No action needed - changes already merged"],
              riskLevel: "low",
            },
          ],
          userGuidance:
            "Your session changes have already been merged into the base branch. " +
            "You can skip the update or create a PR without conflicts.",
          recoveryCommands: ["minsky session pr --no-update"],
        };
      }

      // Simulate merge to detect conflicts
      const conflictFiles = await simulateMergeImpl(repoPath, sourceBranch, targetBranch);

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
      const { conflictType, severity } = analyzeConflictSeverity(conflictFiles);
      const resolutionStrategies = generateResolutionStrategies(conflictFiles, conflictType);
      const userGuidance = generateUserGuidance(conflictType, severity, conflictFiles);
      const recoveryCommands = generateRecoveryCommands(conflictFiles, conflictType);

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
      this.deps.log.error("Error predicting merge conflicts", {
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
    return analyzeBranchDivergenceImpl(repoPath, sessionBranch, baseBranch, this.deps);
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
    this.deps.log.debug("Enhanced merge with conflict prevention", {
      repoPath,
      sourceBranch,
      targetBranch,
      options,
    });

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
            prediction,
          };
        }

        // Auto-resolve delete conflicts if requested
        if (
          prediction.hasConflicts &&
          prediction.conflictType === ConflictType.DELETE_MODIFY &&
          options?.autoResolveDeleteConflicts
        ) {
          await autoResolveDeleteConflicts(repoPath, prediction.affectedFiles);
        }
      }

      // Step 2: Perform actual merge if not dry run
      if (!options?.dryRun) {
        const beforeHashResult = await this.deps.execAsync(`git -C ${repoPath} rev-parse HEAD`);
        const beforeHash = beforeHashResult?.stdout?.toString().trim() || "";

        try {
          await this.deps.execAsync(`git -C ${repoPath} merge ${sourceBranch}`);

          const afterHashResult = await this.deps.execAsync(`git -C ${repoPath} rev-parse HEAD`);
          const afterHash = afterHashResult?.stdout?.toString().trim() || "";
          const merged = beforeHash.toString().trim() !== afterHash.toString().trim();

          return {
            workdir: repoPath,
            merged,
            conflicts: false,
            prediction,
          };
        } catch (mergeError) {
          // Check for conflicts
          const statusResult = await this.deps.execAsync(`git -C ${repoPath} status --porcelain`);
          const status = String(statusResult?.stdout || "");
          const hasConflicts =
            status.includes("UU") || status.includes("AA") || status.includes("DD");

          if (hasConflicts) {
            // Leave the merge in progress so conflict markers remain in the
            // working tree. Agents can resolve them via session_edit_file /
            // session_search_replace and then commit.
            // Do NOT call git merge --abort here.

            // Collect the list of conflicted file paths from git status output
            const conflictedFiles = status
              .split("\n")
              .filter((line) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(line))
              .map((line) => line.slice(3).trim())
              .filter(Boolean);

            return {
              workdir: repoPath,
              merged: false,
              conflicts: true,
              conflictDetails: prediction?.userGuidance || "Merge conflicts detected",
              prediction,
              conflictedFiles,
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
      this.deps.log.error("Error in enhanced merge", {
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
    this.deps.log.debug("Smart session update", {
      repoPath,
      sessionBranch,
      baseBranch,
      options,
    });

    try {
      // Fetch the base branch first so the local tracking ref is current before
      // we analyze divergence. Without this, smartSessionUpdate silently no-ops
      // when origin/baseBranch is stale — the divergence analysis reads the
      // old ref, concludes "no update needed", and exits without merging. (mt#990)
      await this.deps.gitFetchWithTimeout("origin", baseBranch, { workdir: repoPath });

      // Analyze branch divergence against origin/baseBranch (remote tracking branch)
      const remoteBranch = `origin/${baseBranch}`;
      const divergence = await this.analyzeBranchDivergence(repoPath, sessionBranch, remoteBranch);

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
      if (divergence.divergenceType === "none" || divergence.divergenceType === "ahead") {
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
        // Base branch already fetched above; just fast-forward merge.
        await this.deps.execAsync(`git -C ${repoPath} merge --ff-only ${remoteBranch}`);

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
          conflictedFiles: mergeResult.conflictedFiles,
        };
      }
    } catch (error) {
      this.deps.log.error("Error in smart session update", {
        error,
        repoPath,
        sessionBranch,
        baseBranch,
      });
      throw error;
    }
  }

  async checkBranchSwitchConflicts(
    repoPath: string,
    targetBranch: string
  ): Promise<BranchSwitchWarning> {
    return checkBranchSwitchConflictsImpl(repoPath, targetBranch, this.deps);
  }

  async predictRebaseConflicts(
    repoPath: string,
    baseBranch: string,
    featureBranch: string
  ): Promise<RebaseConflictPrediction> {
    return predictRebaseConflictsImpl(repoPath, baseBranch, featureBranch);
  }

  async generateAdvancedResolutionStrategies(
    repoPath: string,
    conflictFiles: ConflictFile[]
  ): Promise<AdvancedResolutionStrategy[]> {
    return generateAdvancedResolutionStrategiesImpl(repoPath, conflictFiles);
  }
}
