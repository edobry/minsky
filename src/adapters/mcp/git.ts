/**
 * MCP adapter for git commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerGitCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers git tools with the MCP command mapper
 *
 * Note: Raw git operations (commit, push, branch) are hidden from MCP
 * because they have optional session parameters that don't make sense
 * in the MCP service context. Agents should use session-level commands instead:
 * - Use session.commit instead of git.commit  
 * - Use session.push instead of git.push
 * - Use session.pr for pull request workflow
 * - Use session.start to create new sessions with branches
 */
export function registerGitTools(commandMapper: CommandMapper): void {
  log.debug("Registering git commands via shared command integration");

  // Use the bridge integration to register git commands with appropriate filtering
  registerGitCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      // Hide raw git operations - agents should use session-level commands instead
      "git.commit": { 
        hidden: true, // Use session.commit instead - always session-scoped
      },
      "git.push": { 
        hidden: true, // Use session.push instead - always session-scoped
      },
      "git.branch": { 
        hidden: true, // Use session.start instead - sessions create their own branches
      },
      
      // Disruptive operations (exclude from MCP)
      "git.clone": { 
        hidden: true, // Agents shouldn't clone new repos
      },
      "git.checkout": { 
        hidden: true, // Can disrupt session state
      },
      "git.merge": { 
        hidden: true, // Complex operation requiring human judgment
      },
      "git.rebase": { 
        hidden: true, // Complex operation requiring human judgment
      },
    },
  });

  log.debug("Git commands registered successfully via shared integration");
}
