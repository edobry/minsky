/**
 * Changeset Commands Registration
 * 
 * Registers all changeset-related commands in the shared command registry.
 */

import { sharedCommandRegistry, CommandCategory } from '../../command-registry';
import { changesetCommands } from './changeset-commands';

/**
 * Register all changeset commands in the shared command registry
 */
export function registerChangesetCommands(): void {
  for (const command of changesetCommands) {
    sharedCommandRegistry.registerCommand({
      id: command.id,
      name: command.name,
      description: command.description,
      category: CommandCategory.REPO,
      parameters: command.parameters,
      execute: command.execute.bind(command),
    });
  }
}

// Re-export commands for direct access if needed
export * from './changeset-commands';
