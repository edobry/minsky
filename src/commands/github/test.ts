/**
 * GitHub Test Command
 *
 * Tests GitHub API connectivity and authentication
 */

import { Octokit } from "@octokit/rest";
import { createTimeoutFetch } from "@minsky/domain/github/octokit-timeout";
import { getConfiguration } from "@minsky/domain/configuration/index";
import { environmentMappings } from "@minsky/domain/configuration/sources/environment";
import { getUserConfigDir } from "@minsky/domain/configuration/sources/user";
import { getGitHubBackendConfig } from "@minsky/domain/tasks/githubBackendConfig";
import { log } from "@minsky/shared/logger";

interface TestOptions {
  verbose?: boolean;
}

/**
 * The subset of the Octokit REST surface this command exercises. Kept
 * minimal and structural so tests can inject a fake client without
 * constructing a real `Octokit` instance — `mock.module()` on `@octokit/rest`
 * is not an option here (banned repo-wide by `custom/no-global-module-mocks`;
 * see `bun-test-patterns.mdc`), so dependency injection is the sanctioned
 * seam (ADR-036: real dependency > injected fake > in-place patch).
 */
export interface OctokitLike {
  rest: {
    users: {
      getAuthenticated: () => Promise<{
        data: { login: string; name?: string | null; email?: string | null };
      }>;
    };
    repos: {
      get: (params: { owner: string; repo: string }) => Promise<{
        data: {
          full_name: string;
          private: boolean;
          permissions?: { admin?: boolean; push?: boolean };
        };
      }>;
    };
    rateLimit: {
      get: () => Promise<{
        data: { resources: { core: { remaining: number; limit: number; reset: number } } };
      }>;
    };
  };
}

/**
 * Injectable dependencies (test seam — production callers use the defaults).
 */
export interface TestGitHubConnectionDeps {
  getConfiguration?: () => ReturnType<typeof getConfiguration>;
  getGitHubBackendConfig?: typeof getGitHubBackendConfig;
  /** Pre-built Octokit-like client. Defaults to a real `Octokit` instance built from the
   * resolved token when not supplied. */
  octokit?: OctokitLike;
}

/**
 * Runs the GitHub connectivity/authentication checks and prints their results.
 *
 * @returns `true` when every check that ran passed (the success banner was printed);
 *   `false` when a check produced a handled failure (e.g. repository access denied) —
 *   the caller is responsible for translating that into a non-zero process exit code.
 *   Some failures (missing token, an unexpected API error from the auth or rate-limit
 *   calls) still THROW rather than returning `false`, matching this function's
 *   pre-existing behavior for those paths.
 */
export async function testGitHubConnection(
  options: TestOptions = {},
  deps: TestGitHubConnectionDeps = {}
): Promise<boolean> {
  const { verbose } = options;
  const resolveConfiguration = deps.getConfiguration ?? getConfiguration;
  const resolveGitHubBackendConfig = deps.getGitHubBackendConfig ?? getGitHubBackendConfig;
  let hadFailure = false;

  try {
    if (verbose) {
      log.cli("🔍 Testing GitHub API connectivity...\n");
    }

    // Step 1: Check authentication
    const config = resolveConfiguration();
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
    const octokit: OctokitLike =
      deps.octokit ??
      (new Octokit({
        auth: githubToken,
        // Bound every request (mt#2270 sweep; see octokit-timeout.ts). This is a
        // one-shot CLI diagnostic, not a long-lived process, but bounding keeps
        // the connectivity test from hanging indefinitely on a stalled endpoint.
        request: { fetch: createTimeoutFetch() },
      }) as OctokitLike);

    const { data: user } = await octokit.rest.users.getAuthenticated();

    if (verbose) {
      log.cli(`✅ API connectivity successful`);
      log.cli(`   Authenticated as: ${user.login}`);
      log.cli(`   Name: ${user.name || "Not set"}`);
      log.cli(`   Email: ${user.email || "Not public"}`);
    }

    // Step 3: Test repository detection. A failure here is benign — it just
    // means "not in a GitHub repository", which is a normal state, not a
    // check failure. Kept in its own try/catch, deliberately separate from
    // the repository ACCESS check below (mt#4679): the two used to share one
    // try/catch, which let a genuine access failure (Step 4) get silently
    // absorbed by the handler meant for "no repo detected here, that's fine".
    let repoOwner: string | undefined;
    let repoName: string | undefined;
    let detectedConfig: ReturnType<typeof getGitHubBackendConfig> | null = null;

    try {
      const workdir = process.cwd();
      detectedConfig = resolveGitHubBackendConfig(workdir);
    } catch (error: unknown) {
      if (verbose) {
        log.cli(
          `⚠️  Repository detection failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (detectedConfig && detectedConfig.owner && detectedConfig.repo) {
      repoOwner = detectedConfig.owner;
      repoName = detectedConfig.repo;

      if (verbose) {
        log.cli(`✅ Repository detected: ${repoOwner}/${repoName}`);
      }

      // Step 4: Test repository access. A failure here is a REAL check
      // failure — it must suppress the success banner and be reported as a
      // non-zero exit, not just logged and forgotten.
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
        hadFailure = true;
      }
    } else {
      if (verbose) {
        log.cli("⚠️  No GitHub repository detected in current directory");
        log.cli("   This is normal if you're not in a GitHub repository");
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

    if (hadFailure) {
      log.cli("");
      log.cli("❌ GitHub integration test failed — see failures above");
      if (!verbose) {
        log.cli("");
        log.cli("Use --verbose for detailed information");
      }
      return false;
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

    return true;
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
