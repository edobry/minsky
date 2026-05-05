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
 * - `asks.respond` — operator-facing response surface. Walks a suspended
 *   Ask through `responded → closed` with the operator's message as the
 *   response payload. Wired as mt#1458 (per mt#454 slim research: v1 verb
 *   set is `list` + `respond` only).
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { ValidationError } from "../../../errors/index";
import { log } from "../../../utils/logger";
import {
  DrizzleAskRepository,
  type AskRepository,
  type CreateAskInput,
} from "../../../domain/ask/repository";
import { ConcurrentTransitionError } from "../../../domain/ask/repository";
import type { Ask, AskKind, AskState, AskOption, ContextRef } from "../../../domain/ask/types";
import { reconcile, type ReconcileResult } from "../../../domain/ask/reconciler";
import {
  policyFirstRoute,
  type RoutedAsk,
  type SuspendedAsk,
  type PolicyFirstRouteOptions,
  isSuspendedAsk,
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
import { getServiceWindowDefault } from "../../../domain/ask/service-window-defaults";

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
export async function buildAskRepository(
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
// asks.respond — schemas + helper (mt#1458)
// ---------------------------------------------------------------------------

const asksRespondParams = {
  id: {
    schema: z.string().trim().min(1),
    description: "Ask ID (UUID) to respond to",
    required: true,
  },
  message: {
    schema: z.string().trim().min(1),
    description: "Operator response message — becomes response.payload.message",
    required: true,
  },
  responder: {
    schema: z.string().trim().min(1),
    description: "AgentId or 'operator' identifier; defaults to 'operator'",
    required: false,
    defaultValue: "operator",
  },
};

/**
 * Typed input for `respondToAsk` — the internal helper exposed for testing.
 */
export interface RespondToAskParams {
  id: string;
  message: string;
  responder?: string;
}

/**
 * Result shape returned by `respondToAsk`. Always reflects the closed Ask
 * (post `responded → closed` walk) so callers see the final state, not the
 * intermediate `responded`.
 */
export type RespondToAskResult = {
  ask: Ask;
};

/**
 * Validate inputs to `respondToAsk`. Mirrors the zod schema on the
 * `asks.respond` shared command. The schema applies trim() at the surface;
 * this helper applies the same enforcement so direct programmatic callers
 * see the same validation behavior.
 */
function validateRespondParams(params: RespondToAskParams): void {
  if (!params.id || params.id.trim() === "") {
    throw new Error("asks.respond: id is required and must not be empty");
  }
  if (!params.message || params.message.trim() === "") {
    throw new Error("asks.respond: message is required and must not be empty");
  }
  if (params.responder !== undefined && params.responder.trim() === "") {
    throw new Error("asks.respond: responder, if provided, must not be empty");
  }
}

/**
 * Respond to a suspended Ask via the operator surface.
 *
 * Walks the persisted Ask atomically from `"suspended"` to `"closed"` via
 * `repo.respondAndClose`, recording the operator's message as the response
 * payload and `attentionCost` on the closed row (per the `Ask.response`
 * contract in `types.ts` — "`attentionCost` is filled on close").
 *
 * Atomicity (concurrency safety): the underlying `respondAndClose` uses
 * optimistic-concurrency in the Drizzle backend (`WHERE state = 'suspended'`),
 * so a concurrent cancel/expire/close between read and write surfaces a
 * `ConcurrentTransitionError` rather than leaving the Ask stuck in a
 * partially-updated state. The Fake backend mirrors the same precondition.
 *
 * Pre-conditions (validated up front; throw clear errors on violation):
 *   - `params.id` is a non-empty string.
 *   - `params.message` is a non-empty (post-trim) string.
 *   - Ask exists (`repo.getById` returns non-null).
 *   - Ask is in `"suspended"` state. Earlier states (detected/classified/routed)
 *     mean no transport has dispatched yet; terminal states
 *     (closed/cancelled/expired) cannot be responded to.
 *
 * Note: at v1, `routingTarget === "operator"` is NOT enforced. The router
 * (`policyFirstRoute`) does not persist `routingTarget`, so the persisted
 * row keeps `routingTarget = undefined`. By elimination at v1, every Ask
 * that legitimately reaches `"suspended"` is operator-bound. When a non-
 * operator transport starts using `"suspended"`, re-introduce a gate here.
 *
 * Per mt#454 slim research output (Q3): v1 verb set is `list` + `respond`
 * only. `claim` / `release` / `close` / `reopen` are deferred to mt#454-impl.
 */
export async function respondToAsk(
  repo: AskRepository,
  params: RespondToAskParams
): Promise<RespondToAskResult> {
  validateRespondParams(params);

  const persisted = await repo.getById(params.id);
  if (!persisted) {
    throw new Error(`asks.respond: Ask not found: ${params.id}`);
  }

  if (persisted.state !== "suspended") {
    throw new Error(
      `asks.respond: Ask is in "${persisted.state}" state — only "suspended" Asks can be responded to. ` +
        `(detected/classified/routed: no transport has dispatched yet; ` +
        `closed/cancelled/expired: terminal.)`
    );
  }

  // Trim before constructing the payload so direct programmatic callers
  // see the same normalized message that CLI/MCP callers do (the schema
  // applies trim() at the surface).
  const message = params.message.trim();
  const responder = params.responder?.trim() || "operator";

  // Two-stage response payload, matching the Ask.response contract in
  // types.ts: `attentionCost` is filled on close only. The respond stage
  // gets responder + payload; the close stage adds attentionCost.
  const respondPayload = {
    responder,
    payload: { message },
  };
  const closePayload = {
    responder,
    payload: { message },
    attentionCost: {
      // The operator responded via the inbox/CLI surface. The original
      // transport is preserved on the Ask record; the attentionCost.transport
      // here records the surface that *resolved* it.
      transport: "inbox" as const,
      resolvedIn: "inbox" as const,
      // operatorCost is intentionally absent at v1 — deferred to mt#454-impl
      // along with claim/release semantics.
    },
  };

  // Atomic walk suspended → closed via the repository's combined operation.
  // Catch ConcurrentTransitionError and re-throw with the same friendly
  // not-suspended message the pre-check uses, so callers see ONE error shape
  // for "Ask is not in suspended state" regardless of cause.
  try {
    const closed = await repo.respondAndClose(
      params.id,
      { response: respondPayload },
      { response: closePayload }
    );
    return { ask: closed };
  } catch (err) {
    if (err instanceof ConcurrentTransitionError) {
      throw new Error(
        `asks.respond: Ask is in "${err.observedState}" state — only "suspended" Asks can be responded to. ` +
          `(Concurrent actor transitioned the Ask between read and write.)`
      );
    }
    throw err;
  }
}

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
  // Service-window fields (mt#1411 spine — mt#1488)
  serviceStrategy: {
    schema: z.enum(["asap", "scheduled", "deadline-bound"] as const).optional(),
    description:
      "Routing strategy: 'asap' (default) | 'scheduled' | 'deadline-bound'. " +
      "When absent, per-kind defaults apply.",
    required: false,
  },
  windowKey: {
    schema: z.string().optional(),
    description:
      "Named service window (e.g. 'ask-hours'). Only used when serviceStrategy='scheduled'.",
    required: false,
  },
  forceImmediate: {
    schema: z.boolean().optional(),
    description:
      "When true, bypass the window check and route immediately. " +
      "Use only for critical-path unblocking.",
    required: false,
  },
  // NOTE: `windowMissedCount` is intentionally omitted from this MCP parameter schema.
  // It is reaper-owned state (mt#1490): the reaper increments it each time a scheduled
  // window opens and the Ask is still pending. Callers must not set it directly via
  // asks.create — createAsk always initialises it to 0 for new Asks.
};

/**
 * Cross-field coherence validation for `asks.create` MCP params.
 *
 * `windowKey` is only meaningful when `serviceStrategy='scheduled'`. Passing it
 * alongside an *explicitly* non-scheduled strategy is a caller error that should
 * be caught at the parameter boundary — not silently ignored later.
 *
 * When `serviceStrategy` is *absent*, the validation passes. Per-kind defaults in
 * `createAsk` resolve the strategy (e.g., `direction.decide` → `scheduled`), so a
 * caller may legitimately omit `serviceStrategy` and supply a custom `windowKey` —
 * the kind's default resolves to `scheduled`, and the caller's `windowKey` overrides
 * the default window name.
 *
 * Only when `serviceStrategy` is *explicitly* set to a non-scheduled value does a
 * `windowKey` become incoherent: the caller has explicitly chosen a strategy that
 * doesn't use windows, yet is also specifying a window.
 *
 * Exported for direct testing without requiring the full command factory setup.
 * The `asks.create` command's `validate` hook delegates to this function.
 *
 * @throws {ValidationError} when `windowKey` is set AND `serviceStrategy` is explicitly non-scheduled
 */
export function validateAsksCreateParams(params: {
  windowKey?: string;
  serviceStrategy?: "asap" | "scheduled" | "deadline-bound";
}): void {
  if (
    params.windowKey !== undefined &&
    params.serviceStrategy !== undefined &&
    params.serviceStrategy !== "scheduled"
  ) {
    throw new ValidationError(
      `windowKey is only valid when serviceStrategy='scheduled'. You explicitly set serviceStrategy='${params.serviceStrategy}' but also provided windowKey. ` +
        "Either drop windowKey, set serviceStrategy='scheduled', or omit serviceStrategy to use the kind's default."
    );
  }
}

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
  /** Service-window routing strategy (mt#1411 spine — mt#1488). When absent, per-kind default applies. */
  serviceStrategy?: "asap" | "scheduled" | "deadline-bound";
  /** Named window to target when strategy is "scheduled". When absent, per-kind default applies. */
  windowKey?: string;
  /** Bypass window check and route immediately (default false). */
  forceImmediate?: boolean;
}

