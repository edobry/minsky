/**
 * Authorship Commands
 *
 * Commands for reading narrow authorship verdicts and managing retroactive
 * tier recomputation. The `authorship` namespace is a least-privilege projection
 * of the `provenance` namespace: it exposes only the fields a reviewer (or any
 * other consumer that only needs the authorship verdict) should see, without
 * leaking the full provenance record.
 *
 * DI assumption: `context.container?.has("persistence")` at execute time is
 * effectively a registration-time capture because
 * `src/adapters/mcp/shared-command-integration.ts (registration site)` always
 * populates `context.container` from `config.container` when the command is
 * invoked through the MCP bridge. If the MCP bridge is ever changed to use per-request containers,
 * all commands in both `authorship.ts` and `provenance.ts` that check
 * `context.container?.has("persistence")` will break in the same way.
 *
 * @see mt#1254 — Authorship namespace introduction
 * @see mt#1085 — provenance.get MCP exposure (origin of provenance commands)
 * @see mt#1227 — Parent: deferred findings from PR #751
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
 * Narrow authorship result shape — only the verdict fields, not the full
 * provenance record. This is the shape returned by `authorship.get` and the
 * shape the reviewer bot reads.
 *
 * Fields intentionally excluded: `transcriptId`, `participants`,
 * `substantiveHumanInput`, `trajectoryChanges`, `artifactId`, `artifactType`,
 * `taskId`, `sessionId`, `taskOrigin`, `specAuthorship`, `initiationMode`,
 * `humanMessages`, `totalMessages`, `corrections`, and audit timestamps.
 */
export interface AuthorshipResult {
  tier: number | null;
  rationale?: string;
  policyVersion?: string;
  judgingModel?: string;
}

/**
 * Register all authorship-related shared commands.
 *
 * `authorship.get`     — narrow projection of the provenance record (tier verdict only)
 * `authorship.recompute` — retroactive tier recomputation (moved from provenance namespace)
 *
 * @param _container Optional DI container (unused at registration time; resolved at execute time)
 * @param registry   Optional registry to register into (defaults to global sharedCommandRegistry).
 *                   Pass a fresh registry in tests to avoid global state mutation.
 */
export function registerAuthorshipCommands(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  // ── authorship.get ────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "authorship.get",
    category: CommandCategory.AUTHORSHIP,
    name: "get",
    description:
      "Look up the authorship verdict for a specific artifact. Returns a narrow projection " +
      "({ tier, rationale?, policyVersion?, judgingModel? }) — does NOT expose the full " +
      "provenance record fields such as transcriptId, participants, substantiveHumanInput, " +
      "or trajectoryChanges.",
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
    async execute(params, context): Promise<AuthorshipResult | null> {
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
              "authorship.get requires a PostgreSQL or SQLite backend with Drizzle ORM."
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

        if (record === null) {
          return null;
        }

        // Return the narrow projection only — do not leak full record fields.
        const result: AuthorshipResult = {
          tier: record.authorshipTier,
        };
        if (record.tierRationale != null) {
          result.rationale = record.tierRationale;
        }
        if (record.policyVersion != null) {
          result.policyVersion = record.policyVersion;
        }
        if (record.judgingModel != null) {
          result.judgingModel = record.judgingModel;
        }

        return result;
      } catch (error) {
        log.error("authorship.get failed", { error: getErrorMessage(error) });
        throw error;
      }
    },
  });

  // ── authorship.recompute ──────────────────────────────────────────────────
  // Moved verbatim from provenance.recompute — same behavior, new namespace.
  targetRegistry.registerCommand({
    id: "authorship.recompute",
    category: CommandCategory.AUTHORSHIP,
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
              "Authorship recomputation requires a PostgreSQL or SQLite backend with Drizzle ORM."
          );
        }

        // Import domain services
        const { ProvenanceService } = await import("../../../domain/provenance/provenance-service");
        const { AgentTranscriptService } = await import(
          "../../../domain/provenance/transcript-service"
        );
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
        const transcriptService = new AgentTranscriptService(
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
        log.error("authorship.recompute failed", { error: getErrorMessage(error) });
        throw error;
      }
    },
  });

  log.debug("Authorship commands registered");
}
