/**
 * Branch Analysis Operations
 *
 * Operations for analyzing branch divergence and branch switching conflicts.
 * Extracted from ConflictDetectionService for focused responsibility.
 */
import { execAsync as defaultExecAsync, safeShellQuote } from "@minsky/shared/exec";
import { log as defaultLog } from "@minsky/shared/logger";
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

  const qRepoPath = safeShellQuote(repoPath);

  try {
    // Get commit counts
    const result = await deps.execAsync(
      `git -C ${qRepoPath} rev-list --left-right --count ${baseBranch}...${sessionBranch}`
    );

    // Check if result is valid before destructuring
    if (!result || !result.stdout) {
      deps.log.warn("Git rev-list command returned invalid result", {
        result,
        repoPath,
        baseBranch,
        sessionBranch,
      });
      // mt#3220: "undeterminable", NOT "converged". Returning zeros and
      // `divergenceType: "none"` here made a failed measurement indistinguishable
      // from a verified-identical pair, and `smartSessionUpdate` acts on exactly
      // that value — it would skip the update with the reason "No update needed -
      // session is current or ahead" without ever having compared anything.
      return unknownDivergence(sessionBranch, baseBranch);
    }

    const aheadBehind = String(result.stdout);
    const [behindStr, aheadStr] = aheadBehind.trim().split("\t");
    const behind = parseCount(behindStr);
    const ahead = parseCount(aheadStr);

    // mt#3220: `Number(x) || 0` turned both NaN (unparseable) and a missing
    // field into a confident 0. An output shape we do not understand is not a
    // measurement of zero divergence.
    if (behind === null || ahead === null) {
      deps.log.warn("Git rev-list output did not parse as an ahead/behind pair", {
        stdout: aheadBehind,
        repoPath,
        baseBranch,
        sessionBranch,
      });
      return unknownDivergence(sessionBranch, baseBranch);
    }

    // Get last common commit
    const commonCommitResult = await deps.execAsync(
      `git -C ${qRepoPath} merge-base ${baseBranch} ${sessionBranch}`
    );

    // mt#3220: null, not "" — an empty string is the same "looks like an answer"
    // ambiguity for a commit id that 0 was for the counts.
    const commonCommit = commonCommitResult?.stdout?.toString().trim() || null;

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
 * Parses one side of `git rev-list --left-right --count` output.
 *
 * Returns null rather than 0 for anything that is not a non-negative integer
 * (mt#3220). The previous `Number(x) || 0` mapped `undefined` (field absent) and
 * `NaN` (garbage) onto the same value a genuinely-zero count produces, so an
 * output shape we do not understand was reported as "no divergence."
 *
 * Exported for tests.
 */
export function parseCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The result for a comparison that could not be made (mt#3220).
 *
 * `divergenceType: "unknown"` + `recommendedAction: "manual_review"` — never
 * `"none"`, which asserts the branches ARE converged and causes
 * `smartSessionUpdate` to skip with "No update needed."
 *
 * Exported for tests.
 */
export function unknownDivergence(
  sessionBranch: string,
  baseBranch: string
): BranchDivergenceAnalysis {
  return {
    sessionBranch,
    baseBranch,
    aheadCommits: null,
    behindCommits: null,
    lastCommonCommit: null,
    sessionChangesInBase: false,
    divergenceType: "unknown",
    recommendedAction: "manual_review",
  };
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

  const qRepoPath = safeShellQuote(repoPath);

  try {
    const { stdout: currentBranch } = await deps.execAsync(
      `git -C ${qRepoPath} rev-parse --abbrev-ref HEAD`
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

    const statusOutputResult = await deps.execAsync(`git -C ${qRepoPath} status --porcelain`);
    const statusOutput = statusOutputResult?.stdout || "";
    const uncommittedChanges = statusOutput.toString().trim().split("\n").filter(Boolean);

    let conflictingFiles: string[] = [];
    let wouldLoseChanges = false;
    let recommendedAction: BranchSwitchWarning["recommendedAction"] = "force";

    if (uncommittedChanges.length > 0) {
      try {
        await deps.execAsync(
          `git -C ${qRepoPath} merge-tree $(git -C ${qRepoPath} write-tree) HEAD ${targetBranch}`
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
