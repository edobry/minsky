/**
 * GitHub Changeset Adapter
 *
 * Implements changeset abstraction for GitHub repositories using
 * the existing GitHub repository backend and GitHub API.
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
  ChangesetCommit,
  ChangesetReview,
  ChangesetComment,
  ChangesetPlatform,
  ReviewStatus,
} from "../types";

import { createRepositoryBackend, RepositoryBackendType } from "../../repository/index";
import type { RepositoryBackend } from "../../repository/index";
import { extractGitHubInfoFromUrl } from "../../session/repository-backend-detection";
import { MinskyError, getErrorMessage } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { Octokit } from "@octokit/rest";

/**
 * GitHub changeset adapter that maps GitHub PRs to changeset abstraction
 */
export class GitHubChangesetAdapter implements ChangesetAdapter {
  readonly platform: ChangesetPlatform = "github-pr";
  readonly name = "GitHub Pull Requests";

  private repositoryBackend: RepositoryBackend;
  private octokit: Octokit;
  private owner?: string;
  private repo?: string;

  constructor(
    private repositoryUrl: string,
    private config?: { token?: string; workdir?: string }
  ) {
    // Extract GitHub owner/repo from URL
    const githubInfo = extractGitHubInfoFromUrl(repositoryUrl);
    this.owner = githubInfo?.owner;
    this.repo = githubInfo?.repo;

    // Initialize Octokit
    this.octokit = new Octokit({
      auth: config?.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.owner || !this.repo) {
        return false;
      }

      // Test GitHub API access
      await this.octokit.rest.repos.get({
        owner: this.owner,
        repo: this.repo,
      });

      // Initialize repository backend if not done
      if (!this.repositoryBackend) {
        const backendConfig = {
          type: RepositoryBackendType.GITHUB,
          repoUrl: this.repositoryUrl,
          github: {
            owner: this.owner,
            repo: this.repo,
            token: this.config?.token,
          },
        };
        this.repositoryBackend = await createRepositoryBackend(backendConfig);
      }

      return true;
    } catch (error) {
      log.debug("GitHub adapter not available", {
        error: getErrorMessage(error),
        owner: this.owner,
        repo: this.repo,
      });
      return false;
    }
  }

