/**
 * Provenance Commands
 *
 * Commands for managing authorship provenance records, including retroactive
 * tier recomputation using the current judging policy.
 *
 * @see mt#970 — Retroactive tier recomputation command
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import { log } from "../../../utils/logger";
import { getErrorMessage } from "../../../errors/index";
import type { AppContainerInterface } from "../../../composition/types";

/**
 * Register all provenance-related shared commands.
 */
export function registerProvenanceCommands(_container?: AppContainerInterface): void {
  sharedCommandRegistry.registerCommand({
    id: "provenance.recompute",
    category: CommandCategory.PROVENANCE,
    name: "recompute",
    description:
      "Retroactively recompute authorship tiers for all historical provenance records " +
      "using the current judging policy.",
    parameters: {
      dryRun: {
        schema: z.boolean(),
        description: "Show what would change without applying updates (default: false)",
        required: false,
        defaultValue: false,
      },
    },
    async execute(params, context) {
      const { dryRun = false } = params;

      try {
        // Resolve the persistence provider from DI container or fall back to a
        // fresh PersistenceService (same pattern used by cli.ts).
        const persistenceProvider = (() => {
          if (context.container?.has("persistence")) {
            return context.container.get(
              "persistence"
            ) as import("../../../domain/persistence/types").SqlCapablePersistenceProvider;
          }
          return null;
        })();

        if (!persistenceProvider) {
          throw new Error(
            "DI container missing 'persistence'. " +
              "Ensure the container was initialized before running this command."
          );
        }

        const db = await persistenceProvider.getDatabaseConnection();
        if (!db) {
          throw new Error(
            "getDatabaseConnection() returned null. " +
              "Provenance recomputation requires a PostgreSQL or SQLite backend with Drizzle ORM."
          );
        }

        // Import domain services
        const { ProvenanceService } = await import("../../../domain/provenance/provenance-service");
        const { TranscriptService } = await import("../../../domain/provenance/transcript-service");
        const { AuthorshipJudge } = await import("../../../domain/provenance/authorship-judge");
        const { createCompletionService } = await import("../../../domain/ai/service-factory");
        const { requireAIProviders } = await import("../../../domain/ai/provider-operations");
        const { getResolvedConfig } = await import("./ai/shared-helpers");
        const resolvedConfig = getResolvedConfig();

        // Validate that at least one AI provider is configured.
        requireAIProviders(resolvedConfig);

        const completionService = createCompletionService(resolvedConfig);

        const provenanceService = new ProvenanceService(
          db as import("drizzle-orm/postgres-js").PostgresJsDatabase
        );
        const transcriptService = new TranscriptService(
          db as import("drizzle-orm/postgres-js").PostgresJsDatabase
        );
        const judge = new AuthorshipJudge(completionService);

        if (dryRun) {
          log.cli("Running in dry-run mode — no changes will be applied.");
        }

        const summary = await provenanceService.recomputeAll({
          dryRun,
          judge,
          transcriptService,
        });

        return summary;
      } catch (error) {
        log.error("provenance.recompute failed", { error: getErrorMessage(error) });
        throw error;
      }
    },
  });

  log.debug("Provenance commands registered");
}
