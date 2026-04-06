import { execSync as defaultExecSync } from "child_process";
import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import {
  createRepositoryBackend,
  RepositoryBackendType,
  type RepositoryBackend,
  type RepositoryBackendConfig,
} from "../repository/index";

/**
 * Dependencies for repository backend detection, injectable for testing
 */
export interface RepositoryBackendDetectionDeps {
  execSync: (cmd: string, opts?: { cwd?: string; encoding?: string }) => string | Buffer;
  getConfiguration?: () => object;
}

const defaultDeps: RepositoryBackendDetectionDeps = {
  execSync: defaultExecSync as RepositoryBackendDetectionDeps["execSync"],
};

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
 * @deprecated Use init-time detection via `resolveRepositoryFromGitRemote` instead
 */
export function detectRepositoryBackendType(
  workdir: string,
  deps: RepositoryBackendDetectionDeps = defaultDeps
): RepositoryBackendType {
  try {
    const remoteUrl = deps
      .execSync("git remote get-url origin", {
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
      error: getErrorMessage(error),
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
 * @deprecated Use `getRepositoryBackendFromConfig()` instead
 */
export async function resolveRepositoryAndBackend(
  options?: {
    repoParam?: string;
    cwd?: string;
  },
  deps: RepositoryBackendDetectionDeps = defaultDeps
): Promise<{ repoUrl: string; backendType: RepositoryBackendType }> {
  const cwd = options?.cwd || process.cwd();

  if (options?.repoParam) {
    const repoUrl = options.repoParam;
    return { repoUrl, backendType: detectRepositoryBackendTypeFromUrl(repoUrl) };
  }

  // Use injected getConfiguration or lazy import to avoid cycles
  let defaultBackend: string | undefined;
  try {
    let getConfiguration: () => object;
    if (deps.getConfiguration) {
      getConfiguration = deps.getConfiguration;
    } else {
      const mod = await import("../configuration/index");
      getConfiguration = mod.getConfiguration;
    }
    const cfg = getConfiguration() as { repository?: { default_repo_backend?: string } };
    defaultBackend = cfg.repository?.default_repo_backend || "github";
  } catch (_err) {
    defaultBackend = "github";
  }

  if (defaultBackend === "github") {
    try {
      const remoteUrl = deps
        .execSync("git remote get-url origin", { cwd, encoding: "utf8" })
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
        `Default repository backend is GitHub, but could not detect GitHub remote: ${getErrorMessage(error)}`
      );
    }
  }

  // Non-GitHub default: attempt to resolve current git repo path
  try {
    const toplevel = deps
      .execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8" })
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

  return await createRepositoryBackend(config);
}

/**
 * Create a repository backend instance based on auto-detection
 * Session commands can use this to get the appropriate backend for PR operations
 * Use createRepositoryBackendFromSessionUrl() if you already have the repoUrl
 * @deprecated Use `createRepositoryBackendFromSessionUrl()` instead
 */
export async function createRepositoryBackendForSession(
  workdir: string,
  deps: RepositoryBackendDetectionDeps = defaultDeps
): Promise<RepositoryBackend> {
  const backendType = detectRepositoryBackendType(workdir, deps);

  try {
    const remoteUrl = deps
      .execSync("git remote get-url origin", {
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
    throw new Error(`Failed to create repository backend: ${getErrorMessage(error)}`);
  }
}

/**
 * Resolved repository configuration from git remote detection
 */
export interface ResolvedRepositoryConfig {
  backend: "github" | "gitlab" | "local";
  url?: string;
  github?: { owner: string; repo: string };
}

/**
 * Detects the repository backend by inspecting the git remote URL of the given directory.
 * This is the ONE function for init-time detection — runs once at `minsky init`, not per-session.
 *
 * - If URL contains `github.com` → returns `{ backend: "github", url, github: { owner, repo } }`
 * - If URL contains `gitlab.com` → returns `{ backend: "gitlab", url }`
 * - If no remote or error → returns `{ backend: "local" }`
 */
export function resolveRepositoryFromGitRemote(
  cwd: string,
  deps: RepositoryBackendDetectionDeps = defaultDeps
): ResolvedRepositoryConfig {
  try {
    const url = deps
      .execSync("git remote get-url origin", {
        cwd,
        encoding: "utf8",
      })
      .toString()
      .trim();

    if (url.includes("github.com")) {
      const githubInfo = extractGitHubInfoFromUrl(url);
      const result: ResolvedRepositoryConfig = { backend: "github", url };
      if (githubInfo) {
        result.github = githubInfo;
      }
      return result;
    }

    if (url.includes("gitlab.com")) {
      return { backend: "gitlab", url };
    }

    return { backend: "local" };
  } catch (error) {
    log.debug("Failed to resolve repository from git remote", {
      cwd,
      error: getErrorMessage(error),
    });
    return { backend: "local" };
  }
}

/**
 * Read repository backend configuration from project config (written by `minsky init`).
 *
 * Falls back to `resolveRepositoryAndBackend()` detection behavior if `repository.backend`
 * is not configured — backward-compat for projects that haven't re-run init.
 */
export async function getRepositoryBackendFromConfig(
  deps: RepositoryBackendDetectionDeps = defaultDeps
): Promise<{
  repoUrl: string;
  backendType: RepositoryBackendType;
  github?: { owner: string; repo: string };
}> {
  try {
    let getConfiguration: () => object;
    if (deps.getConfiguration) {
      getConfiguration = deps.getConfiguration;
    } else {
      const mod = await import("../configuration/index");
      getConfiguration = mod.getConfiguration;
    }
    const cfg = getConfiguration() as {
      repository?: {
        backend?: "github" | "gitlab" | "local";
        url?: string;
        github?: { owner: string; repo: string };
      };
    };

    const repo = cfg.repository;
    if (repo?.backend) {
      let backendType: RepositoryBackendType;
      switch (repo.backend) {
        case "github":
          backendType = RepositoryBackendType.GITHUB;
          break;
        case "gitlab":
          backendType = RepositoryBackendType.REMOTE;
          break;
        case "local":
          backendType = RepositoryBackendType.LOCAL;
          break;
        default:
          backendType = RepositoryBackendType.REMOTE;
      }

      const repoUrl = repo.url || "";
      const result: {
        repoUrl: string;
        backendType: RepositoryBackendType;
        github?: { owner: string; repo: string };
      } = {
        repoUrl,
        backendType,
      };

      if (repo.github) {
        result.github = repo.github;
      }

      return result;
    }
  } catch (_err) {
    // Config unavailable — fall through to auto-detection
  }

  // Fallback: auto-detect using existing logic (backward compat)
  const detected = await resolveRepositoryAndBackend({ cwd: process.cwd() }, deps);
  return { repoUrl: detected.repoUrl, backendType: detected.backendType };
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
        owner: match[1] || "",
        repo: (match[2] || "").replace(/\.git$/, ""), // Remove .git suffix
      };
    }

    return null;
  } catch (error) {
    log.debug("Failed to extract GitHub info from URL", {
      remoteUrl,
      error: getErrorMessage(error),
    });
    return null;
  }
}
