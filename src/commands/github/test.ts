/**
 * GitHub Test Command
 *
 * Tests GitHub API connectivity and authentication
 */

import { Octokit } from "@octokit/rest";
import { getConfiguration } from "../../domain/configuration/index";
import { environmentMappings } from "../../domain/configuration/sources/environment";
import { getUserConfigDir } from "../../domain/configuration/sources/user";
import { getGitHubBackendConfig } from "../../domain/tasks/githubBackendConfig";
import { log } from "../../utils/logger";

interface TestOptions {
  verbose?: boolean;
}

export async function testGitHubConnection(options: TestOptions = {}): Promise<void> {
  const { verbose } = options;

  try {
    if (verbose) {
      log.cli("🔍 Testing GitHub API connectivity...\n");
    }

    // Step 1: Check authentication
    const config = getConfiguration();
    const githubToken = config.github.token;

    if (!githubToken) {
      log.cli("❌ No GitHub token found");
      log.cli("");
      log.cli("Please set up authentication:");

      // Get environment variable names that map to github.token
      const githubTokenEnvVars = Object.entries(environmentMappings)
        .filter(([_, configPath]) => configPath === "github.token")
        .map(([envVar, _]) => envVar);

      // Show primary environment variable option
      if (githubTokenEnvVars[0]) {
        log.cli(`  export ${githubTokenEnvVars[0]}="your_token_here"`);
      }

      // Show config file option with dynamic path
      const configFile = `${getUserConfigDir()}/config.yaml`;
      log.cli(`  Or add token to ${configFile}`);
      log.cli("  Or use: gh auth login");
      log.cli("");
      log.cli("See: minsky docs github-setup");
      throw new Error("GitHub token not configured");
    }

    if (verbose) {
      log.cli("✅ GitHub token found");
    }

    // Step 2: Test API connectivity
    const octokit = new Octokit({
      auth: githubToken,
    });

    const { data: user } = await octokit.rest.users.getAuthenticated();

    if (verbose) {
      log.cli(`✅ API connectivity successful`);
      log.cli(`   Authenticated as: ${user.login}`);
      log.cli(`   Name: ${user.name || "Not set"}`);
      log.cli(`   Email: ${user.email || "Not public"}`);
    }

    // Step 3: Test repository detection
    let repoOwner: string | undefined;
    let repoName: string | undefined;

    try {
      const workdir = process.cwd();
      const config = getGitHubBackendConfig(workdir);

      if (config && config.owner && config.repo) {
        repoOwner = config.owner;
        repoName = config.repo;

        if (verbose) {
          log.cli(`✅ Repository detected: ${repoOwner}/${repoName}`);
        }

        // Step 4: Test repository access
        try {
          const { data: repo } = await octokit.rest.repos.get({
            owner: repoOwner,
            repo: repoName,
          });

          if (verbose) {
            log.cli(`✅ Repository access confirmed`);
            log.cli(`   Repository: ${repo.full_name}`);
            log.cli(`   Private: ${repo.private}`);
            log.cli(
              `   Permissions: ${repo.permissions?.admin ? "admin" : repo.permissions?.push ? "write" : "read"}`
            );
          }
        } catch (repoError: unknown) {
          log.cli(
            `❌ Repository access failed: ${repoError instanceof Error ? repoError.message : String(repoError)}`
          );
          if (verbose) {
            log.cli(`   This may indicate insufficient permissions or repository not found`);
          }
          throw repoError;
        }
      } else {
        if (verbose) {
          log.cli("⚠️  No GitHub repository detected in current directory");
          log.cli("   This is normal if you're not in a GitHub repository");
        }
      }
    } catch (error: unknown) {
      if (verbose) {
        log.cli(
          `⚠️  Repository detection failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Step 5: Test rate limits
    const { data: rateLimit } = await octokit.rest.rateLimit.get();

    if (verbose) {
      log.cli(`✅ Rate limit status:`);
      log.cli(
        `   Core API: ${rateLimit.resources.core.remaining}/${rateLimit.resources.core.limit} remaining`
      );
      log.cli(`   Resets at: ${new Date(rateLimit.resources.core.reset * 1000).toLocaleString()}`);
    }

    // Success summary
    log.cli("");
    log.cli("🎉 GitHub integration test successful!");
    if (repoOwner && repoName) {
      log.cli(`   Repository: ${repoOwner}/${repoName}`);
    }
    log.cli(`   User: ${user.login}`);
    log.cli(
      `   Rate limit: ${rateLimit.resources.core.remaining}/${rateLimit.resources.core.limit} remaining`
    );

    if (!verbose) {
      log.cli("");
      log.cli("Use --verbose for detailed information");
    }
  } catch (error: unknown) {
    log.cli("❌ GitHub connection test failed");
    log.cli("");

    const err = error as { status?: number; code?: string; message?: string };
    if (err.status === 401) {
      log.cli("Authentication failed. Please check your GitHub token:");
      log.cli("  1. Verify token is set: echo $GITHUB_TOKEN");
      log.cli("  2. Check token permissions include 'repo' or 'public_repo'");
      log.cli("  3. Generate new token at: https://github.com/settings/tokens");
    } else if (err.status === 403) {
      log.cli("Access forbidden. This may indicate:");
      log.cli("  1. Token lacks required permissions");
      log.cli("  2. Rate limit exceeded");
      log.cli("  3. Repository access restrictions");
    } else if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
      log.cli("Network connectivity issue:");
      log.cli("  1. Check internet connection");
      log.cli("  2. Verify GitHub is accessible");
      log.cli("  3. Check firewall/proxy settings");
    } else {
      log.cli(`Error: ${err.message}`);
      if (verbose) {
        log.cli(`Status: ${err.status}`);
        log.cli(`Code: ${err.code}`);
      }
    }

    log.cli("");
    log.cli("For more help, see: minsky docs github-troubleshooting");
    throw error;
  }
}
