import { execSync } from "child_process";
import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import {
  createRepositoryBackend,
  RepositoryBackendType,
  type RepositoryBackend,
  type RepositoryBackendConfig,
} from "../repository/index";

/**
 * Auto-detect repository backend type from git remote URL
 * Following KISS principle - simple detection based on immediate git remote URL
 */
export function detectRepositoryBackendType(workdir: string): RepositoryBackendType {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: workdir,
      encoding: "utf8",
    })
      .toString()
      .trim();

    // GitHub detection
    if (remoteUrl.includes("github.com")) {
      return RepositoryBackendType.GITHUB;
    }

    // GitLab detection (for future use)
    if (remoteUrl.includes("gitlab.com")) {
      return RepositoryBackendType.REMOTE; // Treat as remote for now
    }

    // Local repository detection
    if (remoteUrl.startsWith("/") || remoteUrl.startsWith("file://")) {
      return RepositoryBackendType.LOCAL;
    }

    // Default to remote for everything else
    return RepositoryBackendType.REMOTE;
  } catch (error) {
    log.debug("Failed to detect repository backend type", {
      workdir,
      error: getErrorMessage(error as any),
    });
    // Default to local if detection fails
    return RepositoryBackendType.LOCAL;
  }
}

/**
 * Create a repository backend instance based on auto-detection
 * Session commands can use this to get the appropriate backend for PR operations
 */
export async function createRepositoryBackendForSession(
  workdir: string
): Promise<RepositoryBackend> {
  const backendType = detectRepositoryBackendType(workdir);

  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: workdir,
      encoding: "utf8",
    })
      .toString()
      .trim();

    const config: RepositoryBackendConfig = {
      type: backendType,
      repoUrl: remoteUrl,
    };

    // Add GitHub-specific configuration if detected
    if (backendType === RepositoryBackendType.GITHUB) {
      const githubInfo = extractGitHubInfoFromUrl(remoteUrl);
      if (githubInfo) {
        config.github = {
          owner: githubInfo.owner,
          repo: githubInfo.repo,
        };
      }
    }

    return await createRepositoryBackend(config);
  } catch (error) {
    throw new Error(`Failed to create repository backend: ${getErrorMessage(error as any)}`);
  }
}

/**
 * Extract GitHub owner and repo from URL
 */
export function extractGitHubInfoFromUrl(
  remoteUrl: string
): { owner: string; repo: string } | null {
  try {
    // SSH: git@github.com:owner/repo.git
    // HTTPS: https://github.com/owner/repo.git
    const sshMatch = remoteUrl.match(/git@github\.com:([^\/]+)\/([^\.]+)/);
    const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/([^\/]+)\/([^\.]+)/);

    const match = sshMatch || httpsMatch;
    if (match && match[1] && match[2]) {
      return {
        owner: match[1],
        repo: match[2].replace(/\.git$/, ""), // Remove .git suffix
      };
    }

    return null;
  } catch (error) {
    log.debug("Failed to extract GitHub info from URL", {
      remoteUrl,
      error: getErrorMessage(error as any),
    });
    return null;
  }
}
