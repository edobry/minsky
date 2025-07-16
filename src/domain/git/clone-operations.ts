import { join, dirname } from "node:path";
import { normalizeRepoName } from "../repo-utils";
import { getErrorMessage } from "../../errors";
import { log } from "../../utils/logger";

/**
 * Options for clone operations
 */
export interface CloneOptions {
  repoUrl: string;
  workdir: string; // Explicit path where to clone, provided by caller
  session?: string;
  branch?: string;
}

/**
 * Result of clone operations
 */
export interface CloneResult {
  workdir: string;
  session: string;
}

/**
 * Dependencies for clone operations
 */
export interface CloneDependencies {
  execAsync: (command: string, options?: any) => Promise<{ stdout: string; stderr: string }>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
  access: (path: string) => Promise<void>;
  rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
  generateSessionId: () => string;
}

/**
 * Clone a repository and set up a session workspace
 */
export async function cloneImpl(options: CloneOptions, deps: CloneDependencies): Promise<CloneResult> {
  const session = options.session || deps.generateSessionId();
  const workdir = options.workdir;

  log.debug("Clone operation starting", {
    repoUrl: options.repoUrl,
    workdir,
    session,
  });

  try {
    // Validate repo URL
    if (!options.repoUrl || options.repoUrl.trim() === "") {
      log.error("Invalid repository URL", { repoUrl: options.repoUrl });
      throw new Error("Repository URL is required for cloning");
    }

    // Clone the repository with verbose logging FIRST
    log.debug(`Executing: git clone ${options.repoUrl} ${workdir}`);
    const cloneCmd = `git clone ${options.repoUrl} ${workdir}`;

    // Ensure parent directory exists
    await deps.mkdir(dirname(workdir), { recursive: true });
    log.debug("Session parent directory created", { parentDir: dirname(workdir) });

    try {
      const { stdout, stderr } = await deps.execAsync(cloneCmd);
      log.debug("git clone succeeded", {
        stdout: stdout.trim().substring(0, 200),
      });
    } catch (cloneErr) {
      log.error("git clone command failed", {
        error: getErrorMessage(cloneErr),
        command: cloneCmd,
      });

      // Clean up orphaned session directory if git clone fails
      try {
        await deps.rm(workdir, { recursive: true, force: true });
        log.debug("Cleaned up session directory after git clone failure", { workdir });
      } catch (cleanupErr) {
        log.warn("Failed to cleanup session directory after git clone failure", {
          workdir,
          error: getErrorMessage(cleanupErr),
        });
      }

      throw cloneErr;
    }

    // Verify the clone was successful by checking for .git directory
    log.debug("Verifying clone success");
    try {
      const gitDir = join(workdir, ".git");
      await deps.access(gitDir);
      log.debug(".git directory exists, clone was successful", { gitDir });

      // List files in the directory to help debug
      try {
        const dirContents = await deps.readdir(workdir);
        log.debug("Clone directory contents", {
          workdir,
          fileCount: dirContents.length,
          firstFewFiles: dirContents.slice(0, 5),
        });
      } catch (err) {
        log.warn("Could not read clone directory", {
          workdir,
          error: getErrorMessage(err as any),
        });
      }
    } catch (accessErr) {
      log.error(".git directory not found after clone", {
        workdir,
        error: getErrorMessage(accessErr),
      });
      throw new Error("Git repository was not properly cloned: .git directory not found");
    }

    return {
      workdir,
      session,
    };
  } catch (error) {
    log.error("Error during git clone", {
      error: getErrorMessage(error as any),
      stack: error instanceof Error ? error.stack : undefined,
      repoUrl: options.repoUrl,
      workdir,
    });
    throw new Error(`Failed to clone git repository: ${getErrorMessage(error as any)}`);
  }
}
