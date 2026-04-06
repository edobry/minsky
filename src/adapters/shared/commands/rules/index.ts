/**
 * Shared Rules Commands
 *
 * Registers all rules commands in the shared command registry.
 */
import { sharedCommandRegistry } from "../../command-registry";
import { registerCrudCommands, type RulesCrudCommandsDeps } from "./crud-commands";
import {
  registerListSearchCommands,
  type RulesListSearchCommandsDeps,
} from "./list-search-commands";
import { registerCompileMigrateCommands } from "./compile-migrate-commands";
import { registerSelectionCommands } from "./selection-commands";

/**
 * Dependencies for rules commands (injectable for testing)
 */
export interface RulesCommandsDeps extends RulesCrudCommandsDeps, RulesListSearchCommandsDeps {}

export function registerRulesCommands(
  registry?: typeof sharedCommandRegistry,
  deps?: RulesCommandsDeps
): void {
  const targetRegistry = registry || sharedCommandRegistry;
  registerListSearchCommands(targetRegistry, deps);
  registerCrudCommands(targetRegistry, deps);
  registerCompileMigrateCommands(targetRegistry);
  registerSelectionCommands(targetRegistry);
}
