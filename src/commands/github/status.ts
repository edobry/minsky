/**
 * GitHub Status Command
 *
 * Shows GitHub backend configuration and status information
 */

import { getGitHubBackendConfig } from "@minsky/domain/tasks/githubBackendConfig";
import type { GitHubIssuesTaskBackendOptions } from "@minsky/domain/tasks/githubIssuesTaskBackend";
import { get, getConfiguration, has } from "@minsky/domain/configuration";
import { log } from "@minsky/shared/logger";

interface StatusOptions {
  verbose?: boolean;
}

/**
 * Injectable dependencies (test seam — production callers use the defaults).
 * `mock.module()` is banned repo-wide (`custom/no-global-module-mocks`), so this is the
 * sanctioned way to test the check-aggregation/exit-code logic below without hitting the
 * real configuration provider or filesystem.
 */
export interface ShowGitHubStatusDeps {
  getConfiguration?: typeof getConfiguration;
  get?: typeof get;
  has?: typeof has;
  getGitHubBackendConfig?: typeof getGitHubBackendConfig;
}

/**
 * Runs the GitHub backend status checks and prints their results.
 *
 * @returns `true` when every check completed without a genuine failure (an exception during a
 *   check); `false` when a check produced a handled failure — the caller is responsible for
 *   translating that into a non-zero process exit code. An incomplete-but-not-broken setup (no
 *   token configured, task backend not `github-issues`, no repository detected) is reported as
 *   a warning in the summary and does NOT count as a failure — consistent with how `github test`
 *   treats "not in a GitHub repository" as informational rather than fatal.
 */
export async function showGitHubStatus(
  options: StatusOptions = {},
  deps: ShowGitHubStatusDeps = {}
): Promise<boolean> {
  const { verbose } = options;
  const resolveConfiguration = deps.getConfiguration ?? getConfiguration;
  const resolveGet = deps.get ?? get;
  const resolveHas = deps.has ?? has;
  const resolveGitHubBackendConfig = deps.getGitHubBackendConfig ?? getGitHubBackendConfig;
  let hadFailure = false;

  /**
   * Reads the *task* backend selection (`tasks.backend` — `minsky` DB vs `github-issues`).
   *
   * `get("backend")` reads the deprecated top-level `backend` alias for this same value
   * (`packages/domain/src/configuration/schemas/backend.ts`: `@deprecated Use tasks.backend
   * instead`). Most project configs set `tasks.backend` directly and never set the deprecated
   * top-level alias, so `get("backend")` throws `Configuration path 'backend' not found` for
   * the common case (mt#4679). `tasks.backend` is defaulted to `"minsky"` by the configuration
   * provider when unset, so this can never throw for a missing value the way `get("backend")`
   * did — the `has()` guard is defense-in-depth against any other config-loading failure, not
   * a workaround for this specific path.
   */
  function getTaskBackend(): string | undefined {
    return resolveHas("tasks.backend") ? resolveGet<string>("tasks.backend") : undefined;
  }

  /**
   * Reads the backend-specific config block (status labels etc. for the `github-issues`
   * task backend). Guarded the same way as `getTaskBackend()` and for the same reason
   * (mt#4679 PR #3422 R1): an absent `backendConfig` — the normal state for a project that
   * doesn't use the `github-issues` task backend at all — must read as "nothing configured",
   * not as a check FAILURE. `resolveGet` unguarded would throw `Configuration path
   * 'backendConfig' not found` for that entirely ordinary case, which the Step 2 catch below
   * would then misclassify as `hadFailure`.
   */
  function getBackendConfig(): Record<string, { statusLabels?: Record<string, string> }> {
    return resolveHas("backendConfig")
      ? (resolveGet("backendConfig") as Record<string, { statusLabels?: Record<string, string> }>)
      : {};
  }

  /**
   * Reads the explicit `github` config block (organization/repository/baseUrl overrides).
   * Same guard, same reason: no explicit `github` config is the common case (most projects
   * rely on git-remote auto-detection instead), not a failure.
   */
  function getExplicitGithubConfig():
    | { organization?: string; repository?: string; baseUrl?: string }
    | undefined {
    return resolveHas("github")
      ? resolveGet<{ organization?: string; repository?: string; baseUrl?: string }>("github")
      : undefined;
  }

  try {
    log.cli("📊 GitHub Backend Status\n");

    // Step 1: Check authentication setup
    const config = resolveConfiguration();
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
      const taskBackend = getTaskBackend();
      const backendConfig = getBackendConfig();

      log.cli(`\n📋 Configuration:`);
      log.cli(`   Task backend: ${taskBackend || "Not configured"}`);

      if (taskBackend === "github-issues") {
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
      hadFailure = true;
    }

    // Step 3: Check repository detection
    let repoConfig: Partial<GitHubIssuesTaskBackendOptions> | null = null;
    try {
      const workdir = process.cwd();
      repoConfig = resolveGitHubBackendConfig(workdir);

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
      hadFailure = true;
    }

    // Step 4: Check GitHub config from configuration system
    try {
      const githubConfig = getExplicitGithubConfig();

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
        log.cli(`   Auto-detected: ${repoConfig?.owner}/${repoConfig?.repo}`);
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
      hadFailure = true;
    }

    // Step 5: Summary and recommendations
    log.cli(`\n📝 Summary:`);

    const hasToken = !!githubToken;
    const isConfigured = getTaskBackend() === "github-issues";
    const hasRepo = !!resolveGitHubBackendConfig(process.cwd());

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
        log.cli("      tasks:");
        log.cli('        backend: "github-issues"');
      }

      if (!hasRepo) {
        log.cli("   3. Use in a GitHub repository or configure repository info");
      }
    }

    if (!verbose) {
      log.cli("\nUse --verbose for detailed information");
    }

    log.cli("\nFor setup help: minsky docs github-setup");

    return !hadFailure;
  } catch (error) {
    // Reaching this outer catch means a check threw an exception that wasn't
    // handled by one of the inner try/catch blocks above. Print a clean,
    // purpose-built failure message and return false rather than re-throwing
    // — a re-throw here used to propagate all the way to the CLI's generic
    // `main().catch()` handler, producing a redundant, unhelpful "Unhandled
    // error in CLI: ..." line on top of the message already printed below
    // (mt#4679).
    log.cli("❌ Status check failed");
    log.cli(`Error: ${(error as Error).message}`);

    if (verbose) {
      log.cli(`Stack: ${(error as Error).stack}`);
    }

    return false;
  }
}
