/**
 * Shared Asks Commands
 *
 * Surfaces the Ask subsystem (mt#1034 / ADR-008) at the CLI/MCP layer.
 *
 * - `asks.list` — read-only inspection of Asks with optional state/kind filters.
 * - `asks.reconcile` — runs one reconcile pass over open quality.review Asks.
 *   Uses a production GithubReviewClient backed by `listReviews` infrastructure
 *   and routed through the project's TokenProvider. Wired as mt#1292.
 * - `asks.create` — agent-facing producer surface. Persists a new Ask via
 *   `AskRepository` and computes routing via mt#1069's `policyFirstRoute`.
 *   The capability-aware extension (sync kinds → elicitation when host
 *   advertises capability) lands in mt#1457. Wired as mt#1456.
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { log } from "../../../utils/logger";
import {
  DrizzleAskRepository,
  type AskRepository,
  type CreateAskInput,
} from "../../../domain/ask/repository";
import type { Ask, AskKind, AskState, AskOption, ContextRef } from "../../../domain/ask/types";
import { reconcile, type ReconcileResult } from "../../../domain/ask/reconciler";
import {
  policyFirstRoute,
  type RoutedAsk,
  type PolicyFirstRouteOptions,
} from "../../../domain/ask/router";
import {
  dispatchToElicitation,
  type ElicitationClosedAsk,
} from "../../../domain/ask/transports/elicitation";
import { SystemOperatorNotify } from "../../../domain/notify/operator-notify";
import type { AppContainerInterface } from "../../../composition/types";
import type { SqlCapablePersistenceProvider } from "../../../domain/persistence/types";
import type { ClientCapabilityRegistry } from "../../../mcp/client-capabilities";
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
// asks.create — schemas
// ---------------------------------------------------------------------------

const askOptionSchema = z.object({
  label: z.string(),
  value: z.unknown(),
  description: z.string().optional(),
});

const contextRefSchema = z.object({
  kind: z.string(),
  ref: z.string(),
  description: z.string().optional(),
});

const asksCreateParams = {
  kind: {
    schema: z.enum(ALL_KINDS as [AskKind, ...AskKind[]]),
    description: "Ask kind (one of the 7 ADR-008 taxonomy values)",
    required: true,
  },
  title: {
    schema: z.string().min(1),
    description: "Short summary line used for list rendering and notifications",
    required: true,
  },
  question: {
    schema: z.string().min(1),
    description: "Full ask body — what the requestor needs resolved",
    required: true,
  },
  options: {
    schema: z.array(askOptionSchema).optional(),
    description: "Decision frame: array of {label, value, description?}; for decision-like kinds",
    required: false,
  },
  contextRefs: {
    schema: z.array(contextRefSchema).optional(),
    description: "Pointers to artifacts the responder may need",
    required: false,
  },
  parentTaskId: {
    schema: z.string().optional(),
    description: "Parent task ID (e.g. mt#123)",
    required: false,
  },
  parentSessionId: {
    schema: z.string().optional(),
    description: "Parent session UUID when the Ask originates in an active session",
    required: false,
  },
  deadline: {
    schema: z.string().optional(),
    description: "ISO-8601 soft deadline; when exceeded the Ask transitions to expired",
    required: false,
  },
  metadata: {
    schema: z.record(z.string(), z.unknown()).optional(),
    description: "Arbitrary metadata for transport adapters and future extensions",
    required: false,
  },
  classifierVersion: {
    schema: z.string(),
    description: "Classifier version (caller-provided; v1 is agent self-declaration)",
    required: false,
    defaultValue: "v1.0.0",
  },
  requestor: {
    schema: z.string().min(1),
    description: "AgentId of the requestor; defaults to a session-unknown marker",
    required: false,
  },
};

/**
 * Typed input for `createAsk` — the internal helper exposed for testing.
 *
 * Mirrors `CreateAskInput` plus the producer-specific defaults that
 * `asks.create` applies before calling `repo.create`.
 */
export interface CreateAskParams {
  kind: AskKind;
  title: string;
  question: string;
  options?: AskOption[];
  contextRefs?: ContextRef[];
  parentTaskId?: string;
  parentSessionId?: string;
  deadline?: string;
  metadata?: Record<string, unknown>;
  classifierVersion?: string;
  requestor?: string;
}

