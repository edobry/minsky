/**
 * Shared PR-Watch Commands
 *
 * Surfaces the PR-state watcher (mt#1295) at the CLI/MCP layer.
 *
 * Commands:
 *   pr.watch.create  — register a new PR watch
 *   pr.watch.list    — list active watches
 *   pr.watch.cancel  — remove a watch by ID
 *   pr.watch.run     — run one watcher pass (polls GitHub, fires notifications)
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { log } from "../../../utils/logger";
import {
  DrizzlePrWatchRepository,
  type PrWatchRepository,
  type CreatePrWatchInput,
} from "../../../domain/pr-watch/repository";
import type { PrWatch, PrWatchEvent } from "../../../domain/pr-watch/types";
import {
  runWatcher,
  stubGithubPrClient,
  type WatcherResult,
} from "../../../domain/pr-watch/watcher";
import { SystemOperatorNotify } from "../../../domain/notify/operator-notify";
import type { AppContainerInterface } from "../../../composition/types";
import type { SqlCapablePersistenceProvider } from "../../../domain/persistence/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_EVENTS: PrWatchEvent[] = ["merged", "review-posted", "check-status-changed"];

// ---------------------------------------------------------------------------
// Repository factory
// ---------------------------------------------------------------------------

/**
 * Build a `DrizzlePrWatchRepository` from the persistence provider's DB connection.
 *
 * Returns null when the provider does not support SQL capability or when no
 * DB connection is available; callers should surface a clear error in that case.
 */
async function buildPrWatchRepository(
  container: AppContainerInterface | undefined
): Promise<PrWatchRepository | null> {
  if (!container?.has("persistence")) return null;
  try {
    const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
    if (!persistenceProvider.getDatabaseConnection) return null;
    const db = await persistenceProvider.getDatabaseConnection();
    if (!db) return null;
    return new DrizzlePrWatchRepository(db);
  } catch (err: unknown) {
    log.warn("pr-watch: could not initialize PrWatchRepository", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// pr.watch.create
// ---------------------------------------------------------------------------

const prWatchCreateParams = {
  owner: {
    schema: z.string().min(1),
    description: "GitHub repository owner (user or org)",
    required: true,
  },
  repo: {
    schema: z.string().min(1),
    description: "GitHub repository name",
    required: true,
  },
  number: {
    schema: z.number().int().positive(),
    description: "Pull request number",
    required: true,
  },
  event: {
    schema: z.enum(ALL_EVENTS as [PrWatchEvent, ...PrWatchEvent[]]).optional(),
    description:
      "Which PR event to watch for: merged | review-posted | check-status-changed (default: merged)",
    required: false,
    defaultValue: "merged" as PrWatchEvent,
  },
  keep: {
    schema: z.boolean().optional(),
    description:
      "If true, the watch persists after firing (re-fires on subsequent events). Default: false (one-shot)",
    required: false,
    defaultValue: false,
  },
  watcherId: {
    schema: z.string().optional(),
    description:
      "Watcher identity in {kind}:{scope}:{id} format. Defaults to operator:local:default",
    required: false,
    defaultValue: "operator:local:default",
  },
};

// ---------------------------------------------------------------------------
// pr.watch.list
// ---------------------------------------------------------------------------

const prWatchListParams = {};

// ---------------------------------------------------------------------------
// pr.watch.cancel
// ---------------------------------------------------------------------------

const prWatchCancelParams = {
  id: {
    schema: z.string().min(1),
    description: "Watch ID to cancel (from pr.watch.list output)",
    required: true,
  },
};

// ---------------------------------------------------------------------------
// pr.watch.run
// ---------------------------------------------------------------------------

const prWatchRunParams = {};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the pr-watch commands in the shared command registry.
 *
 * @param container Optional DI container — when provided, commands resolve
 *   the persistence provider from it to build the PrWatchRepository.
 */
export function registerPrWatchCommands(container?: AppContainerInterface): void {
  // -------------------------------------------------------------------------
  // pr.watch.create
  // -------------------------------------------------------------------------
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "pr.watch.create",
      category: CommandCategory.TOOLS,
      name: "create",
      description: "Register a watch on a GitHub PR. Fires a notification when the event occurs.",
      requiresSetup: true,
      parameters: prWatchCreateParams,
      execute: async (params): Promise<PrWatch> => {
        const prWatchRepository = await buildPrWatchRepository(container);
        if (!prWatchRepository) {
          throw new Error(
            "pr.watch.create: PrWatchRepository unavailable — persistence provider does not support SQL"
          );
        }

        const input: CreatePrWatchInput = {
          prOwner: params.owner as string,
          prRepo: params.repo as string,
          prNumber: params.number as number,
          event: (params.event as PrWatchEvent | undefined) ?? "merged",
          keep: (params.keep as boolean | undefined) ?? false,
          watcherId: (params.watcherId as string | undefined) ?? "operator:local:default",
        };

        const watch = await prWatchRepository.create(input);
        log.info("pr.watch.create: watch registered", {
          id: watch.id,
          pr: `${watch.prOwner}/${watch.prRepo}#${watch.prNumber}`,
          event: watch.event,
          keep: watch.keep,
        });
        return watch;
      },
    })
  );

  // -------------------------------------------------------------------------
  // pr.watch.list
  // -------------------------------------------------------------------------
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "pr.watch.list",
      category: CommandCategory.TOOLS,
      name: "list",
      description: "List all active PR watches",
      requiresSetup: true,
      parameters: prWatchListParams,
      execute: async (): Promise<{ watches: PrWatch[]; total: number }> => {
        const prWatchRepository = await buildPrWatchRepository(container);
        if (!prWatchRepository) {
          throw new Error(
            "pr.watch.list: PrWatchRepository unavailable — persistence provider does not support SQL"
          );
        }

        const watches = await prWatchRepository.listActive();
        return { watches, total: watches.length };
      },
    })
  );

  // -------------------------------------------------------------------------
  // pr.watch.cancel
  // -------------------------------------------------------------------------
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "pr.watch.cancel",
      category: CommandCategory.TOOLS,
      name: "cancel",
      description: "Cancel (delete) a PR watch by ID",
      requiresSetup: true,
      parameters: prWatchCancelParams,
      execute: async (params): Promise<{ cancelled: string }> => {
        const prWatchRepository = await buildPrWatchRepository(container);
        if (!prWatchRepository) {
          throw new Error(
            "pr.watch.cancel: PrWatchRepository unavailable — persistence provider does not support SQL"
          );
        }

        const id = params.id as string;
        await prWatchRepository.delete(id);
        log.info("pr.watch.cancel: watch cancelled", { id });
        return { cancelled: id };
      },
    })
  );

  // -------------------------------------------------------------------------
  // pr.watch.run
  // -------------------------------------------------------------------------
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "pr.watch.run",
      category: CommandCategory.TOOLS,
      name: "run",
      description:
        "Run one watcher pass: poll GitHub for all active watches and fire notifications on matches. In v1, uses a stub GitHub client (production wiring is a follow-up to mt#1295).",
      requiresSetup: true,
      parameters: prWatchRunParams,
      execute: async (): Promise<WatcherResult> => {
        const prWatchRepository = await buildPrWatchRepository(container);
        if (!prWatchRepository) {
          throw new Error(
            "pr.watch.run: PrWatchRepository unavailable — persistence provider does not support SQL"
          );
        }

        const operatorNotify = new SystemOperatorNotify();
        return runWatcher(prWatchRepository, stubGithubPrClient, operatorNotify);
      },
    })
  );
}