/**
 * Walk a persisted Ask forward to `"suspended"` from any pre-suspended state.
 *
 * Used by the strand-recovery path in `createAsk` when the router decided
 * elicitation but no active MCP server is reachable. Mirrors the helper in
 * the elicitation transport but lives here to avoid an import cycle (the
 * transport imports from `router.ts`, which is upstream of this file).
 *
 * Throws on terminal/post-suspended states — re-suspending a closed Ask is
 * a programming error.
 */
async function advanceRoutedAskToSuspended(repo: AskRepository, askId: string): Promise<void> {
  const persisted = await repo.getById(askId);
  if (!persisted) {
    throw new Error(`asks.create: Ask not found: ${askId}`);
  }
  switch (persisted.state) {
    case "detected":
      await repo.transition(askId, "classified");
      await repo.transition(askId, "routed");
      await repo.transition(askId, "suspended");
      return;
    case "classified":
      await repo.transition(askId, "routed");
      await repo.transition(askId, "suspended");
      return;
    case "routed":
      await repo.transition(askId, "suspended");
      return;
    case "suspended":
      return;
    case "responded":
    case "closed":
    case "cancelled":
    case "expired":
      throw new Error(
        `asks.create: cannot strand-suspend Ask in terminal state "${persisted.state}"`
      );
    default:
      throw new Error(`asks.create: unhandled Ask state "${persisted.state}"`);
  }
}

