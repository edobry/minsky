/**
 * MCP adapter for git commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerGitCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers git tools with the MCP command mapper
 *
 * Exposes git commands for main workspace git operations:
 * - git.commit: Commit changes to the repository
 * - git.push: Push changes to the remote repository
 * - git.conflicts: Detect and report merge conflicts
 *
 * Commands that are session-scoped or less relevant for main workspace
 * work are hidden:
 * - git.clone: Use session.start instead
 * - git.checkout: Use session commands for branch switching
 * - git.merge: Use session commands for merging
 * - git.rebase: Use session commands for rebasing
 * - git.branch: Use session commands for branch creation
 */
export function registerGitTools(
  commandMapper: CommandMapper,
  container?: import("../../composition/types").AppContainerInterface
): void {
  log.debug("Registering git commands via shared command integration");

  registerGitCommandsWithMcp(commandMapper, {
    container,
    debug: true,
    commandOverrides: {
      // Hide session-scoped or less useful git operations from main workspace MCP
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
