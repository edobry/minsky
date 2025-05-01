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

    // Calculate the repo path directly
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    const baseDir = join(xdgStateHome, "minsky", "git");
    const repoPath = join(baseDir, repoName, "sessions", session);

    // Create the parent directory
    await fs.mkdir(join(repoPath, ".."), { recursive: true });

    // Handle local paths by converting to file:// URLs if needed
    let cloneUrl = repoUrl;
    if (cloneUrl.startsWith("/") && !cloneUrl.startsWith("file://")) {
      cloneUrl = `file://${cloneUrl}`;
    }

    // Clone the repository
    await execAsync(`git clone ${cloneUrl} ${repoPath}`);

    // Create a session record
    const sessionRecord = {
      session,
      repoUrl,
      repoName,
      branch,
      taskId,
      createdAt: new Date().toISOString(),
      repoPath
    };

    try {
      // Add session to database
      const sessionDB = new SessionDB();
      await sessionDB.addSession(sessionRecord);
    } catch (err) {
      console.warn("Failed to add session to database:", err);
    }

    // If a branch was specified, check it out
    if (branch) {
      await execAsync(`git -C ${repoPath} checkout -b ${branch}`);
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

    // If still no base branch, this may be a new repo with only one branch
    // In this case, we'll just use a placeholder
    if (!base) {
      console.log("Could not determine base branch. This may be a new repository.");
      base = "main"; // Default to main as a placeholder
    }

    // Push the branch
    await execAsync(`git push -u origin ${currentBranch}`, { cwd: repoPath });

    // Print PR creation instructions
    console.log(`\nTo create a PR, visit your repository's web interface and create a PR with:
- Base branch: ${base}
- Compare branch: ${currentBranch}`);
  }
}
