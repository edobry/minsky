/**
 * MCP adapter for git commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { registerGitCommandsWithMcp } from "./shared-command-integration.js";
import { log } from "../../utils/logger.js";

/**
 * Registers git tools with the MCP command mapper
 */
export function registerGitTools(commandMapper: CommandMapper): void {
  log.debug("Registering git commands via shared command integration");

  // Use the bridge integration to automatically register all git commands
  registerGitCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      // MCP-specific optimizations
      "git.commit": {
        description: "Commit changes to the repository (MCP optimized)",
      },
      "git.push": {
        description: "Push changes to the remote repository (MCP optimized)",
      },
      "git.clone": {
        description: "Clone a Git repository (MCP optimized)",
      },
      "git.branch": {
        description: "Create a new branch (MCP optimized)",
      },
      "git.pr": {
        description: "Create a pull request (MCP optimized)",
      },
      "git.merge": {
        description: "Merge a branch with conflict detection (MCP optimized)",
      },
      "git.checkout": {
        description: "Checkout a branch with conflict detection (MCP optimized)",
      },
      "git.rebase": {
        description: "Rebase with conflict detection (MCP optimized)",
      },
    },
  });

  log.debug("Git commands registered successfully via shared integration");
}
