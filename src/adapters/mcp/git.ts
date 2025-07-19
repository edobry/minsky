/**
 * MCP adapter for git commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerGitCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers git tools with the MCP command mapper
 *
 * Note: git.commit and git.push are available but require session parameters
 * in MCP context since there's no meaningful "current directory" for MCP services.
 */
export function registerGitTools(commandMapper: CommandMapper): void {
  log.debug("Registering git commands via shared command integration");

  // Use the bridge integration to automatically register all git commands
  registerGitCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      // Session-dependent git operations - enforce session requirement in MCP
      "git.commit": {
        description: "Commit changes to the repository (session parameter required in MCP context)",
        mcpRequiredParams: ["session"],
      },
      "git.push": {
        description: "Push changes to the remote repository (session parameter required in MCP context)",
        mcpRequiredParams: ["session"],
      },
      
      // Hide disruptive git operations that don't make sense for agents
      "git.clone": {
        hidden: true,
      },
      "git.checkout": {
        hidden: true,
      },
      "git.merge": {
        hidden: true,
      },
      "git.rebase": {
        hidden: true,
      },
      "git.branch": {
        hidden: true,
      },
    },
  });
}
