/**
 * Principal-corpus commands registration (mt#1930).
 */

import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
} from "../command-registry";
import { createPrincipalCorpusSearchCommand } from "./principal-corpus/search-command";
import { createPrincipalCorpusSimilarCommand } from "./principal-corpus/similar-command";
import { createPrincipalCorpusIndexEmbeddingsCommand } from "./principal-corpus/index-embeddings-command";
import type { AppContainerInterface } from "../../../composition/types";
import type { PersistenceProvider } from "../../../domain/persistence/types";

export function registerPrincipalCorpusCommands(container?: AppContainerInterface): void {
  const getPersistenceProvider = (): PersistenceProvider => {
    if (!container?.has("persistence")) {
      throw new Error(
        "Persistence provider not available. Ensure the DI container is initialized."
      );
    }
    return container.get("persistence");
  };

  const searchCommand = createPrincipalCorpusSearchCommand(getPersistenceProvider);
  sharedCommandRegistry.registerCommand({
    id: searchCommand.id,
    category: CommandCategory.PRINCIPAL_CORPUS,
    name: searchCommand.name,
    description: searchCommand.description,
    parameters: searchCommand.parameters,
    execute: async (params, ctx: CommandExecutionContext) => {
      return searchCommand.execute(params as Parameters<typeof searchCommand.execute>[0], ctx);
    },
  });

  const similarCommand = createPrincipalCorpusSimilarCommand(getPersistenceProvider);
  sharedCommandRegistry.registerCommand({
    id: similarCommand.id,
    category: CommandCategory.PRINCIPAL_CORPUS,
    name: similarCommand.name,
    description: similarCommand.description,
    parameters: similarCommand.parameters,
    execute: async (params, ctx: CommandExecutionContext) => {
      return similarCommand.execute(params as Parameters<typeof similarCommand.execute>[0], ctx);
    },
  });

  const indexCommand = createPrincipalCorpusIndexEmbeddingsCommand(getPersistenceProvider);
  sharedCommandRegistry.registerCommand({
    id: indexCommand.id,
    category: CommandCategory.PRINCIPAL_CORPUS,
    name: indexCommand.name,
    description: indexCommand.description,
    parameters: indexCommand.parameters,
    execute: async (params, ctx: CommandExecutionContext) => {
      return indexCommand.execute(params as Parameters<typeof indexCommand.execute>[0], ctx);
    },
  });
}
