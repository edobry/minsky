/**
 * Attention Report Command
 *
 * Surfaces the attention-accounting subsystem (ADR-008 §Attention accounting)
 * as a shared command registered in the command registry.
 *
 * - `attention.report` — per-task or per-kind attention rollup report
 *
 * Reference: mt#1071, ADR-008.
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { log } from "@minsky/shared/logger";
import { DrizzleAskRepository, type AskRepository } from "@minsky/domain/ask/repository";
import type { AskKind } from "@minsky/domain/ask/types";
import {
  getRollupForTask,
  getRollupForKind,
  type TaskRollup,
  type KindRollup,
} from "@minsky/domain/ask/accounting/index";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_KINDS: AskKind[] = [
  "capability.escalate",
  "information.retrieve",
  "authorization.approve",
  "direction.decide",
  "coordination.notify",
  "quality.review",
  "stuck.unblock",
];

// ---------------------------------------------------------------------------
// Repository factory
// ---------------------------------------------------------------------------

/**
 * Build a `DrizzleAskRepository` from the persistence provider's DB connection.
 *
 * Returns null when the provider does not support SQL capability or when no
 * DB connection is available.
 */
async function buildAskRepository(
  container: AppContainerInterface | undefined
): Promise<AskRepository | null> {
  if (!container?.has("persistence")) return null;
  try {
    const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
    if (!persistenceProvider.getDatabaseConnection) return null;
    const db = await persistenceProvider.getDatabaseConnection();
    if (!db) return null;
    return new DrizzleAskRepository(db);
  } catch (err: unknown) {
    log.warn("attention: could not initialize AskRepository", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// attention.report
// ---------------------------------------------------------------------------

const attentionReportParams = {
  task: {
    schema: z.string().optional(),
    description: "Task ID to report on (e.g., mt#123). Mutually exclusive with --kind.",
    required: false,
  },
  kind: {
    schema: z.enum(ALL_KINDS as [AskKind, ...AskKind[]]).optional(),
    description: "Ask kind to report on. Returns top 10 most expensive tasks for this kind.",
    required: false,
  },
};

interface AttentionReportResult {
  mode: "task" | "kind";
  taskRollup?: TaskRollup;
  kindRollup?: KindRollup;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the attention commands in the shared command registry.
 *
 * @param container Optional DI container — when provided, commands resolve
 *   the persistence provider from it to build the AskRepository.
 */
export function registerAttentionCommands(container?: AppContainerInterface): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "attention.report",
      category: CommandCategory.TOOLS,
      name: "report",
      description:
        "Attention-cost report — per-task or per-kind rollup of Ask accounting data (ADR-008)",
      requiresSetup: true,
      parameters: attentionReportParams,
      execute: async (params): Promise<AttentionReportResult> => {
        const taskId = params.task as string | undefined;
        const kind = params.kind as AskKind | undefined;

        if (!taskId && !kind) {
          throw new Error("attention.report: one of --task or --kind is required");
        }
        if (taskId && kind) {
          throw new Error("attention.report: --task and --kind are mutually exclusive");
        }

        const repo = await buildAskRepository(container);
        if (!repo) {
          throw new Error(
            "attention.report: AskRepository unavailable — persistence provider does not support SQL"
          );
        }

        if (taskId) {
          const taskRollup = await getRollupForTask(repo, taskId);
          return { mode: "task", taskRollup };
        }

        // kind branch — at this point we've verified kind is defined (taskId is falsy)
        if (!kind) {
          throw new Error("attention.report: kind must be defined when task is not provided");
        }
        const kindRollup = await getRollupForKind(repo, kind);
        return { mode: "kind", kindRollup };
      },
    })
  );
}