/**
 * Create an Ask, route it via mt#1069's policy-first router, and — for the
 * elicitation transport — dispatch synchronously through the active MCP
 * server.
 *
 * This is the canonical Ask producer surface. Direct callers (tests,
 * future programmatic Ask emission sites like the 2-strikes detector
 * mt#1241) get the same result shape as the `asks.create` MCP tool: a
 * single coherent producer path regardless of entrypoint (PR #919 R3).
 *
 * Return shape (`RoutedAsk | SuspendedAsk | ElicitationClosedAsk`):
 *   - Policy coverage  → `state: "closed"` (RoutedAsk shape, transport=policy)
 *   - Async transport  → `state: "routed"` (RoutedAsk shape, transport=inbox/mesh/subagent/retriever)
 *   - Window-deferred  → `state: "suspended"` (SuspendedAsk, pending window open via reaper)
 *   - Elicitation accept → `state: "closed"` (ElicitationClosedAsk, response populated)
 *   - Elicitation decline/cancel → `state: "cancelled"` (ElicitationClosedAsk, no response)
 *   - Elicitation dispatch error → `state: "suspended"` (ElicitationClosedAsk, no response)
 *   - Elicitation routed but no active server → `state: "suspended"` (ElicitationClosedAsk, no response)
 *
 * Persistence semantics:
 *   - Creates the Ask row in "detected" state.
 *   - For async transports: row stays at "detected"; downstream transport
 *     adapter (mt#1070 subagent, mt#454 inbox, etc.) walks the state
 *     machine. This matches Tree A's existing semantics in mt#1069/mt#1070.
 *   - For window-deferred asks: row is immediately walked to "suspended" via
 *     `advanceRoutedAskToSuspended`. The reaper (mt#1490) wakes it when the
 *     window opens by transitioning to "routed" and dispatching.
 *   - For elicitation: walks the state machine end-to-end. The repo state
 *     after this call always matches the returned object's state.
 *   - Per `Ask.response`'s contract in `types.ts`, `response` is only
 *     populated for `"responded"` / `"closed"` states. The cancelled/
 *     suspended return values intentionally omit it.
 */
