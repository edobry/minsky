/**
 * Tools Commands Registration
 *
 * Registers all tools-related commands in the shared command registry.
 * Follows patterns from rules and tasks command registration.
 */
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
} from "../command-registry";
import { createToolsIndexEmbeddingsCommand } from "./tools/index-embeddings-command";
import { createToolsSearchCommand, createToolsSimilarCommand } from "./tools/similarity-commands";
import type { AppContainerInterface } from "../../../composition/types";

/**
 * Register all tools commands in the shared command registry
 */
export function registerToolsCommands(container?: AppContainerInterface): void {
  const getPersistenceProvider = () => {
    if (!container?.has("persistence")) {
      throw new Error(
        "Persistence provider not available. Ensure the DI container is initialized."
      );
    }
    return container.get("persistence");
  };

  // Register tools index-embeddings command
  const indexEmbeddingsCommand = createToolsIndexEmbeddingsCommand();

  sharedCommandRegistry.registerCommand({
    id: indexEmbeddingsCommand.id,
    category: CommandCategory.TOOLS,
    name: indexEmbeddingsCommand.name,
    description: indexEmbeddingsCommand.description,
    parameters: indexEmbeddingsCommand.parameters,
    execute: async (params, ctx: CommandExecutionContext) => {
      return await indexEmbeddingsCommand.execute(
        params as Parameters<typeof indexEmbeddingsCommand.execute>[0],
        ctx
      );
    },
  });

  // Register tools search command
  const searchCommand = createToolsSearchCommand(getPersistenceProvider);

  sharedCommandRegistry.registerCommand({
    id: searchCommand.id,
    category: CommandCategory.TOOLS,
    name: searchCommand.name,
    description: searchCommand.description,
    parameters: searchCommand.parameters,
    execute: async (params, ctx: CommandExecutionContext) => {
      return await searchCommand.execute(
        params as Parameters<typeof searchCommand.execute>[0],
        ctx
      );
    },
  });

  // Register tools similar command
  const similarCommand = createToolsSimilarCommand(getPersistenceProvider);

  sharedCommandRegistry.registerCommand({
    id: similarCommand.id,
    category: CommandCategory.TOOLS,
    name: similarCommand.name,
    description: similarCommand.description,
    parameters: similarCommand.parameters,
    execute: async (params, ctx: CommandExecutionContext) => {
      return await similarCommand.execute(
        params as Parameters<typeof similarCommand.execute>[0],
        ctx
      );
    },
  });
}
