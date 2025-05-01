import { join } from "path";
import { mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { normalizeRepoName } from "./repo-utils";
import { SessionDB } from "./session";
import { execAsync } from "../utils/exec";
import { promises as fs } from "fs";

const execAsyncPromisify = promisify(exec);

export interface CloneOptions {
  repoUrl: string;
  session: string;
  branch?: string;
  taskId?: string;
}

export interface CloneResult {
  workdir: string;
  session: string;
}

export interface BranchOptions {
  repoPath: string;
  branch: string;
}

export interface BranchResult {
  workdir: string;
  branch: string;
}

export interface PrOptions {
  repoPath: string;
  branch: string;
  baseBranch?: string;
}

export interface PrResult {
  markdown: string;
}

export class GitService {
  private readonly sessionDb: SessionDB;

  constructor() {
    this.sessionDb = new SessionDB();
  }

  async clone(options: CloneOptions): Promise<string> {
    const { repoUrl, session, branch, taskId } = options;

    // Get the repository name
    const repoName = normalizeRepoName(repoUrl);

    // Get the session repository path
    const repoPath = await this.sessionDb.getNewSessionRepoPath(repoName, session);

    // Create the parent directory
    await fs.mkdir(join(repoPath, ".."), { recursive: true });

    // Clone the repository
    await execAsync(`git clone ${repoUrl} ${repoPath}`);

    // Add session to database
    await this.sessionDb.addSession({
      session,
      repoUrl,
      repoName,
      branch,
      createdAt: new Date().toISOString(),
      taskId,
      repoPath
    });

    // If branch is specified, create and switch to it
    if (branch) {
      await this.branch({ repoPath, branch });
    }

    return repoPath;
  }

  async branch(options: BranchOptions): Promise<void> {
    const { repoPath, branch } = options;

    // Create and switch to the branch
    await execAsync(`git checkout -b ${branch}`, { cwd: repoPath });
  }

  async pr(options: PrOptions): Promise<void> {
    const { repoPath, branch, baseBranch } = options;

    // Get the current branch if not provided
    const currentBranch = branch || (await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath })).stdout.trim();

    // Determine base branch
    let base = baseBranch;
    if (!base) {
      // Try to find the default branch
      try {
        const { stdout } = await execAsync("git remote show origin", { cwd: repoPath });
        const match = stdout.match(/HEAD branch: (.+)/);
        if (match) {
          base = match[1];
        }
      } catch (err) {
        // If remote show fails, try common default branch names
        for (const defaultBranch of ["main", "master"]) {
          try {
            await execAsync(`git rev-parse --verify origin/${defaultBranch}`, { cwd: repoPath });
            base = defaultBranch;
            break;
          } catch {
            // Branch doesn't exist, try next one
          }
        }
      }
    }

    if (!base) {
      throw new Error("Could not determine base branch");
    }

    // Push the branch
    await execAsync(`git push -u origin ${currentBranch}`, { cwd: repoPath });

    // Print PR creation instructions
    console.log(`\nTo create a PR, visit your repository's web interface and create a PR with:
- Base branch: ${base}
- Compare branch: ${currentBranch}`);
  }
}
