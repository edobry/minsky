/**
 * Ask router — ADR-008 §Router.
 *
 * Three-phase decision:
 *   Phase 1: policy consultation — if an existing policy covers the Ask,
 *            short-circuit to closed with responder="policy".
 *   Phase 2: for uncovered asks, pick routingTarget and transport by kind
 *            per the ADR-008 transport-binding matrix.
 *   Phase 3: service-window selector (mt#1490) — evaluate serviceStrategy:
 *            - asap / no strategy: dispatch immediately (existing behavior)
 *            - forceImmediate=true: bypass windowing, dispatch immediately
 *            - scheduled: suspend with windowKey; reaper dispatches on window-open
 *            - deadline-bound: if deadline is within PAGE_THRESHOLD, dispatch
 *              immediately; else suspend
 *
 * This module does NOT dispatch to non-policy transports. Inbox, AG-UI,
 * mesh, and subagent dispatch are separate child tasks (mt#1070, mt#454,
 * mt#700, mt#1001). The router produces a RoutedAsk or SuspendedAsk;
 * transport adapters consume it.
 *
 * Reference: docs/architecture/adr-008-attention-allocation-subsystem.md §Router
 */

import { log } from "@minsky/shared/logger";
import type { Ask, AgentId, TransportKind, AskKind } from "./types";
import { assertNever } from "./types";
import { loadAllPolicySources, isCovered } from "./policy";
import type { PolicyCitation } from "./policy";
import { closeWithPolicy } from "./transports/policy-resolver";
import type { ClientCapabilityRegistry } from "../client-capabilities";
import type { SystemEventInput } from "../storage/schemas/system-events-schema";

// ---------------------------------------------------------------------------
// Service-window: page threshold constant
// ---------------------------------------------------------------------------

/**
 * Page threshold in milliseconds for deadline-bound Asks.
 *
 * When a deadline-bound Ask has a deadline within this window, the router
 * dispatches immediately rather than suspending. Default: 15 minutes.
 */
export const PAGE_THRESHOLD_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Transport binding
// ---------------------------------------------------------------------------

/**
 * A transport binding produced by the router for a single Ask.
 *
 * The `kind` field identifies which transport adapter should carry this Ask.
 * `target` is an optional secondary discriminator (e.g., the specific peer
 * for mesh notifications; not used in v1).
 */
export interface TransportBinding {
  /** Which transport carries this Ask. */
  kind: TransportKind;
  /** Optional secondary target identifier (future use). */
  target?: string;
}

// ---------------------------------------------------------------------------
// AskPayload
// ---------------------------------------------------------------------------

/**
 * The packaged payload for a routed Ask.
 *
 * v1: thin wrapper around the Ask's own question/options/contextRefs.
 * Future: kind-specific discriminated unions with deadline, fallback, etc.
 */
export interface AskPayload {
  /** Forwarded from the original Ask. */
  question: string;
  /** Forwarded from the original Ask (present for decision-like kinds). */
  options?: Ask["options"];
  /** Forwarded from the original Ask. */
  contextRefs?: Ask["contextRefs"];
  /**
   * Policy citation — only present when transport.kind = "policy".
   * The citation identifies which policy statement covered this Ask.
   */
  citation?: PolicyCitation;
}

// ---------------------------------------------------------------------------
// RoutedAsk
// ---------------------------------------------------------------------------

/**
 * An Ask after the router has run and dispatched to a transport.
 *
 * `state` is either "routed" (dispatching to a transport) or "closed"
 * (policy covered it; no further dispatch needed).
 *
 * `routingTarget` is required on RoutedAsk — the router must always
 * produce a definitive target.
 */
export interface RoutedAsk extends Ask {
  state: "routed" | "closed";
  routingTarget: AgentId | "operator" | "policy";
  transport: TransportBinding;
  packagedPayload: AskPayload;
}

/**
 * An Ask that the router has suspended pending a service window.
 *
 * Produced by Phase 3 (window selector) when `serviceStrategy` is `"scheduled"`
 * or `"deadline-bound"` (with deadline beyond page-threshold).
 *
 * The `routingTarget` and `transport` are still resolved by Phase 2, so the
 * reaper knows where to dispatch when the window opens. This satisfies ADR Q2:
 * future channel work (mt#1409) can flip transport without touching window logic.
 */
export interface SuspendedAsk extends Ask {
  state: "suspended";
  routingTarget: AgentId | "operator" | "policy";
  transport: TransportBinding;
  packagedPayload: AskPayload;
  /** The window key this Ask is waiting for (undefined for deadline-bound). */
  suspendedForWindowKey?: string;
}

