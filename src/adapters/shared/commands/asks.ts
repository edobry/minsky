/**
 * Shared Asks Commands
 *
 * Surfaces the Ask subsystem (mt#1034 / ADR-006) at the CLI/MCP layer.
 *
 * - `asks.list` — read-only inspection of Asks with optional state/kind filters.
 * - `asks.reconcile` — runs one reconcile pass over open quality.review Asks.
 *   Uses a production GithubReviewClient backed by `listReviews` infrastructure
 *   and routed through the project's TokenProvider. Wired as mt#1292.
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { log } from "../../../utils/logger";
import { DrizzleAskRepository, type AskRepository } from "../../../domain/ask/repository";
import type { Ask, AskKind, AskState } from "../../../domain/ask/types";
import { reconcile, type ReconcileResult } from "../../../domain/ask/reconciler";
import { SystemOperatorNotify } from "../../../domain/notify/operator-notify";
import type { AppContainerInterface } from "../../../composition/types";
import type { SqlCapablePersistenceProvider } from "../../../domain/persistence/types";
import { makeProductionGithubReviewClient } from "./asks-github-client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_STATES: AskState[] = [
  "detected",
  "classified",
  "routed",
  "suspended",
  "responded",
  "closed",
  "cancelled",
  "expired",
];

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
 * DB connection is available; callers should surface a clear error in that case.
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
    log.warn("asks: could not initialize AskRepository", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// asks.list
// ---------------------------------------------------------------------------

const asksListParams = {
  state: {
    schema: z.enum(ALL_STATES as [AskState, ...AskState[]]).optional(),
    description: "Filter by Ask state (detected | classified | routed | ...)",
    required: false,
  },
  kind: {
    schema: z.enum(ALL_KINDS as [AskKind, ...AskKind[]]).optional(),
    description: "Filter by Ask kind (quality.review | direction.decide | ...)",
    required: false,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of results",
    required: false,
    defaultValue: 50,
  },
};

interface AsksListResult {
  asks: Ask[];
  total: number;
  limit: number;
}

async function gatherAsks(
  repo: AskRepository,
  state: AskState | undefined,
  kind: AskKind | undefined
): Promise<Ask[]> {
  if (state) {
    const subset = await repo.listByState(state);
    return kind ? subset.filter((a) => a.kind === kind) : subset;
  }
  // No state filter — gather across all states.
  const all: Ask[] = [];
  for (const s of ALL_STATES) {
    const subset = await repo.listByState(s);
    all.push(...subset);
  }
  return kind ? all.filter((a) => a.kind === kind) : all;
}

// ---------------------------------------------------------------------------
// asks.reconcile
// ---------------------------------------------------------------------------

const asksReconcileParams = {};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the asks commands in the shared command registry.
 *
 * @param container Optional DI container — when provided, commands resolve
 *   the persistence provider from it to build the AskRepository.
 */
export function registerAsksCommands(container?: AppContainerInterface): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "asks.list",
      category: CommandCategory.TOOLS,
      name: "list",
      description: "List Asks with optional state and kind filters",
      requiresSetup: true,
      parameters: asksListParams,
      execute: async (params): Promise<AsksListResult> => {
        const repo = await buildAskRepository(container);
        if (!repo) {
          throw new Error(
            "asks.list: AskRepository unavailable — persistence provider does not support SQL"
          );
        }

        const state = params.state as AskState | undefined;
        const kind = params.kind as AskKind | undefined;
        const limit = (params.limit as number | undefined) ?? 50;

        const asks = await gatherAsks(repo, state, kind);
        return {
          asks: asks.slice(0, limit),
          total: asks.length,
          limit,
        };
      },
    })
  );

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "asks.reconcile",
      category: CommandCategory.TOOLS,
      name: "reconcile",
      description:
        "Run one reconcile pass over open quality.review Asks (polls GitHub for reviews and notifies the operator)",
      requiresSetup: true,
      parameters: asksReconcileParams,
      execute: async (): Promise<ReconcileResult> => {
        const repo = await buildAskRepository(container);
        if (!repo) {
          throw new Error(
            "asks.reconcile: AskRepository unavailable — persistence provider does not support SQL"
          );
        }

        // Build the token provider from project configuration — the same pattern
        // used by session-merge-operations and createRepositoryBackend.
        //
        // NOTE: reconcile hard-depends on initialized configuration. getConfiguration()
        // throws if initializeConfiguration() has not been called first (typically done
        // at process startup via the CLI/MCP adapter entry points). If reconcile is
        // invoked in a context where configuration is not yet initialised — e.g. a bare
        // programmatic call or a DI-container-less test harness — the catch block below
        // surfaces an actionable error rather than letting the raw throw propagate.
        let tokenProvider;
        try {
          const { getConfiguration } = await import("../../../domain/configuration/index");
          const { createTokenProvider } = await import("../../../domain/auth");
          const cfg = getConfiguration();
          const userToken = cfg.github?.token ?? "";
          const githubCfg = cfg.github ?? {};
          tokenProvider = createTokenProvider(githubCfg, userToken);
        } catch (err: unknown) {
          const cause = err instanceof Error ? err.message : String(err);
          throw new Error(
            `asks.reconcile requires Minsky configuration to be initialized. ` +
              `Run \`minsky setup\` (or the appropriate init step) before calling reconcile, ` +
              `or pass a pre-built TokenProvider through the DI container. Cause: ${cause}`,
            { cause: err instanceof Error ? err : new Error(String(err)) }
          );
        }

        const githubClient = makeProductionGithubReviewClient(tokenProvider);
        const operatorNotify = new SystemOperatorNotify();
        return reconcile(repo, githubClient, operatorNotify);
      },
    })
  );
}
