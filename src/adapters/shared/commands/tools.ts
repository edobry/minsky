/**
 * Tools Commands Registration
 *
 * Registers all tools-related commands in the shared command registry.
 * Follows patterns from rules and tasks command registration.
 */
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import { createToolsIndexEmbeddingsCommand } from "./tools/index-embeddings-command";
import { createToolsSearchCommand, createToolsSimilarCommand } from "./tools/similarity-commands";

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

  // Register tools search command
  const searchCommand = createToolsSearchCommand();

  sharedCommandRegistry.registerCommand({
    id: searchCommand.id,
    category: CommandCategory.DEBUG, // Using DEBUG category to match index-embeddings
    name: searchCommand.name,
    description: searchCommand.description,
    parameters: searchCommand.parameters,
    execute: async (params: any, ctx: any) => {
      return await searchCommand.execute(params, ctx);
    },
  });

  // Register tools similar command
  const similarCommand = createToolsSimilarCommand();

  sharedCommandRegistry.registerCommand({
    id: similarCommand.id,
    category: CommandCategory.DEBUG, // Using DEBUG category to match index-embeddings
    name: similarCommand.name,
    description: similarCommand.description,
    parameters: similarCommand.parameters,
    execute: async (params: any, ctx: any) => {
      return await similarCommand.execute(params, ctx);
    },
  });
}
