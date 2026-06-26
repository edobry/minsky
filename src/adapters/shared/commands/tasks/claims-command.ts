/**
 * tasks.claims MCP command — mt#2562.
 *
 * Surfaces who is actively working on a given task right now, independent
 * of whether a Minsky workspace session exists.
 *
 * Tools registered:
 *   tasks_claims_list  — list active presence claims for a task.
 */

import { z } from "zod";
import { defineCommand, CommandCategory } from "../../command-registry";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { buildPresenceClaimRepository, PRESENCE_CLAIM_TTL_MS } from "@minsky/domain/presence/index";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Parameter map
// ---------------------------------------------------------------------------

const tasksClaimsListParams = {
  taskId: {
    schema: z.string(),
    description: 'Task identifier (e.g. "mt#2562" or "2562")',
    required: true,
  },
  staleThresholdMs: {
    schema: z.number().optional(),
    description: `Age in milliseconds past which a claim is considered stale (default: ${PRESENCE_CLAIM_TTL_MS} = 15 min)`,
    required: false,
  },
  includeStale: {
    schema: z.boolean().default(false),
    description: "Include stale claims in the result (default: false)",
    required: false,
  },
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build and return the `tasks_claims_list` command definition.
 *
 * The command is best-effort: when the persistence provider or DB connection
 * is unavailable it returns an empty result rather than throwing.
 */
export function createTasksClaimsListCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.claims.list",
    category: CommandCategory.TASKS,
    name: "list",
    description:
      "List active presence claims for a task — who is actively working on it right now.",
    parameters: tasksClaimsListParams,

    async execute(params) {
      const { taskId, staleThresholdMs = PRESENCE_CLAIM_TTL_MS, includeStale = false } = params;

      const subjectId = taskId.trim();

      try {
        const provider = getPersistenceProvider() as SqlCapablePersistenceProvider | undefined;
        if (!provider?.getDatabaseConnection) {
          log.debug("[tasks.claims.list] No SQL persistence provider available");
          return { claims: [], taskId: subjectId };
        }

        const db = await provider.getDatabaseConnection();
        const repo = buildPresenceClaimRepository(db);
        if (!repo) {
          log.debug("[tasks.claims.list] Could not build PresenceClaimRepository");
          return { claims: [], taskId: subjectId };
        }

        const threshold = staleThresholdMs ?? PRESENCE_CLAIM_TTL_MS;
        const annotated = await repo.listClaims("task", subjectId, threshold);
        const claims = includeStale ? annotated : annotated.filter((c) => !c.stale);

        return {
          claims,
          taskId: subjectId,
          total: annotated.length,
          fresh: annotated.filter((c) => !c.stale).length,
          stale: annotated.filter((c) => c.stale).length,
        };
      } catch (err: unknown) {
        log.warn("[tasks.claims.list] Presence claim list failed", {
          taskId: subjectId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { claims: [], taskId: subjectId, error: String(err) };
      }
    },
  });
}
