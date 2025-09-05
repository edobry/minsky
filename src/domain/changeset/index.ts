/**
 * Changeset Domain - Unified Abstraction for VCS Changesets
 *
 * Provides platform-agnostic interfaces for different VCS changeset concepts:
 * - GitHub Pull Requests
 * - GitLab Merge Requests
 * - Bitbucket Pull Requests
 * - Gerrit Changes
 * - Local Git Prepared Merge Commits
 */

// Core types and interfaces
export * from "./types";
export * from "./adapter-interface";

// Main service
export { ChangesetService, createChangesetService } from "./changeset-service";

// Platform adapters
export {
  LocalGitChangesetAdapter,
  LocalGitChangesetAdapterFactory,
} from "./adapters/local-git-adapter";
export { GitHubChangesetAdapter, GitHubChangesetAdapterFactory } from "./adapters/github-adapter";

// Future platform adapters (placeholder exports)
export { GitLabChangesetAdapter, GitLabChangesetAdapterFactory } from "./adapters/gitlab-adapter";
export {
  BitbucketChangesetAdapter,
  BitbucketChangesetAdapterFactory,
} from "./adapters/bitbucket-adapter";

/**
 * Factory function to create a changeset service with auto-detection
 * Uses existing repository backend detection to determine platform
 */
export async function createChangesetServiceFromRepository(
  repositoryUrl: string,
  workdir?: string
): Promise<ChangesetService> {
  return await createChangesetService(repositoryUrl, workdir);
}

/**
 * Utility function to determine changeset platform from repository URL
 */
export function detectChangesetPlatform(
  repositoryUrl: string
): import("./types").ChangesetPlatform {
  if (repositoryUrl.includes("github.com")) {
    return "github-pr";
  } else if (repositoryUrl.includes("gitlab.com") || repositoryUrl.includes("gitlab.")) {
    return "gitlab-mr";
  } else if (repositoryUrl.includes("bitbucket.org") || repositoryUrl.includes("bitbucket.")) {
    return "bitbucket-pr";
  } else if (repositoryUrl.includes("gerrit")) {
    return "gerrit-change";
  } else {
    return "local-git";
  }
}
