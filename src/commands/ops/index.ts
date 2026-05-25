/**
 * `minsky ops` command group.
 *
 * Entry point for the ops service commands. Currently contains:
 *   - `start`: boot the domain container and run background loops
 *
 * @see mt#2101 — implementation task
 * @see mt#2097 — operational topology epic
 */

import { Command } from "commander";
import { createOpsStartCommand } from "./start-command";
import type { AppContainerInterface } from "../../composition/types";

/**
 * Create the `ops` command group.
 *
 * @param container - Optional pre-built container (for testing).
 */
export function createOpsCommand(container?: AppContainerInterface): Command {
  const opsCommand = new Command("ops");
  opsCommand.description("Ops service commands — background domain loops and health endpoint");

  opsCommand.addCommand(createOpsStartCommand(container));

  return opsCommand;
}
