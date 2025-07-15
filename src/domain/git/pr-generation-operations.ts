import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import { MinskyError } from "../../errors/base-errors";
import { createErrorContext, createSessionNotFoundMessage } from "../../errors/index";

// Re-export types needed for PR generation
export interface PrOptions {
  session?: string;
  repoPath?: string;
  taskId?: string;
  branch?: string;
  debug?: boolean;
  noStatusUpdate?: boolean;
}

export interface PrResult {
  markdown: string;
  statusUpdateResult?: {
    taskId: string;
    previousStatus: string | undefined;
    newStatus: string;
  };
}

export interface PrDependencies {
  execAsync: (command: string, options?: any) => Promise<{ stdout: string; stderr: string }>;
  getSession: (name: string) => Promise<any>;
  getSessionWorkdir: (session: string) => string;
  getSessionByTaskId?: (taskId: string) => Promise<any>;
  ensureBaseDir: () => Promise<void>;
}

export async function prWithDependenciesImpl(
  options: PrOptions, 
  deps: PrDependencies
): Promise<PrResult> {
  await deps.ensureBaseDir();

  const workdir = await determineWorkingDirectory(options, deps);

  if (options.debug) {
    log.debug(`Using workdir: ${workdir}`);
  }

  const branch = await determineCurrentBranch(workdir, options, deps);

  if (options.debug) {
    log.debug(`Using branch: ${branch}`);
  }

  const { baseBranch, mergeBase, comparisonDescription } =
    await determineBaseBranchAndMergeBase(workdir, branch, options, deps);

  if (options.debug) {
    log.debug(`Using merge base: ${mergeBase}`);
    log.debug(`Comparison: ${comparisonDescription}`);
  }

  const markdown = await generatePrMarkdown(
    workdir,
    branch,
    mergeBase,
    comparisonDescription,
    deps
  );

  return { markdown };
}

async function determineWorkingDirectory(
  options: PrOptions,
  deps: PrDependencies
): Promise<string> {
  if (options.repoPath) {
    return options.repoPath;
  }

  // Try to resolve session from taskId if provided
  let sessionName = options.session;
  if (!sessionName && options.taskId) {
    if (!deps.getSessionByTaskId) {
      throw new Error("getSessionByTaskId dependency not available");
    }
    const sessionRecord = await deps.getSessionByTaskId(options.taskId);
    if (!sessionRecord) {
      throw new Error(`No session found for task ID "${options.taskId}"`);
    }
    sessionName = sessionRecord.session;
    log.debug("Resolved session from task ID", {
      taskId: options.taskId,
      session: sessionName,
    });
  }

  if (!sessionName) {
    throw new MinskyError(`
🚫 Cannot create PR - missing required information

You need to specify one of these options to identify the target repository:

📝 Specify a session name:
   minsky git pr --session "my-session"

🎯 Use a task ID (to auto-detect session):
   minsky git pr --task-id "123"

📁 Target a specific repository:
   minsky git pr --repo-path "/path/to/repo"

💡 If you're working in a session workspace, try running from the main workspace:
   cd /path/to/main/workspace
   minsky git pr --session "session-name"

📋 To see available sessions:
   minsky sessions list
`);
  }

  const session = await deps.getSession(sessionName);
  if (!session) {
    const context = createErrorContext().addCommand("minsky git pr").build();

    throw new MinskyError(createSessionNotFoundMessage(sessionName, context as unknown));
  }
  const workdir = deps.getSessionWorkdir(sessionName);

  log.debug("Using workdir for PR", { workdir, session: sessionName });
  return workdir;
}

async function determineCurrentBranch(
  workdir: string,
  options: PrOptions,
  deps: PrDependencies
): Promise<string> {
  if (options.branch) {
    log.debug("Using specified branch for PR", { branch: options.branch });
    return options.branch;
  }

  const { stdout } = await deps.execAsync(`git -C ${workdir} branch --show-current`);
  const branch = stdout.trim();

  log.debug("Using current branch for PR", { branch });
  return branch;
}

