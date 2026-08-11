/**
 * Principal-corpus commands registration (mt#1930).
 *
 * Registration is container-free: commands read the persistence provider
 * from the per-call `ctx.container` at execute time, not from a closure
 * captured at registration. This means `registerAllSharedCommands()`
 * cannot fail to register principal-corpus commands when no container is
 * supplied — execution will simply throw a clear error if the container
 * is also missing at call time.
 */

import {
  sharedCommandRegistry,
  CommandCategory,
  pickAdapterBehaviorFlags,
  type CommandExecutionContext,
} from "../command-registry";
import { createPrincipalCorpusSearchCommand } from "./principal-corpus/search-command";
import { createPrincipalCorpusSimilarCommand } from "./principal-corpus/similar-command";
import { createPrincipalCorpusIndexEmbeddingsCommand } from "./principal-corpus/index-embeddings-command";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";

/**
 * Pull the persistence provider out of the execution context. Use from
 * inside a command's `execute` method. Throws a typed error naming the
 * caller's command id if no container is available; this is preferable
 * to silently degrading because the principal-corpus tools cannot
 * function without persistence (the corpus lives in pgvector).
 */
export function resolvePersistenceFromCtx(
  ctx: CommandExecutionContext,
  commandId: string
): PersistenceProvider {
  if (!ctx.container?.has("persistence")) {
    throw new Error(
      `${commandId}: persistence provider not available in execution context. ` +
        `Ensure the DI container is initialized before invoking this tool.`
    );
  }
  return ctx.container.get("persistence");
}

export function registerPrincipalCorpusCommands(): void {
  const searchCommand = createPrincipalCorpusSearchCommand();
  sharedCommandRegistry.registerCommand({
    id: searchCommand.id,
    category: CommandCategory.PRINCIPAL_CORPUS,
    name: searchCommand.name,
    description: searchCommand.description,
    parameters: searchCommand.parameters,
    // mt#3993: a behavior flag not named in a re-projection like this one is
    // dropped before any adapter can read it — the defect that made mt#3889's
    // presence-read exemption inert. None of the three commands here declares
    // one today; the spread keeps that true if one ever does.
    ...pickAdapterBehaviorFlags(searchCommand),
    execute: async (params, ctx: CommandExecutionContext) => {
      return searchCommand.execute(params as Parameters<typeof searchCommand.execute>[0], ctx);
    },
  });

  const similarCommand = createPrincipalCorpusSimilarCommand();
  sharedCommandRegistry.registerCommand({
    id: similarCommand.id,
    category: CommandCategory.PRINCIPAL_CORPUS,
    name: similarCommand.name,
    description: similarCommand.description,
    parameters: similarCommand.parameters,
    ...pickAdapterBehaviorFlags(similarCommand),
    execute: async (params, ctx: CommandExecutionContext) => {
      return similarCommand.execute(params as Parameters<typeof similarCommand.execute>[0], ctx);
    },
  });

  const indexCommand = createPrincipalCorpusIndexEmbeddingsCommand();
  sharedCommandRegistry.registerCommand({
    id: indexCommand.id,
    category: CommandCategory.PRINCIPAL_CORPUS,
    name: indexCommand.name,
    description: indexCommand.description,
    parameters: indexCommand.parameters,
    ...pickAdapterBehaviorFlags(indexCommand),
    execute: async (params, ctx: CommandExecutionContext) => {
      return indexCommand.execute(params as Parameters<typeof indexCommand.execute>[0], ctx);
    },
  });
}
