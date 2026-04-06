/**
 * Branch Analysis Operations
 *
 * Operations for analyzing branch divergence and branch switching conflicts.
 * Extracted from ConflictDetectionService for focused responsibility.
 */
import { execAsync as defaultExecAsync } from "../../utils/exec";
import { log as defaultLog } from "../../utils/logger";
import {
  checkSessionChangesInBase,
  parseMergeConflictOutput,
} from "./conflict-analysis-operations";
import type { BranchDivergenceAnalysis, BranchSwitchWarning } from "./conflict-detection-types";

/**
 * Dependencies for branch analysis operations, injectable for testing
 */
export interface BranchAnalysisDeps {
  execAsync: typeof defaultExecAsync;
  log: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

const defaultDeps: BranchAnalysisDeps = {
  execAsync: defaultExecAsync,
  log: defaultLog,
};

/**
 * Analyzes how two branches have diverged from each other
 */
export async function analyzeBranchDivergenceImpl(
  repoPath: string,
  sessionBranch: string,
  baseBranch: string,
  deps: BranchAnalysisDeps = defaultDeps
): Promise<BranchDivergenceAnalysis> {
  deps.log.debug("Analyzing branch divergence", {
    repoPath,
    sessionBranch,
    baseBranch,
  });

  try {
    // Get commit counts
    const result = await deps.execAsync(
      `git -C ${repoPath} rev-list --left-right --count ${baseBranch}...${sessionBranch}`
    );

    // Check if result is valid before destructuring
    if (!result || !result.stdout) {
      deps.log.warn("Git rev-list command returned invalid result", {
        result,
        repoPath,
        baseBranch,
        sessionBranch,
      });
      return {
        sessionBranch,
        baseBranch,
        aheadCommits: 0,
        behindCommits: 0,
        lastCommonCommit: "",
        sessionChangesInBase: false,
        divergenceType: "none" as const,
        recommendedAction: "none" as const,
      };
    }

    const aheadBehind = String(result.stdout);
    const [behindStr, aheadStr] = aheadBehind.trim().split("\t");
    const behind = Number(behindStr) || 0;
    const ahead = Number(aheadStr) || 0;

    // Get last common commit
    const commonCommitResult = await deps.execAsync(
      `git -C ${repoPath} merge-base ${baseBranch} ${sessionBranch}`
    );

    const commonCommit = commonCommitResult?.stdout?.toString().trim() || "";

    // Check if session changes are already in base
    const sessionChangesInBase = await checkSessionChangesInBase(
      repoPath,
      sessionBranch,
      baseBranch,
      deps.execAsync
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
      lastCommonCommit: commonCommit,
      sessionChangesInBase,
      divergenceType,
      recommendedAction,
    };
  } catch (error) {
    deps.log.error("Error analyzing branch divergence", {
      error,
      repoPath,
      sessionBranch,
      baseBranch,
    });
    throw error;
  }
}

/**
 * Checks for potential conflicts when switching branches
 */
export async function checkBranchSwitchConflictsImpl(
  repoPath: string,
  targetBranch: string,
  deps: BranchAnalysisDeps = defaultDeps
): Promise<BranchSwitchWarning> {
  deps.log.debug("Checking branch switch conflicts", { repoPath, targetBranch });

  try {
    const { stdout: currentBranch } = await deps.execAsync(
      `git -C ${repoPath} rev-parse --abbrev-ref HEAD`
    );
    const fromBranch = currentBranch.toString().trim();

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

    const statusOutputResult = await deps.execAsync(`git -C ${repoPath} status --porcelain`);
    const statusOutput = statusOutputResult?.stdout || "";
    const uncommittedChanges = statusOutput.toString().trim().split("\n").filter(Boolean);

    let conflictingFiles: string[] = [];
    let wouldLoseChanges = false;
    let recommendedAction: BranchSwitchWarning["recommendedAction"] = "force";

    if (uncommittedChanges.length > 0) {
      try {
        await deps.execAsync(
          `git -C ${repoPath} merge-tree $(git -C ${repoPath} write-tree) HEAD ${targetBranch}`
        );
      } catch (error) {
        wouldLoseChanges = true;
        const errorMessage = error instanceof Error ? error.message : String(error);
        conflictingFiles = parseMergeConflictOutput(errorMessage);
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
    deps.log.error("Error checking branch switch conflicts", {
      error,
      repoPath,
      targetBranch,
    });
    throw error;
  }
}