async function findBaseBranch(
  workdir: string,
  branch: string,
  options: PrOptions,
  deps: PrDependencies
): Promise<string> {
  // Try to get the remote HEAD branch
  try {
    const { stdout } = await deps.execAsync(
      `git -C ${workdir} symbolic-ref refs/remotes/origin/HEAD --short`
    );
    const baseBranch = stdout.trim().replace("origin/", "");
    log.debug("Found remote HEAD branch", { baseBranch });
    return baseBranch;
  } catch (err) {
    log.debug("Failed to get remote HEAD", {
      error: getErrorMessage(err as any),
      branch,
    });
  }

  // Try to get the upstream branch
  try {
    const { stdout } = await deps.execAsync(
      `git -C ${workdir} rev-parse --abbrev-ref ${branch}@{upstream}`
    );
    const baseBranch = stdout.trim().replace("origin/", "");
    log.debug("Found upstream branch", { baseBranch });
    return baseBranch;
  } catch (err) {
    log.debug("Failed to get upstream branch", {
      error: getErrorMessage(err as any),
      branch,
    });
  }

  // Check if main exists
  try {
    await deps.execAsync(`git -C ${workdir} show-ref --verify refs/remotes/origin/main`);
    log.debug("Using main as base branch");
    return "main";
  } catch (err) {
    log.debug("Failed to check main branch", {
      error: getErrorMessage(err as any),
    });
  }

  // Check if master exists
  try {
    await deps.execAsync(
      `git -C ${workdir} show-ref --verify refs/remotes/origin/master`
    );
    log.debug("Using master as base branch");
    return "master";
  } catch (err) {
    log.debug("Failed to check master branch", {
      error: getErrorMessage(err as any),
    });
  }

  // Default to main (might not exist)
  return "main";
}