/**
 * Union of router output types. A router call may produce:
 * - RoutedAsk (state "routed" or "closed") — immediate dispatch
 * - SuspendedAsk (state "suspended") — deferred pending a service window
 */
export type RouterResult = RoutedAsk | SuspendedAsk;

// ---------------------------------------------------------------------------
// Router interface
// ---------------------------------------------------------------------------

export interface AskRouter {
  route(ask: Ask): Promise<RouterResult>;
}

// ---------------------------------------------------------------------------
// Transport-binding matrix (ADR-008 §Transport-binding matrix)
// ---------------------------------------------------------------------------

/**
 * Returns true for ask kinds whose UX benefits from a synchronous-dialog
 * transport (elicitation) when the active MCP client supports it.
 *
 * Lifted from the sync/async axis documented in `src/domain/ask/types.ts`
 * AskKind table. v1 wires only `direction.decide` — operator-driven
 * preference-bound choices are the canonical synchronous-dialog case.
 *
 * Future extensions (mt#1457 spec §Notes): `authorization.approve` is a
 * candidate (sync seconds–hours) when policy doesn't pre-cover; same for
 * `information.retrieve` if no retriever is wired. v1 leaves both async
 * to avoid premature surface area; the static binding matrix below still
 * routes them appropriately.
 *
 * The exhaustive switch + `assertNever` enforces that adding a new
 * `AskKind` requires this function be updated — drift is a compile error,
 * not a silent miss.
 */
function isSyncKind(kind: AskKind): boolean {
  switch (kind) {
    case "direction.decide":
      return true;
    case "capability.escalate":
    case "information.retrieve":
    case "authorization.approve":
    case "coordination.notify":
    case "quality.review":
    case "stuck.unblock":
      return false;
    default:
      return assertNever(kind);
  }
}

/**
 * Pick the primary transport for an uncovered Ask by kind.
 *
 * Two-stage decision:
 *   1. **Capability-aware preference (mt#1457):** for sync ask kinds (per
 *      `isSyncKind`), if the active MCP client advertises elicitation, route
 *      to the elicitation transport. This is what makes Shape B distinct
 *      from a kind-only router — the existence of an elicitation-capable
 *      host shapes routing.
 *   2. **Static kind→transport binding (ADR-008 matrix):** the v1 defaults
 *      from the ADR-008 transport-binding matrix. This is the fallback
 *      when no elicitation-capable host is connected, and the only path
 *      for async kinds.
 *
 * Kinds and their v1 static defaults:
 *   capability.escalate  → subagent
 *   information.retrieve → retriever (v1: no operator fallback inline)
 *   authorization.approve → inbox (async default; AG-UI is secondary)
 *   direction.decide     → inbox  (or elicitation when capable — see stage 1)
 *   coordination.notify  → mesh
 *   quality.review       → inbox
 *   stuck.unblock        → subagent
 */
function pickTransport(
  kind: AskKind,
  capabilityRegistry?: ClientCapabilityRegistry
): {
  routingTarget: AgentId | "operator" | "policy";
  transport: TransportBinding;
} {
  // Stage 1: capability-aware preference.
  if (isSyncKind(kind) && capabilityRegistry?.hasElicitation()) {
    return {
      routingTarget: "operator",
      transport: { kind: "elicitation" },
    };
  }

  // Stage 2: static kind→transport binding (ADR-008 matrix).
  switch (kind) {
    case "capability.escalate":
      return {
        routingTarget: "subagent",
        transport: { kind: "subagent" },
      };

    case "information.retrieve":
      // Route to retriever transport. Operator escalation if uncaptured
      // is a future extension (no inbox fallback inline at v1).
      return {
        routingTarget: "retriever",
        transport: { kind: "retriever" },
      };

    case "authorization.approve":
      // Policy-resolver is Phase 1 (handled before we reach pickTransport).
      // Uncovered: async inbox as v1 default; AG-UI interrupt is secondary.
      return {
        routingTarget: "operator",
        transport: { kind: "inbox" },
      };

    case "direction.decide":
      return {
        routingTarget: "operator",
        transport: { kind: "inbox" },
      };

    case "coordination.notify":
      return {
        routingTarget: "peer",
        transport: { kind: "mesh" },
      };

    case "quality.review":
      // Reviewer subagent first; operator inbox for taste pass.
      // v1 default: inbox (covers both paths).
      return {
        routingTarget: "reviewer",
        transport: { kind: "inbox" },
      };

    case "stuck.unblock":
      return {
        routingTarget: "subagent",
        transport: { kind: "subagent" },
      };

    default:
      return assertNever(kind);
  }
}

// ---------------------------------------------------------------------------
// packagePayload helper
// ---------------------------------------------------------------------------