/**
 * Create an Ask via the repository and route it via mt#1069's policy-first
 * router. Returns the `RoutedAsk` (state="routed" or "closed").
 *
 * Persistence semantics: this function writes the initial Ask row in
 * "detected" state via `repo.create`. The router's state-transition output
 * (state="routed" for kind-based fallback, state="closed" for policy
 * coverage) is reflected in the returned `RoutedAsk` object but is **not**
 * persisted to the database in v1 — the row remains in "detected" until a
 * downstream transport adapter (mt#1070 subagent, mt#1457 elicitation,
 * mt#454 inbox, etc.) walks the state machine. This matches Tree A's
 * shipped semantics in mt#1069 / mt#1070 / `policy-resolver.ts`.
 *
 * Exposed (rather than inlined into the command's `execute` closure) so
 * tests can exercise the producer end-to-end with a `FakeAskRepository`.
 */
export async function createAsk(
  repo: AskRepository,
  params: CreateAskParams,
  routerOptions: PolicyFirstRouteOptions = {}
): Promise<RoutedAsk> {
  const input: CreateAskInput = {
    kind: params.kind,
    classifierVersion: params.classifierVersion ?? "v1.0.0",
    requestor: params.requestor ?? "minsky.agent:unknown",
    title: params.title,
    question: params.question,
    options: params.options,
    contextRefs: params.contextRefs,
    parentTaskId: params.parentTaskId,
    parentSessionId: params.parentSessionId,
    deadline: params.deadline,
    metadata: params.metadata,
  };

  const ask = await repo.create(input);
  return policyFirstRoute(ask, routerOptions);
}

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

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "asks.create",
      category: CommandCategory.TOOLS,
      name: "create",
      description: "Create an Ask and route it via the policy-first router (ADR-008)",
      requiresSetup: true,
      parameters: asksCreateParams,
      execute: async (params): Promise<RoutedAsk | ElicitationClosedAsk> => {
        const repo = await buildAskRepository(container);
        if (!repo) {
          throw new Error(
            "asks.create: AskRepository unavailable — persistence provider does not support SQL"
          );
        }

        // mt#1457: pull the capability registry from the container so the
        // router consults it and the elicitation transport can dispatch
        // through the active MCP Server. CLI execution gets the no-op fake
        // (registered in cli.ts); MCP execution gets MCPClientCapabilityRegistry
        // (overridden in start-command.ts).
        const capabilityRegistry =
          container?.has("clientCapabilityRegistry") &&
          (container.get("clientCapabilityRegistry") as ClientCapabilityRegistry);

        const routerOptions: PolicyFirstRouteOptions = capabilityRegistry
          ? { capabilityRegistry }
          : {};

        const routed = await createAsk(
          repo,
          {
            kind: params.kind as AskKind,
            title: params.title as string,
            question: params.question as string,
            options: params.options as AskOption[] | undefined,
            contextRefs: params.contextRefs as ContextRef[] | undefined,
            parentTaskId: params.parentTaskId as string | undefined,
            parentSessionId: params.parentSessionId as string | undefined,
            deadline: params.deadline as string | undefined,
            metadata: params.metadata as Record<string, unknown> | undefined,
            classifierVersion: params.classifierVersion as string | undefined,
            requestor: params.requestor as string | undefined,
          },
          routerOptions
        );

        // mt#1457: when the router decided elicitation, dispatch through the
        // active MCP Server. Other transports (subagent in mt#1070, inbox in
        // mt#454/mt#1458) are dispatched elsewhere; asks.create only owns
        // the elicitation path because that's the synchronous one whose
        // result we can return inline. Async transports leave routed.state
        // = "routed" and the caller polls / receives notification later.
        if (routed.transport.kind === "elicitation" && capabilityRegistry) {
          const server = capabilityRegistry.activeElicitationServer();
          if (server) {
            return await dispatchToElicitation(routed, { server, repo });
          }
          // Defensive: capability registry said hasElicitation() but no
          // server is currently active. Fall through and return the routed
          // Ask as-is; the operator CLI (mt#1458) is the recovery path.
          log.warn(
            "asks.create: routed to elicitation but no active server — returning routed Ask",
            { askId: routed.id }
          );
        }

        return routed;
      },
    })
  );
}
