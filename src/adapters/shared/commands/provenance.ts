/**
 * Provenance Commands
 *
 * Commands for reading the full provenance record for an artifact.
 * Retroactive tier recomputation has been moved to the `authorship` namespace
 * (`authorship.recompute`). See `authorship.ts`.
 *
 * `provenance.recompute` is retained as a deprecated compatibility alias that
 * forwards to `authorship.recompute`. Any existing automation or CLI scripts
 * calling `provenance.recompute` will continue to work; a console.warn is
 * emitted on every invocation to prompt migration.
 *
 * DI assumption: `context.container?.has("persistence")` at execute time is
 * effectively a registration-time capture because
 * `src/adapters/mcp/shared-command-integration.ts (registration site)` always
 * populates `context.container` from `config.container` when the command is
 * invoked through the MCP bridge. If the MCP bridge is ever changed to use
 * per-request containers, all commands in both `provenance.ts` and
 * `authorship.ts` that check `context.container?.has("persistence")` will
 * break in the same way.
 *
 * @see mt#1085 — provenance.get shared command (MCP exposure)
 * @see mt#1254 — authorship namespace introduction; recompute moved there
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import type { SharedCommandRegistry, CommandExecutionContext } from "../command-registry";
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

  // ── provenance.recompute (deprecated alias) ───────────────────────────────
  // `authorship.recompute` is the canonical command since mt#1254. This alias
  // is preserved for backward compatibility with existing automation / CLI
  // scripts that call `provenance.recompute`. It emits a deprecation warning
  // on every invocation and delegates to the real handler at execute-time.
  targetRegistry.registerCommand({
    id: "provenance.recompute",
    category: CommandCategory.PROVENANCE,
    name: "recompute",
    description:
      "[DEPRECATED] Use `authorship.recompute` instead. " +
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
    async execute(params, context: CommandExecutionContext) {
      log.warn("provenance.recompute is deprecated; use authorship.recompute");

      // Delegate to authorship.recompute at execute-time so the alias works
      // regardless of registration order. The authorship commands must be
      // registered before any invocation reaches this handler.
      const authorshipRecompute = targetRegistry.getCommand("authorship.recompute");
      if (!authorshipRecompute) {
        throw new Error(
          "provenance.recompute alias: authorship.recompute is not registered. " +
            "Ensure registerAuthorshipCommands() is called before invoking this command."
        );
      }

      return authorshipRecompute.execute(params, context);
    },
  });

  log.debug("Provenance commands registered");
}
