/**
 * MCP adapter for memory commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerMemoryCommandsWithMcp } from "./shared-command-integration";
import { log } from "@minsky/shared/logger";

/**
 * Registers memory tools with the MCP command mapper.
 *
 * Exposes the 9 memory commands as MCP tools under their canonical
 * `command.id` (the bridge does not add aliases):
 * - `memory.search`: Vector-similarity search across stored memories
 * - `memory.get`: Fetch a memory by id
 * - `memory.list`: List memories with optional filters (e.g., `--stale`)
 * - `memory.create`: Create a new memory (validated by the mt#960 rubric)
 * - `memory.update`: Update an existing memory's fields
 * - `memory.delete`: Delete a memory by id
 * - `memory.similar`: Find memories similar to a given one (deduplication)
 * - `memory.supersede`: Mark one memory as superseding another
 * - `memory.lineage`: Walk the supersession chain
 *
 * Some MCP client harnesses MAY rewrite or alias these tool names at their
 * own surface (for example, Claude Code's tool registry transforms a
 * dot-form `command.id` into an `mcp__<server>__<command>` form before
 * presenting it to agents). This bridge does not configure or guarantee
 * any such alias — `command.id` is what's registered with the MCP server.
 *
 * Without this wiring the commands are registered in the shared command
 * registry but the MCP bridge never emits them — same bug class as mt#386
 * (`registerGitTools` missing). See mt#1012's gap-fix scope.
 */
export function registerMemoryTools(
  commandMapper: CommandMapper,
  container?: import("@minsky/domain/composition/types").AppContainerInterface
): void {
  log.debug("Registering memory commands via shared command integration");

  registerMemoryCommandsWithMcp(commandMapper, {
    container,
    debug: true,
  });
}
