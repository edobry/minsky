/**
 * MCP adapter for repo exploration commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerRepoCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers repo exploration tools with the MCP command mapper.
 *
 * Exposes non-session repo commands:
 * - repo.read_file: Read a file from the workspace
 * - repo.search: Search repository content using git grep
 * - repo.list_directory: List directory contents
 */
export function registerRepoTools(
  commandMapper: CommandMapper,
  _container?: import("../../composition/types").AppContainerInterface
): void {
  log.debug("Registering repo exploration commands via shared command integration");

  registerRepoCommandsWithMcp(commandMapper, {
    debug: true,
  });
}
