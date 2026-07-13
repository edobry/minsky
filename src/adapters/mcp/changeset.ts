/**
 * MCP adapter for changeset commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerChangesetCommandsWithMcp } from "./shared-command-integration";
import { log } from "@minsky/shared/logger";

/**
 * Registers changeset tools with the MCP command mapper
 */
export function registerChangesetTools(
  commandMapper: CommandMapper,
  container?: import("@minsky/domain/composition/types").AppContainerInterface
): void {
  log.debug("Registering changeset commands with MCP");

  // Use the bridge integration to automatically register all changeset commands
  registerChangesetCommandsWithMcp(commandMapper, {
    container,
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
    },
  });
}
