/**
 * Configuration helper for GitHub Issues task backend
 */

import { config } from "@dotenvx/dotenvx";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { log } from "../../utils/logger";
import type { GitHubIssuesTaskBackendOptions } from "./githubIssuesTaskBackend";

// Load environment variables from .env file only if it exists
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  config({ quiet: true });
}

/**
 * Extract GitHub repository info from git remote
 */
function extractGitHubRepoFromRemote(
  workspacePath: string
): { owner: string; repo: string } | null {
  try {
    // Get the origin remote URL
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: workspacePath,
      encoding: "utf8",
    })
      .toString()
      .trim();

    // Parse GitHub repository from various URL formats
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
  } catch (___error) {
    log.debug("Failed to extract GitHub repo from git remote", {
      workspacePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Get GitHub backend configuration from environment and git remote
 */
export function getGitHubBackendConfig(
  workspacePath: string,
  options?: { logErrors?: boolean }
): Partial<GitHubIssuesTaskBackendOptions> | null {
  const { logErrors = false } = options || {};

  // Check for GitHub token in environment
  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (!githubToken) {
    if (logErrors) {
      log.error("GitHub token not found in environment. Set GITHUB_TOKEN or GH_TOKEN in .env file");
    }
    return null;
  }

  // Try to auto-detect repository from git remote
  const repoInfo = extractGitHubRepoFromRemote(workspacePath);

  if (!repoInfo) {
    if (logErrors) {
      log.error("Could not detect GitHub repository from git remote");
    }
    return null;
  }

  return {
    name: "github-issues",
    workspacePath,
    githubToken,
    owner: repoInfo.owner,
    repo: repoInfo.repo,
  };
}

/**
 * Create labels for a GitHub repository
 */
export async function createGitHubLabels(
  octokit: any,
  owner: string,
  repo: string,
  labels: Record<string, string>
): Promise<void> {
  for (const [status, labelName] of Object.entries(labels)) {
    try {
      // Check if label already exists
      try {
        await octokit.rest.issues.getLabel({
          owner,
          repo,
          name: labelName,
        });
        log.debug(`Label ${labelName} already exists`);
        continue;
      } catch (error: unknown) {
        // Label doesn't exist, continue to create it
        if (error.status !== 404) {
          throw error;
        }
      }

      // Create the label
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name: labelName,
        color: getColorForStatus(status),
        description: `Minsky task status: ${status}`,
      });

      log.debug(`Created GitHub label: ${labelName}`);
    } catch (___error) {
      log.error(`Failed to create GitHub label: ${labelName}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Get color for status label
 */
function getColorForStatus(_status: string): string {
  const colors: Record<string, string> = {
    TODO: "0e8a16", // Green
    "IN-PROGRESS": "fbca04", // Yellow
    "IN-REVIEW": "0052cc", // Blue
    DONE: "5319e7", // Purple
  };

  return colors[status] || "cccccc"; // Default gray
}
