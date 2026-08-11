/**
 * Tools Commands Registration
 *
 * Registers all tools-related commands in the shared command registry.
 * Follows patterns from rules and tasks command registration.
 */
import {
  sharedCommandRegistry,
  CommandCategory,
  pickAdapterBehaviorFlags,
  type CommandExecutionContext,
} from "../command-registry";
import { createToolsIndexEmbeddingsCommand } from "./tools/index-embeddings-command";
import { createToolsSearchCommand, createToolsSimilarCommand } from "./tools/similarity-commands";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

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
    // mt#3993: these re-projections rebuild the definition field-by-field, so a
    // behavior flag not named here is dropped before any adapter can read it —
    // the defect that made mt#3889's presence-read exemption inert. None of the
    // three commands below declares one today; the spread is what keeps that
    // true if one ever does.
    ...pickAdapterBehaviorFlags(indexEmbeddingsCommand),
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
    ...pickAdapterBehaviorFlags(searchCommand),
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
    ...pickAdapterBehaviorFlags(similarCommand),
    execute: async (params, ctx: CommandExecutionContext) => {
      return await similarCommand.execute(
        params as Parameters<typeof similarCommand.execute>[0],
        ctx
      );
    },
  });
}
