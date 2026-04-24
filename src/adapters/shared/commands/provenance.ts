/**
 * Provenance Commands
 *
 * Commands for reading the full provenance record for an artifact.
 * Retroactive tier recomputation has been moved to the `authorship` namespace
 * (`authorship.recompute`). See `authorship.ts`.
 *
 * DI assumption: `context.container?.has("persistence")` at execute time is
 * effectively a registration-time capture because
 * `src/adapters/mcp/shared-command-integration.ts:186-191` always populates
 * `context.container` from `config.container` when the command is invoked through
 * the MCP bridge. If the MCP bridge is ever changed to use per-request containers,
 * all commands in both `provenance.ts` and `authorship.ts` that check
 * `context.container?.has("persistence")` will break in the same way.
 *
 * @see mt#1085 — provenance.get shared command (MCP exposure)
 * @see mt#1254 — authorship namespace introduction; recompute moved there
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import type { SharedCommandRegistry } from "../command-registry";
import { log } from "../../../utils/logger";
import { getErrorMessage } from "../../../errors/index";
import type { AppContainerInterface } from "../../../composition/types";
import { ARTIFACT_TYPES } from "../../../domain/provenance/types";
import type { ArtifactType } from "../../../domain/provenance/types";

const artifactTypeSchema = z.enum(ARTIFACT_TYPES);

/**
 * Register all provenance-related shared commands.
 *
 * @param _container Optional DI container (unused at registration time; resolved at execute time)
 * @param registry   Optional registry to register into (defaults to global sharedCommandRegistry).
 *                   Pass a fresh registry in tests to avoid global state mutation.
 */
export function registerProvenanceCommands(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  // ── provenance.get ────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "provenance.get",
    category: CommandCategory.PROVENANCE,
    name: "get",
    description: "Look up the provenance record for a specific artifact by ID and type.",
    parameters: {
      artifactId: {
        schema: z.string(),
        description: "The artifact identifier (e.g. PR number as string, commit SHA)",
        required: true,
      },
      artifactType: {
        schema: artifactTypeSchema,
        description: `Type of artifact. One of: ${ARTIFACT_TYPES.join(", ")}`,
        required: true,
      },
    },
    async execute(params, context) {
      const { artifactId, artifactType } = params;

      try {
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
              "provenance.get requires a PostgreSQL or SQLite backend with Drizzle ORM."
          );
        }

        const { ProvenanceService } = await import("../../../domain/provenance/provenance-service");
        const provenanceService = new ProvenanceService(
          db as import("drizzle-orm/postgres-js").PostgresJsDatabase
        );

        const record = await provenanceService.getProvenanceForArtifact(
          artifactId,
          artifactType as ArtifactType
        );

        return record;
      } catch (error) {
        log.error("provenance.get failed", { error: getErrorMessage(error) });
        throw error;
      }
    },
  });

  log.debug("Provenance commands registered");
}
