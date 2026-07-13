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
import { log } from "@minsky/shared/logger";
import {
  DrizzlePrWatchRepository,
  type PrWatchRepository,
  type CreatePrWatchInput,
} from "@minsky/domain/pr-watch/repository";
import type { PrWatch, PrWatchEvent } from "@minsky/domain/pr-watch/types";
import { runWatcher, type WatcherResult } from "@minsky/domain/pr-watch/watcher";
import { makeProductionGithubPrClient } from "@minsky/domain/pr-watch/github-client";
import { SystemOperatorNotify } from "@minsky/domain/notify/operator-notify";
import {
  CompositeWakeSignalSink,
  LoggingWakeSignalSink,
  PersistentWakeSignalSink,
  type WakeSignalSink,
} from "@minsky/domain/ask/wake-on-respond";
import { DrizzleWakePendingRepository } from "@minsky/domain/ask/wake-pending-repository";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

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
// TokenProvider factory
// ---------------------------------------------------------------------------

/**
 * Build a TokenProvider from the project's standard configuration.
 *
 * Mirrors the pattern used in reviewer-watch.ts — lazy dynamic import so
 * this module remains importable without a live config (e.g. in tests).
 */
async function buildTokenProviderFromConfig(): Promise<{
  tokenProvider: import("@minsky/domain/auth").TokenProvider;
}> {
  try {
    const { getConfiguration } = await import("@minsky/domain/configuration/index");
    const { createTokenProvider } = await import("@minsky/domain/auth");
    const cfg = getConfiguration();
    const userToken = cfg.github?.token ?? "";
    const tokenProvider = createTokenProvider(cfg.github ?? {}, userToken);
    return { tokenProvider };
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      "pr.watch.run requires Minsky configuration to be initialized. " +
        "Run `minsky setup` (or the appropriate init step) before calling pr.watch.run. " +
        `Cause: ${cause}`,
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
}

// ---------------------------------------------------------------------------
// Session extraction from MCP call context
// ---------------------------------------------------------------------------

/**
 * Extract a Minsky session UUID from the MCP tool call parameters.
 *
 * Pattern established by `memory-enrichment.ts` and the wake-enrichment
 * middleware: callers may pass the session as `session`, `sessionId`, `task`,
 * or `taskId`. For `pr_watch_create`, the relevant field is `session` or
 * `sessionId` — the registering agent's own conversation context.
 *
 * Returns the first non-empty string found, or `undefined` when no resolvable
 * session arg is present. When `undefined`, the watch is stored with null
 * `parentSessionId` and telemetered as `pr_watch.no_session_id`.
 */
function extractSessionId(params: Record<string, unknown>): string | undefined {
  for (const key of ["session", "sessionId"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Composite WakeSignalSink factory
// ---------------------------------------------------------------------------

/**
 * Build a `CompositeWakeSignalSink` for `pr_watch_run` that fans out wake
 * events to the logging sink + the persistent sink (when persistence is
 * available). Mirrors the pattern from `asks.ts:buildCompositeWakeSink`.
 *
 * When the persistence provider is unavailable, falls back to logging-only
 * so the watcher keeps working.
 */
async function buildCompositeWakeSink(
  container: AppContainerInterface | undefined
): Promise<WakeSignalSink> {
  const sinks: WakeSignalSink[] = [new LoggingWakeSignalSink()];

  if (container?.has("persistence")) {
    try {
      const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
      if (persistenceProvider.getDatabaseConnection) {
        const db = await persistenceProvider.getDatabaseConnection();
        if (db) {
          sinks.push(new PersistentWakeSignalSink(new DrizzleWakePendingRepository(db)));
        }
      }
    } catch (err: unknown) {
      log.warn("pr.watch.run: could not initialize PersistentWakeSignalSink", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return new CompositeWakeSignalSink(sinks);
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
  session: {
    schema: z.string().optional(),
    description:
      "Minsky session UUID of the registering agent. When provided, the wake signal is routed " +
      "to this session via enrichWakeResponse on the next allowlisted MCP tool call (mt#1725).",
    required: false,
  },
  sessionId: {
    schema: z.string().optional(),
    description: "Alias for session. The first non-empty value of session/sessionId is used.",
    required: false,
  },
};

// ---------------------------------------------------------------------------
// pr.watch.list
// ---------------------------------------------------------------------------

const prWatchListParams = {
  session: {
    schema: z.string().optional(),
    description:
      "Filter watches by registering session's parentSessionId. When provided, only watches " +
      "registered by this session are returned, AND the wake-enrichment middleware can route " +
      "pending wakes to the calling session on this tool call (mt#1755).",
    required: false,
  },
  sessionId: {
    schema: z.string().optional(),
    description: "Alias for session. The first non-empty value of session/sessionId is used.",
    required: false,
  },
};

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

        // Extract the registering agent's session UUID from the MCP call params.
        // This is used for wake-signal routing: when the watch fires, the wake
        // signal is delivered to this session via enrichWakeResponse (mt#1725).
        const parentSessionId = extractSessionId(params as Record<string, unknown>);
        if (!parentSessionId) {
          log.cli(
            `pr_watch.no_session_id ${JSON.stringify({
              event: "pr_watch.no_session_id",
              reason: "no session or sessionId in params at registration time",
              pr: `${params.owner as string}/${params.repo as string}#${params.number as number}`,
            })}`
          );
        }

        const input: CreatePrWatchInput = {
          prOwner: params.owner as string,
          prRepo: params.repo as string,
          prNumber: params.number as number,
          event: (params.event as PrWatchEvent | undefined) ?? "merged",
          keep: (params.keep as boolean | undefined) ?? false,
          watcherId: (params.watcherId as string | undefined) ?? "operator:local:default",
          parentSessionId,
        };

        const watch = await prWatchRepository.create(input);
        log.info("pr.watch.create: watch registered", {
          id: watch.id,
          pr: `${watch.prOwner}/${watch.prRepo}#${watch.prNumber}`,
          event: watch.event,
          keep: watch.keep,
          parentSessionId: watch.parentSessionId ?? "(none)",
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
      description: "List all active PR watches, optionally filtered by registering session",
      requiresSetup: true,
      parameters: prWatchListParams,
      execute: async (params): Promise<{ watches: PrWatch[]; total: number }> => {
        const prWatchRepository = await buildPrWatchRepository(container);
        if (!prWatchRepository) {
          throw new Error(
            "pr.watch.list: PrWatchRepository unavailable — persistence provider does not support SQL"
          );
        }

        const allWatches = await prWatchRepository.listActive();
        const sessionFilter = extractSessionId(params);
        const watches = sessionFilter
          ? allWatches.filter((w) => w.parentSessionId === sessionFilter)
          : allWatches;
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
        "Run one watcher pass: poll GitHub for all active watches and fire notifications on matches.",
      requiresSetup: true,
      parameters: prWatchRunParams,
      execute: async (): Promise<WatcherResult> => {
        const prWatchRepository = await buildPrWatchRepository(container);
        if (!prWatchRepository) {
          throw new Error(
            "pr.watch.run: PrWatchRepository unavailable — persistence provider does not support SQL"
          );
        }

        const { tokenProvider } = await buildTokenProviderFromConfig();
        const githubClient = makeProductionGithubPrClient(tokenProvider);
        const operatorNotify = new SystemOperatorNotify();
        // mt#1725: compose LoggingWakeSignalSink + PersistentWakeSignalSink so
        // fired watches route wake signals to the registering agent's session.
        // The persistent sink writes to wake_pending; enrichWakeResponse drains
        // it on the agent's next allowlisted tool call (pull-on-tool-call delivery).
        const wakeSink = await buildCompositeWakeSink(container);

        // Resolve EventEmitter for system event emission (mt#2134).
        let eventEmitter: import("@minsky/domain/events/emitter").EventEmitter | undefined;
        try {
          if (container?.has("persistence")) {
            const pp = container.get(
              "persistence"
            ) as import("@minsky/domain/persistence/types").SqlCapablePersistenceProvider;
            if (pp.getDatabaseConnection) {
              const db = await pp.getDatabaseConnection();
              if (db) {
                const { createEventEmitter } = await import("@minsky/domain/events/emitter");
                eventEmitter = createEventEmitter(db);
              }
            }
          }
        } catch (emitErr: unknown) {
          log.warn(
            "pr.watch.run: EventEmitter resolution failed (proceeding without event emission)",
            {
              error: emitErr instanceof Error ? emitErr.message : String(emitErr),
            }
          );
        }

        return runWatcher(prWatchRepository, githubClient, operatorNotify, wakeSink, eventEmitter);
      },
    })
  );
}
