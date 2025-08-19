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
 * Detect repository backend type directly from a repository URL
 * More efficient than detectRepositoryBackendType when you already have the URL
 */
export function detectRepositoryBackendTypeFromUrl(repoUrl: string): RepositoryBackendType {
  // GitHub detection
  if (repoUrl.includes("github.com")) {
    return RepositoryBackendType.GITHUB;
  }

  // GitLab detection (for future use)
  if (repoUrl.includes("gitlab.com")) {
    return RepositoryBackendType.REMOTE; // Treat as remote for now
  }

  // Local repository detection
  if (repoUrl.startsWith("/") || repoUrl.startsWith("file://")) {
    return RepositoryBackendType.LOCAL;
  }

  // Default to remote for everything else
  return RepositoryBackendType.REMOTE;
}

/**
 * Auto-detect repository backend type from git remote URL
 * Following KISS principle - simple detection based on immediate git remote URL
 * Use detectRepositoryBackendTypeFromUrl() if you already have the URL
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
 * Unified resolver for repository URL and backend type
 *
 * Behavior:
 * - If repoParam provided, use it and detect backend via URL
 * - Otherwise, read configuration `repository.default_repo_backend` (default to "github")
 * - If default is github, auto-detect GitHub remote URL from current working directory
 * - Else, fall back to detecting current git repo path; if that fails, use process.cwd()
 */
export async function resolveRepositoryAndBackend(options?: {
  repoParam?: string;
  cwd?: string;
}): Promise<{ repoUrl: string; backendType: RepositoryBackendType }> {
  const cwd = options?.cwd || process.cwd();

  if (options?.repoParam) {
    const repoUrl = options.repoParam;
    return { repoUrl, backendType: detectRepositoryBackendTypeFromUrl(repoUrl) };
  }

  // Lazy import to avoid cycles
  let defaultBackend: string | undefined;
  try {
    const { getConfiguration } = await import("../configuration/index");
    const cfg = getConfiguration();
    defaultBackend = cfg.repository?.default_repo_backend || "github";
  } catch (_err) {
    defaultBackend = "github";
  }

  if (defaultBackend === "github") {
    try {
      const remoteUrl = execSync("git remote get-url origin", { cwd, encoding: "utf8" })
        .toString()
        .trim();
      if (!remoteUrl.includes("github.com")) {
        throw new Error(
          "Default repository backend is GitHub, but current directory does not have a GitHub remote."
        );
      }
      return { repoUrl: remoteUrl, backendType: RepositoryBackendType.GITHUB };
    } catch (error) {
      throw new Error(
        `Default repository backend is GitHub, but could not detect GitHub remote: ${getErrorMessage(
          error as any
        )}`
      );
    }
  }

  // Non-GitHub default: attempt to resolve current git repo path
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8" })
      .toString()
      .trim();
    return { repoUrl: toplevel, backendType: RepositoryBackendType.LOCAL };
  } catch (_error) {
    // Final fallback: use cwd and detect by URL rules
    return { repoUrl: cwd, backendType: detectRepositoryBackendTypeFromUrl(cwd) };
  }
}

/**
 * Create a repository backend instance for a session using the stored repoUrl
 * More efficient than createRepositoryBackendForSession when you have the repoUrl
 */
export async function createRepositoryBackendFromSessionUrl(
  repoUrl: string,
  workdir: string
): Promise<RepositoryBackend> {
  const backendType = detectRepositoryBackendTypeFromUrl(repoUrl);

  const config: RepositoryBackendConfig = {
    type: backendType,
    repoUrl: repoUrl,
  };

  // Add GitHub-specific configuration if detected
  if (backendType === RepositoryBackendType.GITHUB) {
    const githubInfo = extractGitHubInfoFromUrl(repoUrl);
    if (githubInfo) {
      config.github = {
        owner: githubInfo.owner,
        repo: githubInfo.repo,
      };
    }
  }

  return await createRepositoryBackend(config, workdir);
}

/**
 * Create a repository backend instance based on auto-detection
 * Session commands can use this to get the appropriate backend for PR operations
 * Use createRepositoryBackendFromSessionUrl() if you already have the repoUrl
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
