import { join } from "path";
import { mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { SessionDB } from "../session.js";
import { normalizeRepoName } from "../repo-utils.js";
import type {
  RepositoryBackend,
  RepositoryBackendConfig,
  CloneResult,
  BranchResult,
  Result,
  RepoStatus,
} from "./index.js";

// Define a global for process to avoid linting errors
declare const process: {
  env: {
    XDG_STATE_HOME?: string;
    HOME?: string;
  };
};

const execAsync = promisify(exec);

/**
 * GitHub Repository Backend implementation
 * Handles cloning, branching and other operations for GitHub repositories
 */
export class GitHubBackend implements RepositoryBackend {
  private readonly baseDir: string;
  private readonly repoUrl: string;
  private readonly repoName: string;
  private readonly token?: string;
  private readonly owner?: string;
  private readonly repo?: string;
  private sessionDb: SessionDB;

  /**
   * Create a new GitHubBackend instance
   * @param config Backend configuration
   */
  constructor(config: RepositoryBackendConfig) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    this.baseDir = join(xdgStateHome, "minsky", "git");

    // Extract GitHub-specific options
    this.token = config.github?.token;
    this.owner = config.github?.owner;
    this.repo = config.github?.repo;

    // Construct repo URL with token if provided
    if (this.token && this.owner && this.repo) {
      // Use HTTPS with token in URL
      this.repoUrl = `https://${this.token}@github.com/${this.owner}/${this.repo}.git`;
    } else {
      // Use provided URL or construct from owner/repo if available
      this.repoUrl =
        config.repoUrl ||
        (this.owner && this.repo ? `https://github.com/${this.owner}/${this.repo}.git` : "");
    }

    if (!this.repoUrl) {
      throw new Error("Repository URL is required for GitHub backend");
    }

    this.repoName = normalizeRepoName(this.repoUrl);
    this.sessionDb = new SessionDB();
  }

  /**
   * Get the backend type
   * @returns Backend type identifier
   */
  getType(): string {
    return "github";
  }

  /**
   * Ensure the base directory exists
   */
  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Get the session working directory path
   * @param session Session identifier
   * @returns Full path to the session working directory
   */
  private getSessionWorkdir(session: string): string {
    // Use the new path structure with sessions subdirectory
    return join(this.baseDir, this.repoName, "sessions", session);
  }

  /**
   * Clone the repository for a session
   * @param session Session identifier
   * @returns Clone result with workdir and session
   */
  async clone(session: string): Promise<CloneResult> {
    await this.ensureBaseDir();

    // Create the repo/sessions directory structure
    const sessionsDir = join(this.baseDir, this.repoName, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Get the workdir with sessions subdirectory
    const workdir = this.getSessionWorkdir(session);

    try {
      // Clone the repository
      await execAsync(`git clone ${this.repoUrl} ${workdir}`);

      return {
        workdir,
        session,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Provide more informative error messages for common GitHub issues
      if (error.message.includes("Authentication failed")) {
        throw new Error("GitHub authentication failed. Check your token or credentials.");
      } else if (error.message.includes("not found")) {
        throw new Error(
          `GitHub repository not found: ${this.owner}/${this.repo}. Check the owner and repo names.`
        );
      } else if (error.message.includes("timed out")) {
        throw new Error(
          "GitHub connection timed out. Check your network connection and try again."
        );
      } else {
        throw new Error(`Failed to clone GitHub repository: ${error.message}`);
      }
    }
  }

  /**
   * Create a branch in the repository
   * @param session Session identifier
   * @param branch Branch name
   * @returns Branch result with workdir and branch
   */
  async branch(session: string, branch: string): Promise<BranchResult> {
    await this.ensureBaseDir();
    const workdir = this.getSessionWorkdir(session);

    try {
      // Create the branch in the specified session's repo
      await execAsync(`git -C ${workdir} checkout -b ${branch}`);

      return {
        workdir,
        branch,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to create branch in GitHub repository: ${error.message}`);
    }
  }

  /**
   * Get repository status
   * @param session Session identifier
   * @returns Object with repository status information
   */
  async getStatus(session: string): Promise<RepoStatus> {
    const workdir = this.getSessionWorkdir(session);

    try {
      // Get current branch
      const { stdout: branchOutput } = await execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref HEAD`
      );
      const branch = branchOutput.trim();

      // Get ahead/behind counts
      let ahead = 0;
      let behind = 0;
      try {
        const { stdout: revListOutput } = await execAsync(
          `git -C ${workdir} rev-list --left-right --count @{upstream}...HEAD`
        );
        const counts = revListOutput.trim().split(/\s+/);
        if (counts && counts.length === 2) {
          behind = parseInt(counts[0] || "0", 10);
          ahead = parseInt(counts[1] || "0", 10);
        }
      } catch {
        // If no upstream branch is set, this will fail - that's okay
      }

      // Get modified files
      const { stdout: statusOutput } = await execAsync(`git -C ${workdir} status --porcelain`);
      const dirty = statusOutput.trim().length > 0;
      const modifiedFiles = statusOutput
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line: string) => ({
          status: line.substring(0, 2).trim(),
          file: line.substring(3),
        }));

      // Get remote information
      const { stdout: remoteOutput } = await execAsync(`git -C ${workdir} remote -v`);
      const remotesList = remoteOutput
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line: string) => {
          const parts = line.split("\t");
          if (parts.length < 2) return { name: "", url: "" };

          const name = parts[0] || ""; // Ensure name is always a string
          const urlInfo = parts[1] || "";
          const url = urlInfo.split(" ")[0] || "";

          return { name, url };
        });

      // Extract remote names for RepoStatus
      const remotes = remotesList.map((r) => r.name).filter((name) => name !== "");

      return {
        branch,
        ahead,
        behind,
        dirty,
        remotes,
        // Include GitHub specific information
        workdir,
        gitHubOwner: this.owner,
        gitHubRepo: this.repo,
        modifiedFiles,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to get GitHub repository status: ${error.message}`);
    }
  }

  /**
   * Get the repository path for a session
   * @param session Session identifier
   * @returns Full path to the repository
   */
  async getPath(session: string): Promise<string> {
    return this.getSessionWorkdir(session);
  }

  /**
   * Validate the repository configuration
   * @returns Promise that resolves with result if the repository is valid
   */
  async validate(): Promise<Result> {
    try {
      // Validate required fields
      if (!this.repoUrl) {
        return {
          success: false,
          message: "Repository URL is required for GitHub backend",
        };
      }

      // If owner/repo are provided, validate them
      if (this.owner && this.repo) {
        // Use curl to check if the repo exists without cloning
        const command = this.token
          ? `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: token ${this.token}" https://api.github.com/repos/${this.owner}/${this.repo}`
          : `curl -s -o /dev/null -w "%{http_code}" https://api.github.com/repos/${this.owner}/${this.repo}`;

        const { stdout } = await execAsync(command);
        const statusCode = parseInt(stdout.trim(), 10);

        if (statusCode === 404) {
          return {
            success: false,
            message: `GitHub repository not found: ${this.owner}/${this.repo}`,
          };
        } else if (statusCode === 401 || statusCode === 403) {
          return {
            success: false,
            message: "GitHub authentication failed. Check your token or credentials.",
          };
        } else if (statusCode !== 200) {
          return {
            success: false,
            message: `Failed to validate GitHub repository: HTTP ${statusCode}`,
          };
        }
      }

      return {
        success: true,
        message: "GitHub repository validated successfully",
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        success: false,
        message: `Failed to validate GitHub repository: ${error.message}`,
        error,
      };
    }
  }

  /**
   * Push changes to GitHub repository
   */
  async push(): Promise<Result> {
    // TODO: Implement GitHub push logic
    return {
      success: false,
      message: "Push operation not implemented for GitHub backend yet",
    };
  }

  /**
   * Pull changes from GitHub repository
   */
  async pull(): Promise<Result> {
    // TODO: Implement GitHub pull logic
    return {
      success: false,
      message: "Pull operation not implemented for GitHub backend yet",
    };
  }
}
