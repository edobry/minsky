/**
 * Local Git Changeset Adapter
 *
 * Implements changeset abstraction for local git repositories using
 * the existing prepared merge commit workflow (pr/ branches).
 */

import type {
  ChangesetAdapter,
  ChangesetAdapterFactory,
  ChangesetDetails,
  ChangesetFeature,
} from "../adapter-interface";

import type {
  Changeset,
  ChangesetListOptions,
  ChangesetSearchOptions,
  CreateChangesetOptions,
  CreateChangesetResult,
  MergeChangesetResult,
  ChangesetPlatform,
} from "../types";

import { createRepositoryBackend, RepositoryBackendType } from "../../repository/index";
import type { RepositoryBackend } from "../../repository/index";
import { createSessionProvider } from "../../session/index";
import { MinskyError, getErrorMessage } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { execSync } from "child_process";

/**
 * Local Git changeset adapter that maps pr/ branch workflow to changeset abstraction
 */
export class LocalGitChangesetAdapter implements ChangesetAdapter {
  readonly platform: ChangesetPlatform = "local-git";
  readonly name = "Local Git (Prepared Merge Commits)";

  private repositoryBackend: RepositoryBackend;
  private sessionProvider = createSessionProvider();

  constructor(
    private repositoryUrl: string,
    private workdir?: string
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      // Initialize repository backend if not done
      if (!this.repositoryBackend) {
        const config = {
          type: RepositoryBackendType.LOCAL,
          repoUrl: this.repositoryUrl,
        };
        this.repositoryBackend = await createRepositoryBackend(config);
      }

      // Check if this is a git repository
      const status = await this.repositoryBackend.getStatus();
      return status && typeof status === "object";
    } catch (error) {
      log.debug("Local git adapter not available", { error: getErrorMessage(error) });
      return false;
    }
  }

  /**
   * List all pr/ branches as changesets
   */
  async list(options?: ChangesetListOptions): Promise<Changeset[]> {
    try {
      const workdir = this.workdir || this.repositoryUrl;

      // Get all pr/ branches
      const branchesOutput = execSync("git branch -a", {
        cwd: workdir,
        encoding: "utf8",
      });

      const prBranches = branchesOutput
        .split("\n")
        .map((line) => line.trim().replace(/^\*\s*/, ""))
        .filter((branch) => branch.startsWith("pr/"))
        .map((branch) => branch.replace(/^origin\//, ""));

      const changesets: Changeset[] = [];

      for (const prBranch of prBranches) {
        const changeset = await this.buildChangesetFromBranch(prBranch, workdir);
        if (changeset) {
          // Apply filters
          if (options?.status && !options.status.includes(changeset.status)) {
            continue;
          }
          if (options?.author && changeset.author.username !== options.author) {
            continue;
          }
          if (options?.targetBranch && changeset.targetBranch !== options.targetBranch) {
            continue;
          }

          changesets.push(changeset);
        }
      }

      // Apply limit
      if (options?.limit) {
        changesets.splice(options.limit);
      }

      return changesets;
    } catch (error) {
      throw new MinskyError(`Failed to list local git changesets: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Get a specific changeset by pr/ branch name
   */
  async get(id: string): Promise<Changeset | null> {
    try {
      const workdir = this.workdir || this.repositoryUrl;
      const prBranch = id.startsWith("pr/") ? id : `pr/${id}`;

      // Check if branch exists
      try {
        execSync(`git show-ref --verify --quiet refs/heads/${prBranch}`, {
          cwd: workdir,
        });
      } catch {
        // Branch doesn't exist
        return null;
      }

      return await this.buildChangesetFromBranch(prBranch, workdir);
    } catch (error) {
      log.debug(`Failed to get changeset ${id}`, { error: getErrorMessage(error) });
      return null;
    }
  }

  /**
   * Search changesets by commit messages and branch names
   */
  async search(options: ChangesetSearchOptions): Promise<Changeset[]> {
    const allChangesets = await this.list(options);

    if (!options.query) return allChangesets;

    const query = options.query.toLowerCase();

    return allChangesets.filter((changeset) => {
      if (options.searchTitle !== false && changeset.title.toLowerCase().includes(query)) {
        return true;
      }
      if (
        options.searchDescription !== false &&
        changeset.description.toLowerCase().includes(query)
      ) {
        return true;
      }
      if (options.searchCommits !== false) {
        const hasMatchingCommit = changeset.commits.some((commit) =>
          commit.message.toLowerCase().includes(query)
        );
        if (hasMatchingCommit) return true;
      }

      return false;
    });
  }

  /**
   * Create a new changeset using the prepared merge commit workflow
   */
  async create(options: CreateChangesetOptions): Promise<CreateChangesetResult> {
    if (!this.repositoryBackend) {
      await this.isAvailable(); // Initialize backend
    }

    // Use existing repository backend PR creation
    const prInfo = await this.repositoryBackend.createPullRequest(
      options.title,
      options.description,
      options.sourceBranch || "HEAD",
      options.targetBranch || "main",
      options.sessionName
    );

    // Convert PRInfo to changeset
    const changeset = await this.get(prInfo.number.toString());
    if (!changeset) {
      throw new MinskyError("Failed to retrieve created changeset");
    }

    return {
      changeset,
      platformId: prInfo.number,
      url: prInfo.url,
    };
  }

  /**
   * Update changeset (limited support for local git)
   */
  async update(id: string, updates: Partial<CreateChangesetOptions>): Promise<Changeset> {
    // For local git, we can update the prepared merge commit
    // This is mainly useful for title/description updates
    if (updates.title || updates.description) {
      // Update would require updating the prepared merge commit message
      // For now, just return current changeset
      log.warn("Local git changeset updates have limited support");
    }

    const changeset = await this.get(id);
    if (!changeset) {
      throw new MinskyError(`Changeset not found: ${id}`);
    }

    return changeset;
  }

  /**
   * Merge changeset using existing repository backend
   */
  async merge(
    id: string,
    options?: { deleteSourceBranch?: boolean }
  ): Promise<MergeChangesetResult> {
    if (!this.repositoryBackend) {
      await this.isAvailable(); // Initialize backend
    }

    // Use existing repository backend merge
    const mergeInfo = await this.repositoryBackend.mergePullRequest(id);

    return {
      success: true,
      mergeCommitSha: mergeInfo.commitHash,
      mergedAt: new Date(mergeInfo.mergeDate),
      mergedBy: mergeInfo.mergedBy,
      deletedBranch: options?.deleteSourceBranch,
    };
  }

  /**
   * Get detailed changeset information
   */
  async getDetails(id: string): Promise<ChangesetDetails> {
    const changeset = await this.get(id);
    if (!changeset) {
      throw new MinskyError(`Changeset not found: ${id}`);
    }

    // Get diff information from git
    const workdir = this.workdir || this.repositoryUrl;
    const prBranch = id.startsWith("pr/") ? id : `pr/${id}`;

    try {
      // Get diff stats
      const diffStats = execSync(`git diff --stat main...${prBranch}`, {
        cwd: workdir,
        encoding: "utf8",
      });

      // Get full diff
      const fullDiff = execSync(`git diff main...${prBranch}`, {
        cwd: workdir,
        encoding: "utf8",
      });

      // Parse stats (simple parsing)
      const statsMatch = diffStats.match(
        /(\d+) files? changed(?:, (\d+) insertions?)?(?:, (\d+) deletions?)?/
      );
      const filesChanged = statsMatch ? parseInt(statsMatch[1]) : 0;
      const additions = statsMatch && statsMatch[2] ? parseInt(statsMatch[2]) : 0;
      const deletions = statsMatch && statsMatch[3] ? parseInt(statsMatch[3]) : 0;

      return {
        ...changeset,
        files: [], // TODO: Parse individual file changes
        diffStats: {
          filesChanged,
          additions,
          deletions,
        },
        fullDiff,
      };
    } catch (error) {
      log.debug(`Failed to get diff details for ${id}`, { error: getErrorMessage(error) });

      // Return basic details without diff info
      return {
        ...changeset,
        files: [],
        diffStats: { filesChanged: 0, additions: 0, deletions: 0 },
      };
    }
  }

  /**
   * Check support for specific features
   */
  supportsFeature(feature: ChangesetFeature): boolean {
    switch (feature) {
      case "approval_workflow":
        return true; // We have session approval workflow
      case "auto_merge":
        return true; // Supported via session approve
      case "branch_protection":
        return false; // Not implemented for local git
      case "status_checks":
        return false; // Not implemented for local git
      case "file_comments":
        return false; // Not supported in local git workflow
      case "suggested_changes":
        return false; // Not supported in local git workflow
      case "draft_changesets":
        return false; // Not implemented for local git
      case "assignee_management":
        return false; // Not applicable to local git
      case "label_management":
        return false; // Not applicable to local git
      case "milestone_tracking":
        return false; // Not applicable to local git
      default:
        return false;
    }
  }

  /**
   * Build a changeset object from a pr/ branch
   */
  private async buildChangesetFromBranch(
    prBranch: string,
    workdir: string
  ): Promise<Changeset | null> {
    try {
      // Get session name from branch
      const sessionName = prBranch.replace(/^pr\//, "");

      // Try to get session info
      let taskId: string | undefined;
      let title = `Changes in ${sessionName}`;
      let description = "Local git changeset";

      try {
        const session = await this.sessionProvider.getSession(sessionName);
        if (session) {
          taskId = session.taskId;
          title = `Session: ${sessionName}`;
          if (taskId) {
            description = `Changes for task ${taskId}`;
          }
        }
      } catch {
        // Session info not available, use defaults
      }

      // Get commit information
      const commits = await this.getCommitsForBranch(prBranch, workdir);

      // Get author info from most recent commit
      const latestCommit = commits[0];
      const author = latestCommit
        ? {
            username: latestCommit.author.username,
            displayName: latestCommit.author.username,
            email: latestCommit.author.email,
          }
        : {
            username: "unknown",
            email: "unknown@localhost",
          };

      // Determine status
      let status: "open" | "merged" | "closed" = "open";
      try {
        // Check if branch is merged
        const mergeBase = execSync(`git merge-base main ${prBranch}`, {
          cwd: workdir,
          encoding: "utf8",
        });
        const branchTip = execSync(`git rev-parse ${prBranch}`, {
          cwd: workdir,
          encoding: "utf8",
        });

        if (mergeBase.trim() === branchTip.trim()) {
          status = "merged";
        }
      } catch {
        // Branch comparison failed, assume open
      }

      // Get creation date from first commit
      const createdAt = commits.length > 0 ? commits[commits.length - 1].timestamp : new Date();
      const updatedAt = commits.length > 0 ? commits[0].timestamp : new Date();

      return {
        id: prBranch,
        platform: "local-git",
        title,
        description,
        author,
        status,
        targetBranch: "main", // TODO: Could be configurable
        sourceBranch: prBranch,
        commits,
        reviews: [], // Local git doesn't have formal reviews
        comments: [], // Local git doesn't have comments
        createdAt,
        updatedAt,
        sessionName,
        taskId,
        metadata: {
          local: {
            prBranch,
            baseBranch: "main",
            sessionName,
            isPrepared: true, // Our workflow always creates prepared commits
            mergeCommitReady: status === "open", // Ready if not already merged
          },
        },
      };
    } catch (error) {
      log.debug(`Failed to build changeset from branch ${prBranch}`, {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  /**
   * Get commits for a branch relative to main
   */
  private async getCommitsForBranch(
    branch: string,
    workdir: string
  ): Promise<import("../types").ChangesetCommit[]> {
    try {
      // Get commits that are in this branch but not in main
      const commitOutput = execSync(`git log main..${branch} --format="%H|%s|%an|%ae|%ci"`, {
        cwd: workdir,
        encoding: "utf8",
      });

      const commits = commitOutput
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const [sha, message, authorName, authorEmail, timestamp] = line.split("|");

          // Get files changed in this commit
          const filesOutput = execSync(`git show --name-only --format="" ${sha}`, {
            cwd: workdir,
            encoding: "utf8",
          });

          const filesChanged = filesOutput
            .trim()
            .split("\n")
            .filter((file) => file.trim());

          return {
            sha,
            message,
            author: {
              username: authorName,
              email: authorEmail,
            },
            timestamp: new Date(timestamp),
            filesChanged,
          };
        });

      return commits;
    } catch (error) {
      log.debug(`Failed to get commits for branch ${branch}`, {
        error: getErrorMessage(error),
      });
      return [];
    }
  }
}

/**
 * Factory for creating local git changeset adapters
 */
export class LocalGitChangesetAdapterFactory implements ChangesetAdapterFactory {
  readonly platform: ChangesetPlatform = "local-git";

  /**
   * Check if this factory can handle the repository
   */
  canHandle(repositoryUrl: string): boolean {
    // Can handle any local path or git URL that's not a known hosted platform
    return (
      !repositoryUrl.includes("github.com") &&
      !repositoryUrl.includes("gitlab.com") &&
      !repositoryUrl.includes("bitbucket.org")
    );
  }

  /**
   * Create a local git changeset adapter
   */
  async createAdapter(repositoryUrl: string, config?: any): Promise<ChangesetAdapter> {
    return new LocalGitChangesetAdapter(repositoryUrl, config?.workdir);
  }
}
