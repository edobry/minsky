/**
 * Conflict Analysis Operations
 *
 * Operations for analyzing conflict files, regions, and resolution strategies.
 * Extracted from ConflictDetectionService to improve modularity.
 */
import { execAsync } from "../../utils/exec";
import { execGitWithTimeout } from "../../utils/git-exec";
import { readFile } from "fs/promises";
import { join } from "path";
import { log } from "../../utils/logger";
import {
  ConflictFile,
  ConflictRegion,
  DeletionInfo,
  FileConflictStatus,
  ConflictType,
  ConflictSeverity,
  ResolutionStrategy,
} from "./conflict-detection-types";

/**
 * Analyzes conflict files in a repository
 */
export async function analyzeConflictFiles(repoPath: string): Promise<ConflictFile[]> {
  try {
    const { stdout: statusOutput } = await execGitWithTimeout(
      "analyze-conflict-files",
      "status --porcelain",
      { workdir: repoPath }
    );

    const conflictFiles: ConflictFile[] = [];
    const lines = statusOutput
      .toString()
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
          deletionInfo = await analyzeDeletion(repoPath, filePath, "us");
          break;
        case "UD":
          fileStatus = FileConflictStatus.DELETED_BY_THEM;
          deletionInfo = await analyzeDeletion(repoPath, filePath, "them");
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
          ? await analyzeConflictRegions(repoPath, filePath)
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

/**
 * Analyzes deletion conflicts to determine context and resolution options
 */
export async function analyzeDeletion(
  repoPath: string,
  filePath: string,
  deletedBy: "us" | "them"
): Promise<DeletionInfo> {
  try {
    // Get the last commit that touched this file
    const { stdout: lastCommit } = await execGitWithTimeout(
      "analyze-deletion-last-commit",
      `log -n 1 --format=%H -- ${filePath}`,
      { workdir: repoPath }
    );

    return {
      deletedInBranch: deletedBy === "us" ? "session" : "main",
      modifiedInBranch: deletedBy === "us" ? "main" : "session",
      lastCommitHash: lastCommit.toString().trim(),
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
 * Analyzes conflict regions within a file to understand the scope of conflicts
 */
export async function analyzeConflictRegions(
  repoPath: string,
  filePath: string
): Promise<ConflictRegion[]> {
  try {
    const fileContent = (await readFile(join(repoPath, filePath), "utf-8")) as string;
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

/**
 * Checks if session changes are already incorporated in the base branch
 */
export async function checkSessionChangesInBase(
  repoPath: string,
  sessionBranch: string,
  baseBranch: string,
  exec: typeof execAsync = execAsync
): Promise<boolean> {
  try {
    // Get session commits not in base
    const { stdout: sessionCommits } = await exec(
      `git -C ${repoPath} rev-list ${baseBranch}..${sessionBranch}`
    );

    if (!sessionCommits.toString().trim()) {
      return true; // No session commits not in base
    }

    // Check if the content changes are already in base by comparing trees
    const { stdout: sessionTree } = await exec(
      `git -C ${repoPath} rev-parse ${sessionBranch}^{tree}`
    );

    const { stdout: baseTree } = await exec(`git -C ${repoPath} rev-parse ${baseBranch}^{tree}`);

    return sessionTree.toString().trim() === baseTree.toString().trim();
  } catch (error) {
    log.warn("Could not check session changes in base", { error });
    return false;
  }
}

/**
 * Automatically resolves delete conflicts where possible
 */
export async function autoResolveDeleteConflicts(
  repoPath: string,
  conflictFiles: ConflictFile[]
): Promise<void> {
  try {
    const deleteConflicts = conflictFiles.filter(
      (file) =>
        file.deletionInfo?.canAutoResolve &&
        (file.status === FileConflictStatus.DELETED_BY_US ||
          file.status === FileConflictStatus.DELETED_BY_THEM)
    );

    if (deleteConflicts.length > 0) {
      for (const file of deleteConflicts) {
        if (file.status === FileConflictStatus.DELETED_BY_US) {
          // Accept the deletion (remove the file)
          await execGitWithTimeout("auto-resolve-rm", `rm "${file.path}"`, { workdir: repoPath });
        } else if (file.status === FileConflictStatus.DELETED_BY_THEM) {
          // Keep the modified file (add it)
          await execGitWithTimeout("auto-resolve-add", `add "${file.path}"`, { workdir: repoPath });
        }
      }

      // Commit the resolution
      await execAsync(`git -C ${repoPath} commit -m "resolve conflicts: accept file deletions"`);
      log.debug("Committed auto-resolved delete conflicts", {
        count: deleteConflicts.length,
      });
    }
  } catch (error) {
    log.error("Error auto-resolving delete conflicts", { error });
    throw error;
  }
}

/**
 * Analyzes the severity of conflicts based on file analysis
 */
export function analyzeConflictSeverity(conflictFiles: ConflictFile[]): {
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
  const hasRenameConflicts = conflictFiles.some((f) => f.status === FileConflictStatus.RENAMED);

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
    severity = totalRegions <= 3 ? ConflictSeverity.MANUAL_SIMPLE : ConflictSeverity.MANUAL_COMPLEX;
  } else {
    conflictType = ConflictType.CONTENT_CONFLICT;
    severity = ConflictSeverity.MANUAL_SIMPLE;
  }

  return { conflictType, severity };
}

/**
 * Parses merge conflict output to extract conflicting file paths
 */
export function parseMergeConflictOutput(output: string): string[] {
  const files: string[] = [];
  const regex = /CONFLICT \((.+?)\): Merge conflict in (.+)/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    if (match[2]) files.push(match[2]);
  }
  return files;
}

/**
 * Generates recovery commands for resolving conflicts
 */
export function generateRecoveryCommands(
  conflictFiles: ConflictFile[],
  conflictType: ConflictType
): string[] {
  const commands: string[] = [];

  if (conflictType === ConflictType.DELETE_MODIFY) {
    commands.push("# Accept file deletions (recommended)");
    conflictFiles.filter((f) => f.deletionInfo).forEach((f) => commands.push(`git rm "${f.path}"`));
    commands.push('git commit -m "resolve conflicts: accept file deletions"');
  } else {
    commands.push("# Check conflict status");
    commands.push("git status");
    commands.push("");
    commands.push("# Edit each conflicted file to resolve <<<<<<< ======= >>>>>>> markers");
    conflictFiles.forEach((f) => commands.push(`# Edit: ${f.path}`));
    commands.push("");
    commands.push("# After editing, add resolved files");
    commands.push("git add .");
    commands.push('git commit -m "resolve merge conflicts"');
  }

  return commands;
}
