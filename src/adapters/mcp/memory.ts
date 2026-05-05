/**
 * MCP adapter for memory commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerMemoryCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

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
 * Client harnesses may surface these under harness-specific aliases
 * (e.g., Claude Code surfaces them as `mcp__minsky__memory_*`), but the
 * canonical names registered here are the dot form.
 *
 * Without this wiring the commands are registered in the shared command
 * registry but the MCP bridge never emits them — same bug class as mt#386
 * (`registerGitTools` missing). See mt#1012's gap-fix scope.
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
