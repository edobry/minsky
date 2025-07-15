import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { log } from "../../utils/logger";
import { MinskyError, getErrorMessage } from "../../errors";

const execAsync = promisify(exec);

export interface CloneOptions {
  repoUrl: string;
  workdir: string;
  session?: string;
  branch?: string;
}

export interface CloneResult {
  workdir: string;
  session: string;
}

export interface CloneDependencies {
  mkdir: (path: string, options?: any) => Promise<void>;
  execAsync: (command: string) => Promise<{ stdout: string; stderr: string }>;
  access: (path: string) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
  rm: (path: string, options?: any) => Promise<void>;
}

export async function cloneRepository(
  options: CloneOptions,
  deps: CloneDependencies,
  generateSessionId: () => string
): Promise<CloneResult> {
  const session = options.session || generateSessionId();
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
      throw new MinskyError("Repository URL is required for cloning");
    }

    // Clone the repository with verbose logging FIRST
    log.debug(`Executing: git clone ${options.repoUrl} ${workdir}`);
    const cloneCmd = `git clone ${options.repoUrl} ${workdir}`;
    try {
      // Create session directory structure ONLY when ready to clone
      // This ensures no orphaned directories if validation fails
      await deps.mkdir(dirname(workdir), { recursive: true });
      log.debug("Session parent directory created", { parentDir: dirname(workdir) });

      const { stdout, stderr } = await deps.execAsync(cloneCmd);
      log.debug("git clone succeeded", {
        stdout: stdout.trim().substring(0, 200)
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
          error: getErrorMessage(err),
        });
      }
    } catch (accessErr) {
      log.error(".git directory not found after clone", {
        workdir,
        error: getErrorMessage(accessErr),
      });
      throw new MinskyError("Git repository was not properly cloned: .git directory not found");
    }

    return {
      workdir,
      session,
    };
  } catch (error) {
    log.error("Error during git clone", {
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
      repoUrl: options.repoUrl,
      workdir,
    });
    throw new MinskyError(`Failed to clone git repository: ${getErrorMessage(error)}`);
  }
} 
