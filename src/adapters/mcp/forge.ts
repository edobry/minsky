/**
 * MCP adapter for forge commands (mt#1957 / mt#2003).
 *
 * Exposes the 9 forge-agnostic MCP commands that route through the configured
 * `ForgeBackend` per ADR-005:
 *
 *   - forge.ci_run_list / forge.ci_run_view_log — GitHub Actions workflow runs
 *   - forge.check_runs_list — commit-SHA check-runs (complements session.pr.checks)
 *   - forge.branch_protection_get / .branch_protection_set — branch protection
 *   - forge.label_create / .label_list / .label_update / .label_delete — labels
 *
 * mt#1957 shipped the shared-command registrations (`src/adapters/shared/commands/forge.ts`)
 * but never created this MCP-adapter file, so the commands were never bridged to
 * `tools/list`. mt#2003 fixes the gap.
 *
 * Follows the canonical per-category adapter pattern (see `git.ts`, `tasks.ts`,
 * `repo.ts`, etc.): a thin wrapper that imports the shared-command-integration
 * registration function and calls it. `start-command.ts::registerAllTools`
 * imports and invokes `registerForgeTools` alongside the other per-category
 * adapters.
 */

import type { CommandMapper } from "../../mcp/command-mapper";
import { registerForgeCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers forge tools with the MCP command mapper.
 *
 * Exposes all 9 forge commands without overrides — the forge surface is
 * intended for direct agent use (mt#1954's investigation needed all of these).
 */
export function registerForgeTools(
  commandMapper: CommandMapper,
  container?: import("../../composition/types").AppContainerInterface
): void {
  log.debug("Registering forge commands via shared command integration");

  registerForgeCommandsWithMcp(commandMapper, {
    container,
    debug: true,
  });
}