async function determineBaseBranchAndMergeBase(
  workdir: string,
  branch: string,
  options: PrOptions,
  deps: PrDependencies
): Promise<{ baseBranch: string; mergeBase: string; comparisonDescription: string }> {
  const baseBranch = await findBaseBranch(workdir, branch, options, deps);
  log.debug("Using base branch for PR", { baseBranch });

  let mergeBase: string;
  let comparisonDescription: string;

  try {
    // Find common ancestor of the current branch and the base branch
    const { stdout } = await deps.execAsync(
      `git -C ${workdir} merge-base origin/${baseBranch} ${branch}`
    );
    mergeBase = stdout.trim();
    comparisonDescription = `Showing changes from merge-base with ${baseBranch}`;
    log.debug("Found merge base with base branch", { baseBranch, mergeBase });
  } catch (err) {
    log.debug("Failed to find merge base", {
      error: getErrorMessage(err as any),
      branch,
      baseBranch,
    });

    // If merge-base fails, get the first commit of the branch
    try {
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} rev-list --max-parents=0 HEAD`
      );
      mergeBase = stdout.trim();
      comparisonDescription = "Showing changes from first commit";
      log.debug("Using first commit as base", { mergeBase });
    } catch (err) {
      log.debug("Failed to find first commit", {
        error: getErrorMessage(err as any),
        branch,
      });
      // If that also fails, use empty tree
      mergeBase = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // Git empty tree
      comparisonDescription = "Showing all changes";
    }
  }

  return { baseBranch, mergeBase, comparisonDescription };
}

/**
 * Generate the PR markdown content
 */
async function generatePrMarkdown(
  workdir: string,
  branch: string,
  mergeBase: string,
  comparisonDescription: string,
  deps: PrDependencies
): Promise<string> {
  // Get git repository data
  const { commits, modifiedFiles, untrackedFiles, uncommittedChanges, stats } =
    await collectRepositoryData(workdir, branch, mergeBase, deps);

  // Format the commits for display
  const formattedCommits = formatCommits(commits);

  // Check if we have any working directory changes
  const hasWorkingDirChanges =
    untrackedFiles.trim().length > 0 ||
    uncommittedChanges.trim().length > 0;

  return buildPrMarkdown(
    branch,
    formattedCommits,
    modifiedFiles,
    untrackedFiles,
    uncommittedChanges,
    stats,
    comparisonDescription,
    hasWorkingDirChanges
  );
}

/**
 * Format commit data for display in the PR markdown
 */
function formatCommits(commits: string): string {
  if (!commits || !commits.trim()) {
    return "No commits yet";
  }

  try {
    // Check if the commits are in the expected format with delimiters
    if (commits.includes("\x1f")) {
      // Parse the commits data with delimiters
      // Split by record separator
      const commitRecords = commits.split("\x1e").filter(Boolean);
      const formattedEntries: string[] = [];

      for (const record of commitRecords) {
        // Split by field separator
        const fields = record.split("\x1f");
        if (fields.length > 1) {
          if (fields[0] !== undefined && fields[1] !== undefined) {
            const hash = fields[0].substring(0, 7);
            const message = fields[1];
            formattedEntries.push(`${hash} ${message}`);
          }
        } else {
          // Use the record as-is if it doesn't have the expected format
          formattedEntries.push(record.trim());
        }
      }

      if (formattedEntries.length > 0) {
        return formattedEntries.join("\n");
      }
    }

    // Use as-is if not in the expected format
    return commits;
  } catch (error) {
    // In case of any parsing errors, fall back to the raw commits data
    return commits;
  }
}

/**
 * Builds the PR markdown from all the components
 */
function buildPrMarkdown(
  branch: string,
  formattedCommits: string,
  modifiedFiles: string,
  untrackedFiles: string,
  uncommittedChanges: string,
  stats: string,
  comparisonDescription: string,
  hasWorkingDirChanges: boolean
): string {
  // Generate the PR markdown
  const sections = [
    `# Pull Request for branch \`${branch}\`\n`,
    `## Commits\n${formattedCommits}\n`,
  ];

  // Add modified files section
  let modifiedFilesSection = `## Modified Files (${comparisonDescription})\n`;
  if (modifiedFiles) {
    modifiedFilesSection += `${modifiedFiles}\n`;
  } else if (untrackedFiles) {
    modifiedFilesSection += `${untrackedFiles}\n`;
  } else {
    modifiedFilesSection += "No modified files detected\n";
  }
  sections.push(modifiedFilesSection);

  // Add stats section
  sections.push(`## Stats\n${stats || "No changes"}`);

  // Add working directory changes section if needed
  if (hasWorkingDirChanges) {
    let wdChanges = "## Uncommitted changes in working directory\n";
    if (uncommittedChanges.trim()) {
      wdChanges += `${uncommittedChanges}\n`;
    }
    if (untrackedFiles.trim()) {
      wdChanges += `${untrackedFiles}\n`;
    }
    sections.push(wdChanges);
  }

  return sections.join("\n");
}

/**
 * Collect git repository data for PR generation
 */
async function collectRepositoryData(
  workdir: string,
  branch: string,
  mergeBase: string,
  deps: PrDependencies
): Promise<{
  commits: string;
  modifiedFiles: string;
  untrackedFiles: string;
  uncommittedChanges: string;
  stats: string;
}> {
  // Get commits on the branch
  const commits = await getCommitsOnBranch(workdir, branch, mergeBase, deps);

  // Get modified files and diff stats
  const { modifiedFiles, diffNameStatus } = await getModifiedFiles(
    workdir,
    branch,
    mergeBase,
    deps
  );

  // Get working directory changes
  const { uncommittedChanges, untrackedFiles } = await getWorkingDirectoryChanges(
    workdir,
    deps
  );

  // Get changes stats
  const stats = await getChangeStats(
    workdir,
    branch,
    mergeBase,
    diffNameStatus,
    uncommittedChanges,
    deps
  );

  return { commits, modifiedFiles, untrackedFiles, uncommittedChanges, stats };
}