export async function createAsk(
  repo: AskRepository,
  params: CreateAskParams,
  routerOptions: PolicyFirstRouteOptions = {}
): Promise<RoutedAsk | SuspendedAsk | ElicitationClosedAsk> {
  // Apply per-kind service-window defaults when the requestor has not supplied
  // explicit values. Explicit params always win over defaults (mt#1488 SC4).
  const kindDefaults = getServiceWindowDefault(params.kind);
  const resolvedStrategy = params.serviceStrategy ?? kindDefaults.serviceStrategy;
  // windowKey: only meaningful when strategy is "scheduled". If the requestor
  // supplies a windowKey with a non-scheduled strategy (e.g. "asap"), it is
  // ignored — persisting it would contradict documented semantics in types.ts
  // ("Only meaningful when serviceStrategy is 'scheduled'").
  const resolvedWindowKey =
    resolvedStrategy === "scheduled" ? (params.windowKey ?? kindDefaults.windowKey) : undefined;

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
    // Service-window fields (mt#1411 spine — mt#1488)
    serviceStrategy: resolvedStrategy,
    windowKey: resolvedWindowKey,
    // windowMissedCount starts at 0 for all new Asks. The reaper (mt#1490)
    // increments this field as scheduled windows are missed. Callers must not
    // set this directly — it is reaper-owned state.
    windowMissedCount: 0,
    // forceImmediate is persisted here to record the caller's intent at creation time.
    // The router (mt#1490) observes this field to bypass the window check and route
    // immediately. createAsk does not act on it directly — that logic lives in the router.
    forceImmediate: params.forceImmediate ?? false,
  };

  const ask = await repo.create(input);
  const routed = await policyFirstRoute(ask, routerOptions);

  // Window-deferred path: Ask is suspended pending a service window.
  // Walk the DB row to "suspended" immediately so the persisted state
  // matches the router decision. The reaper (mt#1490) transitions it
  // to "routed" and dispatches when the window opens.
  if (isSuspendedAsk(routed)) {
    await advanceRoutedAskToSuspended(repo, ask.id);
    // Persist the routing target the router resolved in Phase 3 so the
    // Ask the reaper reloads at dispatch time carries the necessary
    // target. Without this, repo.getById returns routingTarget=undefined
    // and the dispatch callback can't decide where to deliver. R5 fix.
    if (routed.routingTarget !== undefined) {
      await repo.updateRoutingTarget(ask.id, routed.routingTarget);
    }
    return routed;
  }

  // Non-elicitation paths: return the routed Ask as-is. Async transports
  // (subagent, inbox, mesh, retriever) are dispatched elsewhere; policy
  // coverage already produced state="closed" via closeWithPolicy.
  if (routed.transport.kind !== "elicitation") {
    return routed;
  }

  // Elicitation path: dispatch synchronously when an active server is
  // available. The capabilityRegistry came from routerOptions (the same
  // path the router used to choose elicitation); reading it again here
  // keeps the dispatch decision colocated with the rest of the elicitation
  // logic.
  const registry = routerOptions.capabilityRegistry;
  const server = registry?.activeElicitationServer();
  if (server) {
    return await dispatchToElicitation(routed, { server, repo });
  }

  // Defensive: capability registry said hasElicitation() but no server is
  // currently active (race between hasElicitation() returning true and
  // activeElicitationServer() lookup — disconnect mid-call, etc.). Walk
  // the Ask to "suspended" so the operator CLI (mt#1458) can recover.
  log.warn(
    "createAsk: elicitation routed but no active server — walking to suspended for recovery",
    {
      askId: routed.id,
    }
  );
  await advanceRoutedAskToSuspended(repo, routed.id);
  const suspended: ElicitationClosedAsk = {
    ...routed,
    state: "suspended",
    routingTarget: "operator",
  };
  return suspended;
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
      id: "asks.respond",
      category: CommandCategory.TOOLS,
      name: "respond",
      description:
        "Respond to any suspended Ask (mt#1458, ADR-008). " +
        "v1 accepts ANY suspended Ask regardless of routingTarget — see mt#454-impl follow-up. " +
        "Pre-suspended (detected/classified/routed) and terminal " +
        "(closed/cancelled/expired) states are rejected with a clear error.",
      // requiresSetup: false — asks.respond depends only on the persistence
      // provider, not on global Minsky configuration. The execute() closure
      // surfaces a clear "AskRepository unavailable" error if persistence
      // is missing (graceful failure mode).
      requiresSetup: false,
      parameters: asksRespondParams,
      execute: async (params): Promise<RespondToAskResult> => {
        const repo = await buildAskRepository(container);
        if (!repo) {
          throw new Error(
            "asks.respond: AskRepository unavailable — persistence provider does not support SQL"
          );
        }

        return respondToAsk(repo, {
          id: params.id as string,
          message: params.message as string,
          responder: params.responder as string | undefined,
        });
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
      validate: async (params) => {
        // Cross-field coherence: windowKey is only meaningful when serviceStrategy='scheduled'.
        // Reject at the parameter boundary so callers get immediate, actionable feedback.
        validateAsksCreateParams(params);
      },
      execute: async (params): Promise<RoutedAsk | SuspendedAsk | ElicitationClosedAsk> => {
        const repo = await buildAskRepository(container);
        if (!repo) {
          throw new Error(
            "asks.create: AskRepository unavailable — persistence provider does not support SQL"
          );
        }

        // mt#1457: pull the capability registry from the container so the
        // router consults it and the elicitation transport can dispatch
        // through the active MCP Server.
        const capabilityRegistry =
          container?.has("clientCapabilityRegistry") &&
          (container.get("clientCapabilityRegistry") as ClientCapabilityRegistry);

        const routerOptions: PolicyFirstRouteOptions = capabilityRegistry
          ? { capabilityRegistry }
          : {};

        return await createAsk(
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
            // Service-window fields (mt#1411 spine — mt#1488)
            serviceStrategy: params.serviceStrategy as
              | "asap"
              | "scheduled"
              | "deadline-bound"
              | undefined,
            windowKey: params.windowKey as string | undefined,
            forceImmediate: params.forceImmediate as boolean | undefined,
          },
          routerOptions
        );
      },
    })
  );
}
