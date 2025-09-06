/**
 * MCP adapter for changeset commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerChangesetCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers changeset tools with the MCP command mapper
 */
export function registerChangesetTools(commandMapper: CommandMapper): void {
  log.debug("Registering changeset commands with MCP");

  // Use the bridge integration to automatically register all changeset commands
  registerChangesetCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      "changeset.list": {
        description: "List changesets (PRs/MRs/changes) across all VCS platforms",
      },
      "changeset.search": {
        description: "Search changesets by query across all VCS platforms",
      },
      "changeset.get": {
        description: "Get details for a specific changeset (VCS agnostic)",
      },
      "changeset.info": {
        description: "Show changeset platform information and capabilities",
      },
      "session.changeset.list": {
        description: "List changesets for current session (alias for session pr list)",
      },
      "session.changeset.get": {
        description: "Get current session's changeset details (alias for session pr)",
      },
      "session.changeset.create": {
        description: "Create a changeset for current session (alias for session pr create)",
      },
      "session.changeset.approve": {
        description: "Approve current session's changeset (alias for session pr approve)",
      },
      "session.changeset.merge": {
        description: "Merge current session's changeset (alias for session pr merge)",
      },
      "session.changeset.edit": {
        description: "Edit current session's changeset (alias for session pr edit)",
      },
      "session.cs.list": {
        description: "List changesets for current session (short alias)",
      },
      "session.cs.get": {
        description: "Get current session's changeset details (short alias)",
      },
      "session.cs.create": {
        description: "Create changeset for current session (short alias)",
      },
      "session.cs.approve": {
        description: "Approve current session's changeset (short alias)",
      },
      "session.cs.merge": {
        description: "Merge current session's changeset (short alias)",
      },
    },
  });
}