/**
 * Get commits on the branch
 */
async function getCommitsOnBranch(
  workdir: string,
  branch: string,
  mergeBase: string,
  deps: PrDependencies
): Promise<string> {
  try {
    const { stdout } = await deps.execAsync(
      `git -C ${workdir} log --oneline ${mergeBase}..${branch}`,
      { maxBuffer: 1024 * 1024 }
    );
    return stdout;
  } catch (err) {
    // Return empty string on error
    return "";
  }
}

/**
 * Get modified files in the branch
 */
async function getModifiedFiles(
  workdir: string,
  branch: string,
  mergeBase: string,
  deps: PrDependencies
): Promise<{ modifiedFiles: string; diffNameStatus: string }> {
  let modifiedFiles = "";
  let diffNameStatus = "";

  try {
    // Get modified files in name-status format for processing
    const { stdout: nameStatus } = await deps.execAsync(
      `git -C ${workdir} diff --name-status ${mergeBase} ${branch}`,
      { maxBuffer: 1024 * 1024 }
    );
    diffNameStatus = nameStatus;

    // Get name-only format for display
    const { stdout: nameOnly } = await deps.execAsync(
      `git -C ${workdir} diff --name-only ${mergeBase}..${branch}`,
      { maxBuffer: 1024 * 1024 }
    );
    modifiedFiles = nameOnly;
  } catch (err) {
    // Return empty strings on error
  }

  return { modifiedFiles, diffNameStatus };
}

/**
 * Get uncommitted changes and untracked files
 */
async function getWorkingDirectoryChanges(
  workdir: string,
  deps: PrDependencies
): Promise<{ uncommittedChanges: string; untrackedFiles: string }> {
  let uncommittedChanges = "";
  let untrackedFiles = "";

  try {
    // Get uncommitted changes
    const { stdout } = await deps.execAsync(`git -C ${workdir} diff --name-status`, {
      maxBuffer: 1024 * 1024,
    });
    uncommittedChanges = stdout;
  } catch (err) {
    // Ignore errors for uncommitted changes
  }

  try {
    // Get untracked files
    const { stdout } = await deps.execAsync(
      `git -C ${workdir} ls-files --others --exclude-standard`,
      { maxBuffer: 1024 * 1024 }
    );
    untrackedFiles = stdout;
  } catch (err) {
    // Ignore errors for untracked files
  }

  return { uncommittedChanges, untrackedFiles };
}

/**
 * Get change statistics
 */
async function getChangeStats(
  workdir: string,
  branch: string,
  mergeBase: string,
  diffNameStatus: string,
  uncommittedChanges: string,
  deps: PrDependencies
): Promise<string> {
  let stats = "No changes";

  try {
    // Try to get diff stats from git
    const { stdout: statOutput } = await deps.execAsync(
      `git -C ${workdir} diff --stat ${mergeBase}..${branch}`,
      { maxBuffer: 1024 * 1024 }
    );

    // If we got stats from git, use them
    if (statOutput && statOutput.trim()) {
      stats = statOutput.trim();
    }
    // Otherwise, try to infer stats from the diff status
    else if (diffNameStatus && diffNameStatus.trim()) {
      const lines = diffNameStatus.trim().split("\n");
      if (lines.length > 0) {
        stats = `${lines.length} files changed`;
      }
    }
    // If we have uncommitted changes but no stats for the branch,
    // we should make sure those are reflected in the output
    else if (uncommittedChanges.trim()) {
      const lines = uncommittedChanges.trim().split("\n");
      if (lines.length > 0) {
        stats = `${lines.length} uncommitted files changed`;
      }
    }
  } catch (err) {
    // Ignore errors for stats
  }

  return stats;
} 
