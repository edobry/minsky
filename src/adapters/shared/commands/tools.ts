/**
 * Tools Commands Registration
 *
 * Registers all tools-related commands in the shared command registry.
 * Follows patterns from rules and tasks command registration.
 */
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import { createToolsIndexEmbeddingsCommand } from "./tools/index-embeddings-command";

/**
 * Register all tools commands in the shared command registry
 */
export function registerToolsCommands(): void {
  // Register tools index-embeddings command
  const indexEmbeddingsCommand = createToolsIndexEmbeddingsCommand();

  sharedCommandRegistry.registerCommand({
    id: indexEmbeddingsCommand.id,
    category: CommandCategory.DEBUG, // Using DEBUG category for now, could create TOOLS category later
    name: indexEmbeddingsCommand.name,
    description: indexEmbeddingsCommand.description,
    parameters: indexEmbeddingsCommand.parameters,
    execute: async (params: any, ctx: any) => {
      return await indexEmbeddingsCommand.execute(params, ctx);
    },
  });
}
