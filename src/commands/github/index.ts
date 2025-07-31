/**
 * GitHub CLI Commands
 *
 * Provides commands for testing and managing GitHub integration
 */

import { Command } from "commander";

export function createGitHubCommand(): Command {
  const github = new Command("github").alias("gh").description("GitHub integration commands");

  // Test command
  github
    .command("test")
    .description("Test GitHub API connectivity and authentication")
    .option("--verbose", "Show detailed connection information")
    .action(async (options) => {
      const { testGitHubConnection } = await import("./test");
      await testGitHubConnection(options);
    });

  // Status command
  github
    .command("status")
    .description("Show GitHub backend configuration and status")
    .option("--verbose", "Show detailed configuration information")
    .action(async (options) => {
      const { showGitHubStatus } = await import("./status");
      await showGitHubStatus(options);
    });

  return github;
}
