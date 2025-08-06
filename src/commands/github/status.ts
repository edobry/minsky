/**
 * GitHub Status Command
 *
 * Shows GitHub backend configuration and status information
 */

import { getGitHubBackendConfig } from "../../domain/tasks/githubBackendConfig";
import { get, getConfiguration } from "../../domain/configuration";
import { log } from "../../utils/logger";

interface StatusOptions {
  verbose?: boolean;
}

export async function showGitHubStatus(options: StatusOptions = {}): Promise<void> {
  const { verbose } = options;

  try {
    log.cli("📊 GitHub Backend Status\n");

    // Step 1: Check authentication setup
    const config = getConfiguration();
    const githubToken = config.github.token;

    if (githubToken) {
      log.cli("✅ Authentication: GitHub token configured");
      if (verbose) {
        log.cli(`   Token prefix: ${githubToken.substring(0, 4)}...`);
      }
    } else {
      log.cli("❌ Authentication: No GitHub token found");
      log.cli("   Set up authentication via environment variables or config file");
    }

    // Step 2: Check configuration
    try {
      const config = get("backend");
      const backendConfig = get("backendConfig");

      log.cli(`\n📋 Configuration:`);
      log.cli(`   Task backend: ${config || "Not configured"}`);

      if (config === "github-issues") {
        log.cli("✅ GitHub Issues backend is configured");

        if (verbose && backendConfig?.["github-issues"]) {
          const ghConfig = backendConfig["github-issues"];
          if (ghConfig.statusLabels) {
            log.cli("   Custom status labels configured:");
            Object.entries(ghConfig.statusLabels).forEach(([status, label]) => {
              log.cli(`     ${status}: ${label}`);
            });
          }
        }
      } else {
        log.cli("⚠️  GitHub Issues backend not configured");
        log.cli("   Current backend will not use GitHub Issues");
      }
    } catch (error) {
      log.cli("❌ Configuration: Failed to load configuration");
      if (verbose) {
        log.cli(`   Error: ${(error as Error).message}`);
      }
    }

    // Step 3: Check repository detection
    let repoConfig: any = null;
    try {
      const workdir = process.cwd();
      repoConfig = getGitHubBackendConfig(workdir);

      log.cli(`\n🏗️  Repository Detection:`);

      if (repoConfig) {
        log.cli(`✅ GitHub repository detected: ${repoConfig.owner}/${repoConfig.repo}`);
        if (verbose) {
          log.cli(`   Owner: ${repoConfig.owner}`);
          log.cli(`   Repository: ${repoConfig.repo}`);
          log.cli(`   Token available: ${repoConfig.githubToken ? "Yes" : "No"}`);
        }
      } else {
        log.cli("⚠️  No GitHub repository detected");
        log.cli("   Current directory is not a GitHub repository");
        if (verbose) {
          log.cli("   This is normal if you're not in a cloned GitHub repository");
        }
      }
    } catch (error) {
      log.cli("❌ Repository detection failed");
      if (verbose) {
        log.cli(`   Error: ${(error as Error).message}`);
      }
    }

    // Step 4: Check GitHub config from configuration system
    try {
      const githubConfig = get("github");

      log.cli(`\n⚙️  GitHub Configuration:`);

      const hasExplicitConfig = githubConfig?.organization && githubConfig?.repository;
      const hasAutoDetection = !!repoConfig;

      if (hasExplicitConfig) {
        // Explicit configuration is present and complete
        log.cli(
          `✅ Repository configured: ${githubConfig.organization}/${githubConfig.repository}`
        );
        if (hasAutoDetection && verbose) {
          log.cli("   Note: Auto-detection also available as fallback");
        }
      } else if (hasAutoDetection) {
        // No explicit config, but auto-detection works
        log.cli("✅ Using auto-detection from git remote");
        log.cli(`   Auto-detected: ${repoConfig.owner}/${repoConfig.repo}`);
        if (verbose) {
          log.cli("   Explicit configuration not required when auto-detection works");
        }
      } else if (githubConfig && !hasExplicitConfig) {
        // Partial explicit config and no auto-detection
        log.cli("⚠️  GitHub configuration incomplete");
        log.cli("   Missing organization or repository configuration");
        log.cli("   Auto-detection also unavailable (not in a GitHub repository)");
      } else {
        // No explicit config and no auto-detection
        log.cli("⚠️  No GitHub repository configuration found");
        log.cli("   Set up explicit config or use in a cloned GitHub repository");
      }

      if (verbose && githubConfig) {
        log.cli(`   Organization: ${githubConfig.organization || "Not set"}`);
        log.cli(`   Repository: ${githubConfig.repository || "Not set"}`);
        log.cli(`   Base URL: ${githubConfig.baseUrl || "Default (github.com)"}`);
      }
    } catch (error) {
      if (verbose) {
        log.cli("❌ GitHub configuration check failed");
        log.cli(`   Error: ${(error as Error).message}`);
      }
    }

    // Step 5: Summary and recommendations
    log.cli(`\n📝 Summary:`);

    const hasToken = !!githubToken;
    const isConfigured = get("backend") === "github-issues";
    const hasRepo = !!getGitHubBackendConfig(process.cwd());

    if (hasToken && isConfigured && hasRepo) {
      log.cli("🎉 GitHub Issues backend is ready to use!");
      log.cli("   Try: minsky tasks list");
    } else {
      log.cli("⚠️  GitHub Issues backend needs setup:");

      if (!hasToken) {
        log.cli('   1. Set up authentication: export GITHUB_TOKEN="your_token"');
      }

      if (!isConfigured) {
        log.cli("   2. Configure backend in .minsky/config.yaml:");
        log.cli('      backend: "github-issues"');
      }

      if (!hasRepo) {
        log.cli("   3. Use in a GitHub repository or configure repository info");
      }
    }

    if (!verbose) {
      log.cli("\nUse --verbose for detailed information");
    }

    log.cli("\nFor setup help: minsky docs github-setup");
  } catch (error) {
    log.cli("❌ Status check failed");
    log.cli(`Error: ${(error as Error).message}`);

    if (verbose) {
      log.cli(`Stack: ${(error as Error).stack}`);
    }

    throw error;
  }
}
