/**
 * MCP adapter for git commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerGitCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers git tools with the MCP command mapper
 *
 * Note: All git commands are hidden from MCP to maintain proper separation
 * of concerns. Use session-scoped commands instead:
 * - Use session.commit instead of git.commit
 * - Use session.push instead of git.push
 * - Use session.pr for pull request workflow
 * - Use session.start to create sessions with proper git setup
 */
export function registerGitTools(commandMapper: CommandMapper): void {
  log.debug("Registering git commands via shared command integration");

  // Hide all git commands from MCP - use session commands instead
  registerGitCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      // Hide all git operations from MCP
      "git.commit": {
        hidden: true,
      },
      "git.push": {
        hidden: true,
      },
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