/**
 * Build the packaged payload for a non-policy routed Ask.
 *
 * v1: forward question, options, and contextRefs from the original Ask.
 * Future: kind-specific payload builders with deadline, fallback, etc.
 */
function packagePayload(ask: Ask): AskPayload {
  return {
    question: ask.question,
    options: ask.options,
    contextRefs: ask.contextRefs,
  };
}

// ---------------------------------------------------------------------------
// policyFirstRoute — concrete router implementation
// ---------------------------------------------------------------------------

/**
 * Options for `policyFirstRoute`.
 */
export interface PolicyFirstRouteOptions {
  /**
   * Workspace root for loading policy sources (CLAUDE.md, project rules).
   * Defaults to `process.cwd()` when not provided.
   */
  workspaceRoot?: string;

  /**
   * Task spec text for policy coverage.
   * Pass `null` to skip task-spec consultation.
   */
  specContent?: string | null;

  /**
   * MCP client capability registry. When provided and `hasElicitation()`
   * returns true, sync ask kinds route to the `elicitation` transport in
   * Phase 2 instead of the static kind→transport binding. Absent or no-op
   * registry → Phase 2 falls back to the static binding (mt#1069 behavior).
   *
   * Wired in mt#1457; consumed by sibling tasks like the `asks.create` MCP
   * tool wrapper to thread the active connection's capabilities into routing.
   */
  capabilityRegistry?: ClientCapabilityRegistry;

  /**
   * Current time override for deadline calculations (Phase 3 window selector).
   *
   * Injected in tests to simulate specific deadline conditions without
   * sleeping or manipulating the system clock.
   * Defaults to `Date.now()` when not provided.
   */
  nowMs?: number;
}

/**
 * A router that consults policy first, then routes by kind, then evaluates
 * the service-window selector.
 *
 * Phase 1: Load all policy sources and check coverage via `isCovered`.
 *   - If covered: return a closed RoutedAsk with responder="policy" and citation.
 *   - Log if the Ask's self-declared kind disagrees with the policy response
 *     (classifier-vs-policy disagreement audit).
 *
 * Phase 2: For uncovered asks, pick routingTarget and transport via the
 *   transport-binding matrix.
 *
 * Phase 3: Service-window selector (mt#1490).
 *   - forceImmediate=true → bypass, return RoutedAsk immediately.
 *   - asap (or no strategy) → return RoutedAsk immediately (unchanged behavior).
 *   - scheduled → return SuspendedAsk; reaper dispatches on window-open.
 *   - deadline-bound → if deadline ≤ PAGE_THRESHOLD_MS from now, return
 *     RoutedAsk immediately; else return SuspendedAsk.
 */
export async function policyFirstRoute(
  ask: Ask,
  options: PolicyFirstRouteOptions = {}
): Promise<RouterResult> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const specContent = options.specContent ?? null;

  // -----------------------------------------------------------------------
  // Phase 1: policy consultation
  // -----------------------------------------------------------------------

  const sources = await loadAllPolicySources(workspaceRoot, specContent);
  const coverage = isCovered(ask, sources);

  if (coverage.covered && coverage.citation) {
    // Policy covers this Ask — short-circuit to closed.
    const closed = closeWithPolicy(ask, coverage.citation);

    // Classifier-vs-policy audit: if the Ask wasn't already targeted at
    // "policy", log the disagreement. This is observational at v1 — no
    // enforcement, just audit trail.
    if (ask.routingTarget !== "policy") {
      log.debug("ask.router: classifier-policy disagreement", {
        askId: ask.id,
        kind: ask.kind,
        classifierTarget: ask.routingTarget ?? "(unset)",
        resolvedBy: "policy",
        citationSource: coverage.citation.source,
      });
    }

    return closed;
  }

  // -----------------------------------------------------------------------
  // Phase 2: route by kind (capability-aware via mt#1457)
  // -----------------------------------------------------------------------

  const { routingTarget, transport } = pickTransport(ask.kind, options.capabilityRegistry);
  const packagedPayload = packagePayload(ask);

  const nowTs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowTs).toISOString();

  // -----------------------------------------------------------------------
  // Phase 3: service-window selector (mt#1490)
  // -----------------------------------------------------------------------

  // forceImmediate short-circuits all window logic.
  const strategy = ask.serviceStrategy ?? "asap";

  if (!ask.forceImmediate && strategy !== "asap") {
    if (strategy === "scheduled") {
      // Suspend until the named window opens. The reaper will dispatch on
      // `minsky.attention_window_opened` for `ask.windowKey`.
      const suspended: SuspendedAsk = {
        ...ask,
        state: "suspended",
        routingTarget,
        transport,
        packagedPayload,
        routedAt: nowIso,
        suspendedAt: nowIso,
        suspendedForWindowKey: ask.windowKey,
      };

      log.debug("ask.router: suspending scheduled Ask", {
        askId: ask.id,
        kind: ask.kind,
        windowKey: ask.windowKey,
      });

      return suspended;
    }

    if (strategy === "deadline-bound") {
      // Dispatch immediately if deadline is within page-threshold; else suspend.
      const deadline = ask.deadline ? new Date(ask.deadline).getTime() : null;
      const withinThreshold = deadline !== null && deadline - nowTs <= PAGE_THRESHOLD_MS;

      if (!withinThreshold) {
        // Suspend — reaper will check periodically and dispatch when close.
        const suspended: SuspendedAsk = {
          ...ask,
          state: "suspended",
          routingTarget,
          transport,
          packagedPayload,
          routedAt: nowIso,
          suspendedAt: nowIso,
          suspendedForWindowKey: undefined, // deadline-bound has no specific window
        };

        log.debug("ask.router: suspending deadline-bound Ask (beyond threshold)", {
          askId: ask.id,
          kind: ask.kind,
          deadline: ask.deadline,
        });

        return suspended;
      }

      // Within threshold — fall through to immediate dispatch.
      log.debug("ask.router: dispatching deadline-bound Ask (within threshold)", {
        askId: ask.id,
        kind: ask.kind,
        deadline: ask.deadline,
      });
    }
  } else if (ask.forceImmediate && strategy !== "asap") {
    log.debug("ask.router: forceImmediate bypassing window selector", {
      askId: ask.id,
      kind: ask.kind,
      strategy,
    });
  }

  const routed: RoutedAsk = {
    ...ask,
    state: "routed",
    routingTarget,
    transport,
    packagedPayload,
    routedAt: nowIso,
  };

  return routed;
}

