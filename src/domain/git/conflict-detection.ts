/**
 * Conflict Detection Service
 *
 * Provides proactive conflict detection and analysis for git operations,
 * helping prevent merge conflicts before they occur during session PR creation.
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

export enum ConflictType {
  NONE = "none",
  CONTENT_CONFLICT = "content_conflict",
  DELETE_MODIFY = "delete_modify",
  RENAME_CONFLICT = "rename_conflict",
  MODE_CONFLICT = "mode_conflict",
  ALREADY_MERGED = "already_merged",
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
   * Predicts conflicts between two branches without performing actual merge
   */
  static async predictConflicts(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<ConflictPrediction> {
    const service = new ConflictDetectionService();
    return (service as any).predictMergeConflicts(repoPath, sourceBranch, targetBranch);
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
    return (service as any).analyzeBranchDivergence(repoPath, sessionBranch, baseBranch);
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
    return (service as any).mergeWithConflictPrevention(repoPath, sourceBranch, targetBranch, options as any);
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
    return (service as any).smartSessionUpdate(repoPath, sessionBranch, baseBranch, options as any);
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
      if ((divergence as any).sessionChangesInBase) {
        return {
          hasConflicts: false,
          conflictType: (ConflictType as any).ALREADY_MERGED,
          severity: (ConflictSeverity as any).NONE,
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
      const conflictFiles = await this.simulateMerge(repoPath, sourceBranch, targetBranch);

      if ((conflictFiles as any).length === 0) {
        return {
          hasConflicts: false,
          conflictType: (ConflictType as any).NONE,
          severity: (ConflictSeverity as any).NONE,
          affectedFiles: [],
          resolutionStrategies: [],
          userGuidance: "No conflicts detected. Safe to proceed with merge.",
          recoveryCommands: [],
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
      const [behindStr, aheadStr] = ((aheadBehind as any).trim() as any).split("\t");
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
        lastCommonCommit: (commonCommit as any).trim(),
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
    log.debug("Enhanced merge with conflict prevention", {
      repoPath,
      sourceBranch,
      targetBranch,
      options,
    });

    try {
      let prediction: ConflictPrediction | undefined;

      // Step 1: Predict conflicts unless skipped
      if (!(options as any).skipConflictCheck) {
        prediction = await this.predictMergeConflicts(repoPath, sourceBranch, targetBranch);

        if ((prediction as any).hasConflicts && (options as any).dryRun) {
          return {
            workdir: repoPath,
            merged: false,
            conflicts: true,
            conflictDetails: (prediction as any).userGuidance,
            prediction,
          };
        }

        // Auto-resolve delete conflicts if requested
        if (
          (prediction as any).hasConflicts &&
          (prediction as any).conflictType === (ConflictType as any).DELETE_MODIFY &&
          (options as any).autoResolveDeleteConflicts
        ) {
          await this.autoResolveDeleteConflicts(repoPath, (prediction as any).affectedFiles);
        }
      }

      // Step 2: Perform actual merge if not dry run
      if (!(options as any).dryRun) {
        const { stdout: beforeHash } = await execAsync(`git -C ${repoPath} rev-parse HEAD`);

        try {
          await execAsync(`git -C ${repoPath} merge ${sourceBranch}`);

          const { stdout: afterHash } = await execAsync(`git -C ${repoPath} rev-parse HEAD`);
          const merged = (beforeHash as any).trim() !== (afterHash as any).trim();

          return {
            workdir: repoPath,
            merged,
            conflicts: false,
            prediction,
          };
        } catch (mergeError) {
          // Check for conflicts
          const { stdout: status } = await execAsync(`git -C ${repoPath} status --porcelain`);
          const hasConflicts =
            (status as any).includes("UU") || (status as any).includes("AA") || (status as any).includes("DD");

          if (hasConflicts) {
            return {
              workdir: repoPath,
              merged: false,
              conflicts: true,
              conflictDetails: (prediction as any).userGuidance || "Merge conflicts detected",
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
        conflicts: (prediction as any).hasConflicts || false,
        conflictDetails: (prediction as any).userGuidance,
        prediction,
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
      // Analyze branch divergence against origin/baseBranch (remote tracking branch)
      const remoteBranch = `origin/${baseBranch}`;
      const divergence = await this.analyzeBranchDivergence(repoPath, sessionBranch, remoteBranch);

      // Check if we should skip update
      if ((options as any).skipIfAlreadyMerged && (divergence as any).sessionChangesInBase) {
        return {
          workdir: repoPath,
          updated: false,
          skipped: true,
          reason: "Session changes already in base branch",
          divergenceAnalysis: divergence,
        };
      }

      // If no update needed
      if ((divergence as any).divergenceType === "none" || (divergence as any).divergenceType === "ahead") {
        return {
          workdir: repoPath,
          updated: false,
          skipped: true,
          reason: "No update needed - session is current or ahead",
          divergenceAnalysis: divergence,
        };
      }

      // Perform update based on divergence analysis
      if ((divergence as any).recommendedAction === "fast_forward") {
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
          { autoResolveDeleteConflicts: (options as any).autoResolveConflicts }
        );

        return {
          workdir: repoPath,
          updated: (mergeResult as any).merged,
          skipped: false,
          reason: (mergeResult as any).conflicts
            ? "Update failed due to conflicts"
            : "Merge update completed",
          conflictDetails: (mergeResult as any).conflictDetails,
          divergenceAnalysis: divergence,
        };
      }
    } catch (error) {
      log.error("Error in smart session update", { error, repoPath, sessionBranch, baseBranch });
      throw error;
    }
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
      const tempBranch = `conflict-simulation-${(Date as any).now()}`;

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
      const lines = ((statusOutput as any).trim() as any).split("\n")
        .filter((line) => (line as any).trim());

      for (const line of lines) {
        const status = (line as any).substring(0, 2);
        const filePath = (line as any).substring(3);

        let fileStatus: FileConflictStatus;
        let deletionInfo: DeletionInfo | undefined;

        switch (status) {
        case "UU":
          fileStatus = (FileConflictStatus as any).MODIFIED_BOTH;
          break;
        case "DU":
          fileStatus = (FileConflictStatus as any).DELETED_BY_US;
          deletionInfo = await this.analyzeDeletion(repoPath, filePath, "us");
          break;
        case "UD":
          fileStatus = (FileConflictStatus as any).DELETED_BY_THEM;
          deletionInfo = await this.analyzeDeletion(repoPath, filePath, "them");
          break;
        case "AU":
          fileStatus = (FileConflictStatus as any).ADDED_BY_US;
          break;
        case "UA":
          fileStatus = (FileConflictStatus as any).ADDED_BY_THEM;
          break;
        default:
          continue; // Skip non-conflict files
        }

        const conflictRegions =
          fileStatus === (FileConflictStatus as any).MODIFIED_BOTH
            ? await this.analyzeConflictRegions(repoPath, filePath)
            : undefined;

        (conflictFiles as any).push({
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
        lastCommitHash: (lastCommit as any).trim(),
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

  /**
   * Analyzes conflict regions within a file
   */
  private async analyzeConflictRegions(
    repoPath: string,
    filePath: string
  ): Promise<ConflictRegion[]> {
    try {
      const { stdout: fileContent } = await execAsync(`cat "${repoPath}/${filePath}"`);
      const lines = (fileContent as any).split("\n");

      const regions: ConflictRegion[] = [];
      let inConflict = false;
      let startLine = 0;

      for (let i = 0; i < (lines as any).length; i++) {
        const line = lines[i];

        if ((line as any).startsWith("<<<<<<<")) {
          inConflict = true;
          startLine = i + 1;
        } else if ((line as any).startsWith(">>>>>>>") && inConflict) {
          (regions as any).push({
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

      if (!(sessionCommits as any).trim()) {
        return true; // No session commits not in base
      }

      // Check if the content changes are already in base by comparing trees
      const { stdout: sessionTree } = await execAsync(
        `git -C ${repoPath} rev-parse ${sessionBranch}^{tree}`
      );

      const { stdout: baseTree } = await execAsync(
        `git -C ${repoPath} rev-parse ${baseBranch}^{tree}`
      );

      return (sessionTree as any).trim() === (baseTree as any).trim();
    } catch (error) {
      log.warn("Could not check session changes in base", { error });
      return false;
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
      const deleteConflicts = (conflictFiles as any).filter(
        (f) =>
          (f.deletionInfo as any).canAutoResolve &&
          ((f as any).status === (FileConflictStatus as any).DELETED_BY_US ||
            (f as any).status === (FileConflictStatus as any).DELETED_BY_THEM)
      );

      for (const file of deleteConflicts) {
        // Remove the file to accept the deletion
        await execAsync(`git -C ${repoPath} rm "${(file as any).path}"`);
        log.debug("Auto-resolved delete conflict", { file: (file as any).path });
      }

      if ((deleteConflicts as any).length > 0) {
        // Commit the resolution
        await execAsync(`git -C ${repoPath} commit -m "resolve conflicts: accept file deletions"`);
        log.debug("Committed auto-resolved delete conflicts", { count: (deleteConflicts as any).length });
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
    if ((conflictFiles as any).length === 0) {
      return { conflictType: (ConflictType as any).NONE, severity: (ConflictSeverity as any).NONE };
    }

    const hasContentConflicts = (conflictFiles as any).some(
      (f) => (f as any).status === (FileConflictStatus as any).MODIFIED_BOTH
    );
    const hasDeleteConflicts = (conflictFiles as any).some(
      (f) =>
        (f as any).status === (FileConflictStatus as any).DELETED_BY_US ||
        (f as any).status === (FileConflictStatus as any).DELETED_BY_THEM
    );
    const hasRenameConflicts = (conflictFiles as any).some((f) => (f as any).status === (FileConflictStatus as any).RENAMED);

    let conflictType: ConflictType;
    let severity: ConflictSeverity;

    if (hasRenameConflicts) {
      conflictType = (ConflictType as any).RENAME_CONFLICT;
      severity = (ConflictSeverity as any).MANUAL_COMPLEX;
    } else if (hasContentConflicts && hasDeleteConflicts) {
      conflictType = (ConflictType as any).CONTENT_CONFLICT;
      severity = (ConflictSeverity as any).MANUAL_COMPLEX;
    } else if (hasDeleteConflicts) {
      conflictType = (ConflictType as any).DELETE_MODIFY;
      // Check if all deletions are auto-resolvable
      const allAutoResolvable = ((conflictFiles as any).filter((f) => f.deletionInfo) as any).every((f) => (f.deletionInfo as any).canAutoResolve);
      severity = allAutoResolvable
        ? (ConflictSeverity as any).AUTO_RESOLVABLE
        : (ConflictSeverity as any).MANUAL_SIMPLE;
    } else if (hasContentConflicts) {
      conflictType = (ConflictType as any).CONTENT_CONFLICT;
      // Analyze content conflict complexity
      const totalRegions = (conflictFiles as any).reduce(
        (sum, f) => sum + ((f.conflictRegions as any).length || 0),
        0
      );
      severity =
        totalRegions <= 3 ? (ConflictSeverity as any).MANUAL_SIMPLE : (ConflictSeverity as any).MANUAL_COMPLEX;
    } else {
      conflictType = (ConflictType as any).CONTENT_CONFLICT;
      severity = (ConflictSeverity as any).MANUAL_SIMPLE;
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

    if (conflictType === (ConflictType as any).DELETE_MODIFY) {
      const allAutoResolvable = ((conflictFiles as any).filter((f) => f.deletionInfo) as any).every((f) => (f.deletionInfo as any).canAutoResolve);

      if (allAutoResolvable) {
        (strategies as any).push({
          type: "automatic",
          description: "Accept deletions (recommended for removed files)",
          commands: [
            ...((conflictFiles as any).filter((f) => f.deletionInfo) as any).map((f) => `git rm ${(f as any).path}`),
            "git commit -m \"resolve conflicts: accept file deletions\"",
          ],
          riskLevel: "low",
        });
      }
    }

    // Always provide manual resolution option
    (strategies as any).push({
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

  /**
   * Generates user-friendly guidance based on conflict analysis
   */
  private generateUserGuidance(
    conflictType: ConflictType,
    severity: ConflictSeverity,
    conflictFiles: ConflictFile[]
  ): string {
    switch (conflictType) {
    case (ConflictType as any).DELETE_MODIFY: {
      const deletedFiles = ((conflictFiles as any).filter((f) => f.deletionInfo) as any).map((f) => (f as any).path);
      return (`
🗑️  Deleted file conflicts detected

Files deleted in main branch but modified in your session:
${(deletedFiles as any).map((f) => `  • ${f}`).join("\n")}

These conflicts are typically auto-resolvable by accepting the deletion.
The files were removed for a reason (likely part of refactoring or cleanup).

Recommended action: Accept the deletions and remove your changes to these files.
        ` as any).trim();
    }
    case (ConflictType as any).CONTENT_CONFLICT:
      return `
✏️  Content conflicts detected

${(conflictFiles as any).length} file(s) have conflicting changes between your session and main branch.
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

    case (ConflictType as any).ALREADY_MERGED:
      return (`
✅ Changes already merged

Your session changes appear to already be present in the main branch.
You can skip the update step and proceed directly to PR creation.
        ` as any).trim();

    default:
      return (`
⚠️  Merge conflicts detected

${conflictFiles.length} file(s) have conflicts that need resolution.
Review the affected files and choose appropriate resolution strategy.
        ` as any).trim();
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

    if (conflictType === (ConflictType as any).DELETE_MODIFY) {
      (commands as any).push("# Accept file deletions (recommended)");
      ((conflictFiles as any).filter((f) => f.deletionInfo) as any).forEach((f) => commands.push(`git rm "${(f as any).path}"`));
      (commands as any).push("git commit -m \"resolve conflicts: accept file deletions\"");
    } else {
      (commands as any).push("# Check conflict status");
      (commands as any).push("git status");
      (commands as any).push("");
      (commands as any).push("# Edit each conflicted file to resolve <<<<<<< ======= >>>>>>> markers");
      (conflictFiles as any).forEach((f) => commands.push(`# Edit: ${(f as any).path}`));
      (commands as any).push("");
      (commands as any).push("# After editing, add resolved files");
      (commands as any).push("git add .");
      (commands as any).push("git commit -m \"resolve merge conflicts\"");
    }

    return commands;
  }
}