  /**
   * List GitHub pull requests as changesets
   */
  async list(options?: ChangesetListOptions): Promise<Changeset[]> {
    if (!this.owner || !this.repo) {
      throw new MinskyError("GitHub owner and repo must be configured");
    }

    try {
      // Convert changeset status to GitHub PR state
      let state: "open" | "closed" | "all" = "open";
      if (options?.status) {
        const statuses = Array.isArray(options.status) ? options.status : [options.status];
        if (statuses.includes("merged") || statuses.includes("closed")) {
          state = statuses.includes("open") ? "all" : "closed";
        }
      }

      const { data: pulls } = await this.octokit.rest.pulls.list({
        owner: this.owner,
        repo: this.repo,
        state,
        per_page: options?.limit || 30,
      });

      const changesets: Changeset[] = [];

      for (const pr of pulls) {
        // Apply additional filters
        if (options?.author && pr.user?.login !== options.author) {
          continue;
        }
        if (options?.targetBranch && pr.base.ref !== options.targetBranch) {
          continue;
        }

        const changeset = await this.buildChangesetFromPR(pr);
        changesets.push(changeset);
      }

      return changesets;
    } catch (error) {
      throw new MinskyError(`Failed to list GitHub changesets: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Get a specific GitHub PR as a changeset
   */
  async get(id: string): Promise<Changeset | null> {
    if (!this.owner || !this.repo) {
      throw new MinskyError("GitHub owner and repo must be configured");
    }

    try {
      const pullNumber = parseInt(id);
      if (isNaN(pullNumber)) {
        return null;
      }

      const { data: pr } = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
      });

      return await this.buildChangesetFromPR(pr);
    } catch (error) {
      if ((error as any).status === 404) {
        return null;
      }
      throw new MinskyError(`Failed to get GitHub changeset ${id}: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Search GitHub PRs
   */
  async search(options: ChangesetSearchOptions): Promise<Changeset[]> {
    if (!this.owner || !this.repo) {
      throw new MinskyError("GitHub owner and repo must be configured");
    }

    try {
      // Build GitHub search query
      let searchQuery = `repo:${this.owner}/${this.repo} type:pr`;

      if (options.query) {
        if (options.searchTitle !== false) {
          searchQuery += ` "${options.query}" in:title`;
        }
        if (options.searchDescription !== false) {
          searchQuery += ` "${options.query}" in:body`;
        }
        if (options.searchComments !== false) {
          searchQuery += ` "${options.query}" in:comments`;
        }
      }

      if (options.status) {
        const statuses = Array.isArray(options.status) ? options.status : [options.status];
        if (
          statuses.includes("open") &&
          !statuses.includes("merged") &&
          !statuses.includes("closed")
        ) {
          searchQuery += " state:open";
        } else if (
          !statuses.includes("open") &&
          (statuses.includes("merged") || statuses.includes("closed"))
        ) {
          searchQuery += " state:closed";
        }
      }

      const { data } = await this.octokit.rest.search.issuesAndPullRequests({
        q: searchQuery,
        per_page: options.limit || 30,
      });

      const changesets: Changeset[] = [];

      for (const item of data.items) {
        if (item.pull_request) {
          // Get full PR data
          const changeset = await this.get(item.number.toString());
          if (changeset) {
            changesets.push(changeset);
          }
        }
      }

      return changesets;
    } catch (error) {
      throw new MinskyError(`Failed to search GitHub changesets: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Create a GitHub PR using existing repository backend
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
      options.sessionName,
      options.isDraft
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
   * Update a GitHub PR using existing repository backend
   */
  async update(id: string, updates: Partial<CreateChangesetOptions>): Promise<Changeset> {
    if (!this.repositoryBackend) {
      await this.isAvailable();
    }

    // Use existing repository backend update method
    const prInfo = await this.repositoryBackend.updatePullRequest({
      prIdentifier: parseInt(id),
      title: updates.title,
      body: updates.description,
      session: updates.sessionName,
    });

    const changeset = await this.get(id);
    if (!changeset) {
      throw new MinskyError(`Failed to retrieve updated changeset ${id}`);
    }

    return changeset;
  }

  /**
   * Merge a GitHub PR using existing repository backend
   */
  async merge(
    id: string,
    options?: { deleteSourceBranch?: boolean }
  ): Promise<MergeChangesetResult> {
    if (!this.repositoryBackend) {
      await this.isAvailable();
    }

    const mergeInfo = await this.repositoryBackend.mergePullRequest(parseInt(id));

    return {
      success: true,
      mergeCommitSha: mergeInfo.commitHash,
      mergedAt: new Date(mergeInfo.mergeDate),
      mergedBy: mergeInfo.mergedBy,
      deletedBranch: options?.deleteSourceBranch,
    };
  }

  /**
   * Approve a GitHub PR using existing repository backend
   */
  async approve(id: string, comment?: string): Promise<{ success: boolean; reviewId: string }> {
    if (!this.repositoryBackend) {
      await this.isAvailable();
    }

    const approvalInfo = await this.repositoryBackend.approvePullRequest(parseInt(id), comment);

    return {
      success: true,
      reviewId: approvalInfo.reviewId.toString(),
    };
  }

  /**
   * Get detailed changeset information including diffs
   */
  async getDetails(id: string): Promise<ChangesetDetails> {
    const changeset = await this.get(id);
    if (!changeset) {
      throw new MinskyError(`Changeset not found: ${id}`);
    }

    if (!this.repositoryBackend) {
      await this.isAvailable();
    }

    // Get diff information from repository backend
    const diffInfo = await this.repositoryBackend.getPullRequestDiff({
      prIdentifier: parseInt(id),
    });

    return {
      ...changeset,
      files: [], // TODO: Parse diff into file change objects
      diffStats: {
        filesChanged: diffInfo.stats?.filesChanged || 0,
        additions: diffInfo.stats?.insertions || 0,
        deletions: diffInfo.stats?.deletions || 0,
      },
      fullDiff: diffInfo.diff,
    };
  }

  /**
   * Check GitHub-specific feature support
   */
  supportsFeature(feature: ChangesetFeature): boolean {
    switch (feature) {
      case "approval_workflow":
        return true;
      case "draft_changesets":
        return true;
      case "file_comments":
        return true;
      case "suggested_changes":
        return true;
      case "auto_merge":
        return true;
      case "branch_protection":
        return true;
      case "status_checks":
        return true;
      case "assignee_management":
        return true;
      case "label_management":
        return true;
      case "milestone_tracking":
        return true;
      default:
        return false;
    }
  }

  /**
   * Build a changeset from a GitHub PR object
   */
  private async buildChangesetFromPR(pr: any): Promise<Changeset> {
    // Get reviews and comments
    const [reviews, comments] = await Promise.all([
      this.getPRReviews(pr.number),
      this.getPRComments(pr.number),
    ]);

    // Get commits
    const commits = await this.getPRCommits(pr.number);

    // Map GitHub PR state to changeset status
    let status: "open" | "merged" | "closed" | "draft";
    if (pr.draft) {
      status = "draft";
    } else if (pr.merged_at) {
      status = "merged";
    } else if (pr.state === "closed") {
      status = "closed";
    } else {
      status = "open";
    }

    return {
      id: pr.number.toString(),
      platform: "github-pr",
      title: pr.title,
      description: pr.body || "",
      author: {
        username: pr.user.login,
        displayName: pr.user.name,
        email: pr.user.email,
      },
      status,
      targetBranch: pr.base.ref,
      sourceBranch: pr.head.ref,
      commits,
      reviews,
      comments,
      createdAt: new Date(pr.created_at),
      updatedAt: new Date(pr.updated_at),
      metadata: {
        github: {
          number: pr.number,
          url: pr.url,
          htmlUrl: pr.html_url,
          apiUrl: pr.url,
          isDraft: pr.draft,
          isMergeable: pr.mergeable,
          mergeableState: pr.mergeable_state,
          headSha: pr.head.sha,
          baseSha: pr.base.sha,
        },
      },
    };
  }

  /**
   * Get reviews for a GitHub PR
   */
  private async getPRReviews(prNumber: number): Promise<ChangesetReview[]> {
    try {
      const { data: reviews } = await this.octokit.rest.pulls.listReviews({
        owner: this.owner!,
        repo: this.repo!,
        pull_number: prNumber,
      });

      return Promise.all(
        reviews.map(async (review) => {
          // Get review comments
          const { data: comments } = await this.octokit.rest.pulls.listCommentsForReview({
            owner: this.owner!,
            repo: this.repo!,
            pull_number: prNumber,
            review_id: review.id,
          });

          // Map GitHub review state to our review status
          let status: ReviewStatus;
          switch (review.state) {
            case "APPROVED":
              status = "approved";
              break;
            case "CHANGES_REQUESTED":
              status = "changes_requested";
              break;
            case "DISMISSED":
              status = "dismissed";
              break;
            default:
              status = "pending";
          }

          return {
            id: review.id.toString(),
            author: {
              username: review.user?.login || "unknown",
              displayName: review.user?.name,
            },
            status,
            summary: review.body || undefined,
            comments: comments.map((comment) => ({
              id: comment.id.toString(),
              author: {
                username: comment.user?.login || "unknown",
                displayName: comment.user?.name,
              },
              content: comment.body,
              filePath: comment.path,
              startLine: comment.start_line || comment.line,
              endLine: comment.line,
              createdAt: new Date(comment.created_at),
              isResolved: comment.resolved,
            })),
            submittedAt: new Date(review.submitted_at || review.created_at),
          };
        })
      );
    } catch (error) {
      log.debug(`Failed to get reviews for PR ${prNumber}`, { error: getErrorMessage(error) });
      return [];
    }
  }

  /**
   * Get general comments for a GitHub PR
   */
  private async getPRComments(prNumber: number): Promise<ChangesetComment[]> {
    try {
      const { data: comments } = await this.octokit.rest.issues.listComments({
        owner: this.owner!,
        repo: this.repo!,
        issue_number: prNumber,
      });

      return comments.map((comment) => ({
        id: comment.id.toString(),
        author: {
          username: comment.user?.login || "unknown",
          displayName: comment.user?.name,
        },
        content: comment.body || "",
        createdAt: new Date(comment.created_at),
        updatedAt: comment.updated_at ? new Date(comment.updated_at) : undefined,
        isMinimized: comment.minimized_reason !== null,
      }));
    } catch (error) {
      log.debug(`Failed to get comments for PR ${prNumber}`, { error: getErrorMessage(error) });
      return [];
    }
  }

  /**
   * Get commits for a GitHub PR
   */
  private async getPRCommits(prNumber: number): Promise<ChangesetCommit[]> {
    try {
      const { data: commits } = await this.octokit.rest.pulls.listCommits({
        owner: this.owner!,
        repo: this.repo!,
        pull_number: prNumber,
      });

      return commits.map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message,
        author: {
          username: commit.author?.login || commit.commit.author?.name || "unknown",
          email: commit.commit.author?.email || "",
        },
        timestamp: new Date(commit.commit.author?.date || ""),
        filesChanged: commit.files?.map((file) => file.filename) || [],
      }));
    } catch (error) {
      log.debug(`Failed to get commits for PR ${prNumber}`, { error: getErrorMessage(error) });
      return [];
    }
  }
}

/**
 * Factory for creating GitHub changeset adapters
 */
export class GitHubChangesetAdapterFactory implements ChangesetAdapterFactory {
  readonly platform: ChangesetPlatform = "github-pr";

  /**
   * Check if this factory can handle the repository
   */
  canHandle(repositoryUrl: string): boolean {
    return repositoryUrl.includes("github.com");
  }

  /**
   * Create a GitHub changeset adapter
   */
  async createAdapter(repositoryUrl: string, config?: any): Promise<ChangesetAdapter> {
    return new GitHubChangesetAdapter(repositoryUrl, config);
  }
}
