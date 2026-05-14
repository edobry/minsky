import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import { safeShellQuote } from "../../utils/exec";

export interface MergeResult {
  workdir: string;
  merged: boolean;
  conflicts: boolean;
}

export interface MergeBranchDependencies {
  execAsync: (command: string) => Promise<{ stdout: string; stderr: string }>;
}

export async function mergeBranchImpl(
  workdir: string,
  branch: string,
  deps: MergeBranchDependencies
): Promise<MergeResult> {
  log.debug("mergeBranch called", { workdir, branch });
  const qWorkdir = safeShellQuote(workdir);

  try {
    // Get current commit hash
    const { stdout: beforeHash } = await deps.execAsync(`git -C ${qWorkdir} rev-parse HEAD`);
    log.debug("Before merge commit hash", { beforeHash: beforeHash.trim() });

    // Try to merge the branch
    try {
      // mt#1829: branch is PR/operator-controlled; wrap with safeShellQuote.
      const qBranch = safeShellQuote(branch);
      log.debug("Attempting merge", { command: `git -C ${qWorkdir} merge ${qBranch}` });
      await deps.execAsync(`git -C ${qWorkdir} merge ${qBranch}`);
      log.debug("Merge completed successfully");
    } catch (err) {
      log.debug("Merge command failed, checking for conflicts", {
        error: getErrorMessage(err),
      });

      // Check if there are merge conflicts
      const { stdout: status } = await deps.execAsync(`git -C ${qWorkdir} status --porcelain`);
      log.debug("Git status after failed merge", { status });

      const hasConflicts = status.includes("UU") || status.includes("AA") || status.includes("DD");
      log.debug("Conflict detection result", {
        hasConflicts,
        statusIncludes: {
          UU: status.includes("UU"),
          AA: status.includes("AA"),
          DD: status.includes("DD"),
        },
      });

      if (hasConflicts) {
        // Leave repository in merging state for user to resolve conflicts
        log.debug(
          "Merge conflicts detected, leaving repository in merging state for manual resolution"
        );
        return { workdir, merged: false, conflicts: true };
      }
      log.debug("No conflicts detected, re-throwing original error");
      throw err;
    }

    // Get new commit hash
    const { stdout: afterHash } = await deps.execAsync(`git -C ${qWorkdir} rev-parse HEAD`);
    log.debug("After merge commit hash", { afterHash: afterHash.trim() });

    // Return whether any changes were merged
    const merged = beforeHash.trim() !== afterHash.trim();
    log.debug("Merge result", { merged, conflicts: false });
    return { workdir, merged, conflicts: false };
  } catch (err) {
    log.error("mergeBranch failed with error", {
      error: getErrorMessage(err),
      workdir,
      branch,
    });
    throw new Error(`Failed to merge branch ${branch}: ${getErrorMessage(err)}`);
  }
}
