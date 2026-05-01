/**
 * MCP adapter for memory commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerMemoryCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers memory tools with the MCP command mapper.
 *
 * Exposes the 9 memory commands (`memory.search`, `memory.get`, `memory.list`,
 * `memory.create`, `memory.update`, `memory.delete`, `memory.similar`,
 * `memory.supersede`, `memory.lineage`) as MCP tools so agents can call them
 * via the standard `mcp__minsky__memory_*` tool names.
 *
 * Without this wiring the commands are registered in the shared command
 * registry but the MCP bridge never emits them — same bug class as mt#386
 * (registerGitTools missing). See mt#1012's gap-fix scope.
 */
export function registerMemoryTools(
  commandMapper: CommandMapper,
  container?: import("../../composition/types").AppContainerInterface
): void {
  log.debug("Registering memory commands via shared command integration");

  registerMemoryCommandsWithMcp(commandMapper, {
    container,
    debug: true,
  });
}
