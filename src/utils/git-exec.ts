/**
 * Git Execution Utility
 *
 * This module provides git command execution with timeout handling and contextual error messages
 * for the specific scenarios identified in Task 223.
 */

import { execAsync } from "./exec";
import {
  createGitTimeoutErrorMessage,
  createMergeConflictErrorMessage,
} from "../errors/enhanced-error-templates";
import { MinskyError, getErrorMessage } from "../errors/index";

/**
 * Enhanced git execution options
 */
export interface GitExecOptions {
  /** Working directory for the git command */
  workdir?: string;
  /** Timeout in milliseconds (default: 30000ms / 30 seconds) */
  timeout?: number;
  /** Additional context information for error messages */
  context?: Array<{ label: string; value: string }>;
}

/**
 * Result of git command execution
 */
export interface GitExecResult {
  stdout: string;
  stderr: string;
  command: string;
  workdir?: string;
  executionTimeMs: number;
}

/**
 * Execute a git command with enhanced timeout handling and error messages
 */
export async function execGitWithTimeout(
  operation: string,
  command: string,
  options: GitExecOptions = {}
): Promise<GitExecResult> {
  const {
    workdir,
    timeout = 30000, // Default 30 second timeout
    context = [],
  } = options;

  const startTime = Date.now();
  const fullCommand = workdir ? `git -C ${workdir} ${command}` : `git ${command}`;

  try {
    const { stdout, stderr } = await execAsync(fullCommand, {
      timeout,
      ...(workdir && { cwd: workdir }),
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0", // Disable git interactive prompts
        GIT_ASKPASS: "echo", // Prevent password prompts
        HUSKY: "0", // Disable husky hooks during automated operations
      },
    });

    const executionTimeMs = Date.now() - startTime;

    return {
      stdout,
      stderr,
      command: fullCommand,
      workdir,
      executionTimeMs,
    };
  } catch (error: unknown) {
    const executionTimeMs = Date.now() - startTime;

    // Node.js exec errors have additional properties beyond standard Error
    const execError = error as {
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    // Handle timeout errors with enhanced error messages
    if (execError?.killed && execError?.signal === "SIGTERM") {
      const errorMessage = createGitTimeoutErrorMessage(operation, timeout, workdir, [
        ...context,
        { label: "Command", value: fullCommand },
        { label: "Execution time", value: `${executionTimeMs}ms` },
      ]);
      throw new MinskyError(errorMessage);
    }

    // Handle merge conflicts with enhanced error messages
    if (
      (execError?.stdout && execError.stdout.includes("CONFLICT")) ||
      (execError?.stderr && execError.stderr.includes("CONFLICT"))
    ) {
      const conflictFiles = extractConflictFiles(execError.stdout ?? "", execError.stderr ?? "");
      const conflictTypes = analyzeConflictTypes(
        execError.stdout ?? "",
        execError.stderr ?? "",
        conflictFiles
      );

      const errorMessage = createMergeConflictErrorMessage(
        operation,
        conflictFiles,
        conflictTypes,
        workdir,
        [
          ...context,
          { label: "Command", value: fullCommand },
          { label: "Execution time", value: `${executionTimeMs}ms` },
        ]
      );
      throw new MinskyError(errorMessage);
    }

    // Re-throw other errors with additional context
    const errorMessage = getErrorMessage(error) || "Unknown git command error";
    const enhancedError = new MinskyError(
      `Git ${operation} failed: ${errorMessage}\n\nCommand: ${fullCommand}\nWorking directory: ${workdir || process.cwd()}\nExecution time: ${executionTimeMs}ms`
    );

    throw enhancedError;
  }
}

/**
 * Extract conflicting file names from git output
 */
function extractConflictFiles(stdout: string, stderr: string): string[] {
  const output = `${stdout}\n${stderr}`;
  const conflictLines = output
    .split("\n")
    .filter((line) => line.includes("CONFLICT") && line.includes(" in "));

  const files = conflictLines
    .map((line) => {
      const match = line.match(/CONFLICT.*in (.+?)(?:\s|$)/);
      return match ? match[1] || null : null;
    })
    .filter(Boolean) as string[];

  // Remove duplicates
  return [...new Set(files)];
}

/**
 * Analyze the types of conflicts from git output
 */
function analyzeConflictTypes(
  stdout: string,
  stderr: string,
  conflictFiles: string[]
): { [file: string]: "modify/modify" | "add/add" | "delete/modify" | "other" } {
  const output = `${stdout}\n${stderr}`;
  const types: { [file: string]: "modify/modify" | "add/add" | "delete/modify" | "other" } = {};

  conflictFiles.forEach((file) => {
    if (output.includes(`CONFLICT (content): Merge conflict in ${file}`)) {
      types[file] = "modify/modify";
    } else if (output.includes(`CONFLICT (add/add): Merge conflict in ${file}`)) {
      types[file] = "add/add";
    } else if (output.includes(`CONFLICT (modify/delete): ${file}`)) {
      types[file] = "delete/modify";
    } else {
      types[file] = "other";
    }
  });

  return types;
}

/**
 * Convenience functions for common git operations with timeout handling
 */

export async function gitCloneWithTimeout(
  repoUrl: string,
  targetDir: string,
  options: GitExecOptions = {}
): Promise<GitExecResult> {
  return execGitWithTimeout("clone", `clone ${repoUrl} ${targetDir}`, {
    ...options,
    context: [
      ...(options.context || []),
      { label: "Repository URL", value: repoUrl },
      { label: "Target directory", value: targetDir },
    ],
  });
}

export async function gitFetchWithTimeout(
  remote: string = "origin",
  branch?: string,
  options: GitExecOptions = {}
): Promise<GitExecResult> {
  const command = branch ? `fetch ${remote} ${branch}` : `fetch ${remote}`;
  return execGitWithTimeout("fetch", command!, {
    ...options,
    context: [
      ...(options.context || []),
      { label: "Remote", value: remote },
      ...(branch ? [{ label: "Branch", value: branch }] : []),
    ],
  });
}

export async function gitPushWithTimeout(
  remote: string = "origin",
  branch?: string,
  options: GitExecOptions = {}
): Promise<GitExecResult> {
  const command = branch ? `push ${remote} ${branch}` : `push ${remote}`;
  return execGitWithTimeout("push", command!, {
    ...options,
    context: [
      ...(options.context || []),
      { label: "Remote", value: remote },
      ...(branch ? [{ label: "Branch", value: branch }] : []),
    ],
  });
}

export async function gitPullWithTimeout(
  remote: string = "origin",
  branch?: string,
  options: GitExecOptions = {}
): Promise<GitExecResult> {
  const command = branch ? `pull ${remote} ${branch}` : `pull ${remote}`;
  return execGitWithTimeout("pull", command!, {
    ...options,
    context: [
      ...(options.context || []),
      { label: "Remote", value: remote },
      ...(branch ? [{ label: "Branch", value: branch }] : []),
    ],
  });
}

export async function gitMergeWithTimeout(
  branch: string,
  options: GitExecOptions = {}
): Promise<GitExecResult> {
  return execGitWithTimeout("merge", `merge ${branch}`, {
    ...options,
    context: [...(options.context || []), { label: "Branch to merge", value: branch }],
  });
}
