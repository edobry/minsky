/**
 * MCP adapter for git commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerGitCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers git tools with the MCP command mapper
 */
export function registerGitTools(commandMapper: CommandMapper): void {
  log.debug("Registering git commands via shared command integration");

  // Use the bridge integration to automatically register all git commands
  registerGitCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      "git.commit": {
        description: "Commit changes to the repository",
      },
      "git.push": {
        description: "Push changes to the remote repository",
      },
      "git.clone": {
        description: "Clone a Git repository",
      },
      "git.branch": {
        description: "Create a new branch",
      },
      "git.merge": {
        description: "Merge a branch with conflict detection",
      },
      "git.checkout": {
        description: "Checkout a branch with conflict detection",
      },
      "git.rebase": {
        description: "Rebase with conflict detection",
      },
    },
  });

  log.debug("Git commands registered successfully via shared integration");
}
