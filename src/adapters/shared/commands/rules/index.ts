/**
 * Shared Rules Commands
 *
 * Registers all rules commands in the shared command registry.
 */
import { sharedCommandRegistry } from "../../command-registry";
import { registerCrudCommands } from "./crud-commands";
import { registerListSearchCommands } from "./list-search-commands";
import { registerCompileMigrateCommands } from "./compile-migrate-commands";
import { registerSelectionCommands } from "./selection-commands";

export function registerRulesCommands(registry?: typeof sharedCommandRegistry): void {
  const targetRegistry = registry || sharedCommandRegistry;
  registerListSearchCommands(targetRegistry);
  registerCrudCommands(targetRegistry);
  registerCompileMigrateCommands(targetRegistry);
  registerSelectionCommands(targetRegistry);
}