// ---------------------------------------------------------------------------
// Factory: build a router from options
// ---------------------------------------------------------------------------

/**
 * Create an `AskRouter` backed by `policyFirstRoute`.
 *
 * Use this factory when you need the router behind the `AskRouter` interface
 * (e.g., for dependency injection). For direct usage, call `policyFirstRoute`
 * directly.
 */
export function createPolicyFirstRouter(options: PolicyFirstRouteOptions = {}): AskRouter {
  return {
    route: (ask: Ask) => policyFirstRoute(ask, options),
  };
}

// ---------------------------------------------------------------------------
// Type guard helpers for RouterResult discrimination
// ---------------------------------------------------------------------------

/** Returns true when a RouterResult is a SuspendedAsk (window-deferred). */
export function isSuspendedAsk(result: RouterResult): result is SuspendedAsk {
  return result.state === "suspended";
}

/** Returns true when a RouterResult is a RoutedAsk (immediate dispatch or policy-closed). */
export function isRoutedAsk(result: RouterResult): result is RoutedAsk {
  return result.state === "routed" || result.state === "closed";
}

// ---------------------------------------------------------------------------
// Policy-closure audit event (mt#2666 SC4)
// ---------------------------------------------------------------------------

/**
 * Build the `ask.policy_closed` audit event for a phase-1 policy closure.
 *
 * A policy-closed Ask never reaches any queue, so without a persisted event
 * the closure is visible only in the closed row itself — indistinguishable
 * from "missing" to an operator scanning open asks (the c26eca0a incident:
 * a disposition Ask silently closed at creation with an irrelevant
 * citation). The `asks.create` command layer persists this event alongside
 * `ask.created`; closures become reviewable via `events_list`.
 *
 * Returns `null` when the result is not a policy closure.
 */
export function buildPolicyClosedEvent(
  // Structural parameter: accepts any Ask-derived route outcome (RouterResult
  // members AND ElicitationClosedAsk, whose state union includes "cancelled")
  // — the discrimination below is what matters.
  result: Ask & { routingTarget: AgentId | "operator" | "policy" }
): SystemEventInput | null {
  if (result.state !== "closed" || result.routingTarget !== "policy") return null;
  const citation =
    result.response?.responder === "policy"
      ? (result.response.payload as { citation?: PolicyCitation }).citation
      : undefined;
  return {
    eventType: "ask.policy_closed",
    payload: {
      askId: result.id,
      kind: result.kind,
      title: result.title,
      citationSource: citation?.source ?? "unknown",
      ...(citation?.lineRange ? { citationLines: citation.lineRange } : {}),
    },
    actor: result.requestor,
    relatedTaskId: result.parentTaskId,
    relatedSessionId: result.parentSessionId,
  };
}
